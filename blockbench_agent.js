/**
 * Blockbench Agent: AI chat panel for Blockbench (export, auto-rig, UV tools).
 * Install: File > Plugins > Load Plugin from File. Desktop app only.
 */
(function () {
  "use strict";

  const PLUGIN_ID = "blockbench_agent";

  // node modules
  const fs = typeof require === "function" ? require("fs") : null;
  const path = typeof require === "function" ? require("path") : null;
  const os = typeof require === "function" ? require("os") : null;
  const child_process =
    typeof require === "function" ? require("child_process") : null;

  // blender script, run with `blender -b script.py -- jobs.json`
  // single = one mesh, textures embedded; split = one object per material
  const TEXTURE_SCALE = 10; // nearest-neighbour upscale before export
  const BLENDER_SCRIPT = String.raw`
import bpy, sys, json, os, traceback
import numpy as np

# jobs: [{"src", "dst", "scale", "mode", "tex_scale"}, ...]
jobs = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))

def process(src, dst, scale, mode, tex_scale):
    # import the glb into an empty scene
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)

    # upscale textures (nearest) so pixel art stays sharp
    scaled_textures = []
    for img in bpy.data.images:
        w, h = img.size
        if tex_scale <= 1 or w == 0 or h == 0:
            continue
        px = np.empty(w * h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        big = np.repeat(np.repeat(px.reshape(h, w, 4), tex_scale, axis=0), tex_scale, axis=1)
        img.scale(w * tex_scale, h * tex_scale)
        img.pixels.foreach_set(big.ravel())
        img.file_format = "PNG"
        img.pack()
        scaled_textures.append({"name": img.name, "from": [w, h], "to": list(img.size)})

    # join all meshes
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if meshes:
        bpy.ops.object.select_all(action="DESELECT")
        for o in meshes:
            o.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        if len(meshes) > 1:
            bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        # drop the leftover empties/armature
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
        for o in [o for o in bpy.context.scene.objects if o != merged]:
            bpy.data.objects.remove(o, do_unlink=True)
        merged.name = merged.data.name = os.path.splitext(os.path.basename(dst))[0]

        # split by material
        if mode == "split" and len(merged.material_slots) > 1:
            bpy.ops.object.select_all(action="DESELECT")
            merged.select_set(True)
            bpy.context.view_layer.objects.active = merged
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.select_all(action="SELECT")
            bpy.ops.mesh.separate(type="MATERIAL")
            bpy.ops.object.mode_set(mode="OBJECT")
            for o in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
                if o.material_slots and o.material_slots[0].material:
                    o.name = o.data.name = o.material_slots[0].material.name

    # export fbx
    single = mode != "split"
    bpy.ops.export_scene.fbx(
        filepath=dst,
        use_selection=False,
        global_scale=scale,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_ALL",
        add_leaf_bones=False,
        path_mode="COPY" if single else "AUTO",
        embed_textures=single,
    )
    return {
        "fbx": dst,
        "exists": os.path.exists(dst),
        "mode": mode,
        "scaled_textures": scaled_textures,
        "scale": scale,
        "textures_copied_and_embedded": single,
        "mesh_objects": [o.name for o in bpy.context.scene.objects if o.type == "MESH"],
    }

results = []
for job in jobs:
    try:
        results.append(process(job["src"], job["dst"], float(job["scale"]), job["mode"], int(job["tex_scale"])))
    except Exception as e:
        # keep going if one model fails
        results.append({"fbx": job["dst"], "exists": False, "error": str(e), "trace": traceback.format_exc()[-800:]})
print("RESULT_JSON:" + json.dumps({"results": results}))
`;

  // settings
  const settings = [];
  function addSetting(id, data) {
    settings.push(
      new Setting(
        id,
        Object.assign({ category: "general", plugin: PLUGIN_ID }, data),
      ),
    );
  }
  // blockbench forgets plugin settings on reinstall, so keep a copy in localStorage
  const SETTING_IDS = [
    "bbagent_api_key",
    "bbagent_model",
    "bbagent_blender_path",
    "bbagent_output_dir",
  ];
  function getSetting(id) {
    const value = Settings.get(id);
    try {
      const key = "bbagent:" + id;
      if (typeof value === "string" && value.trim())
        localStorage.setItem(key, value);
      else {
        const saved = localStorage.getItem(key);
        if (saved) return saved;
      }
    } catch (e) {
      /* localStorage unavailable: use the plain setting */
    }
    return value;
  }
  function persistSettings() {
    SETTING_IDS.forEach(getSetting);
  }

  function registerSettings() {
    addSetting("bbagent_api_key", {
      name: "Agent: Anthropic API key",
      description:
        "Stored locally by Blockbench. Used for requests from this app to api.anthropic.com.",
      type: "password",
      value: "",
    });
    addSetting("bbagent_model", {
      name: "Agent: model",
      description: "Anthropic model ID. Empty = claude-sonnet-5-5.",
      type: "text",
      value: "",
    });
    addSetting("bbagent_blender_path", {
      name: "Agent: Blender executable",
      description:
        "Full path to blender.exe. Leave empty to auto-detect the newest install in the usual folders.",
      type: "text",
      value: "",
    });
    addSetting("bbagent_output_dir", {
      name: "Agent: output folder",
      description:
        "Where exports go. Empty = next to the saved .bbmodel (or the OS temp folder if unsaved).",
      type: "text",
      value: "",
    });
  }

  // tools: schema for the model + implementation
  function safeName(s) {
    return (
      String(s || "model")
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80) || "model"
    );
  }

  function getOutputDir() {
    let dir = String(getSetting("bbagent_output_dir") || "").trim();
    if (!dir) {
      if (Project && Project.save_path)
        dir = path.join(path.dirname(Project.save_path), "agent_exports");
      else dir = path.join(os.tmpdir(), "blockbench_agent");
    }
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const TOOL_DEFS = [
    {
      name: "get_project_info",
      description:
        "Read-only summary of the model currently open in Blockbench: name, format, saved path, element counts, textures, animations.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "export_gltf",
      description:
        "Export the open Blockbench model as a binary .glb file (textures embedded, animations included by default). Returns the file path.",
      input_schema: {
        type: "object",
        properties: {
          file_name: {
            type: "string",
            description:
              "Base file name without extension. Defaults to the project name.",
          },
          animations: {
            type: "boolean",
            description: "Include animations. Default true.",
          },
          scale: {
            type: "number",
            description:
              "Blockbench export scale. Omit to use the Blockbench setting (default 16 = 1 block is 1 unit).",
          },
        },
      },
    },
    {
      name: "run_blender_pipeline",
      description:
        "Run Blender in the background on a .glb/.gltf and export an .fbx. Modes: " +
        '"auto" (default) = picks "single" if the open Blockbench model has textures, otherwise "split"; ' +
        '"single" = join everything into ONE mesh, FBX exported with path mode COPY and embedded textures; ' +
        '"split" = join, then split into one object per material, FBX exported WITHOUT copying or embedding textures. ' +
        "Returns the FBX path and a summary.",
      input_schema: {
        type: "object",
        properties: {
          glb_path: {
            type: "string",
            description: "Path returned by export_gltf.",
          },
          mode: {
            type: "string",
            enum: ["auto", "single", "split"],
            description:
              "auto (default), single or split. See tool description.",
          },
          scale_factor: {
            type: "number",
            description:
              "Uniform scale applied on FBX export. Must come from the user.",
          },
          output_name: {
            type: "string",
            description:
              "FBX base name without extension. Defaults to the glb name.",
          },
        },
        required: ["glb_path", "scale_factor"],
      },
    },
  ];

  // find blender: setting first, then default install folders
  function resolveBlender() {
    const configured = String(getSetting("bbagent_blender_path") || "").trim();
    if (configured && configured !== "blender" && fs.existsSync(configured))
      return configured;

    const found = [];
    const scan = (root, exe) => {
      try {
        fs.readdirSync(root).forEach((d) => {
          const f = path.join(root, d, exe);
          if (/^Blender\b/i.test(d) && fs.existsSync(f)) found.push({ d, f });
        });
      } catch (e) {
        /* folder missing: ignore */
      }
    };
    // `process` isn't global in plugins
    const platform = os.platform();
    let env = {};
    try {
      env = require("process").env || {};
    } catch (e) {
      /* no env: fall back to default folders */
    }
    if (platform === "win32") {
      [env["ProgramFiles"], env["ProgramFiles(x86)"], "C:\\Program Files"]
        .filter(Boolean)
        .forEach((pf) => {
          scan(path.join(pf, "Blender Foundation"), "blender.exe");
        });
      [
        "C:\\Program Files (x86)\\Steam\\steamapps\\common",
        "C:\\Program Files\\Steam\\steamapps\\common",
      ].forEach((r) => scan(r, "blender.exe"));
    } else if (platform === "darwin") {
      if (fs.existsSync("/Applications/Blender.app/Contents/MacOS/Blender"))
        found.push({
          d: "Blender",
          f: "/Applications/Blender.app/Contents/MacOS/Blender",
        });
    }
    // newest version first
    const ver = (d) => (d.match(/[\d.]+/) || ["0"])[0].split(".").map(Number);
    found.sort((a, b) => {
      const A = ver(a.d),
        B = ver(b.d);
      for (let i = 0; i < 3; i++)
        if ((B[i] || 0) !== (A[i] || 0)) return (B[i] || 0) - (A[i] || 0);
      return 0;
    });
    return found.length ? found[0].f : configured || "blender";
  }

  const TOOL_IMPL = {
    async get_project_info() {
      const has = (name) => typeof globalThis[name] !== "undefined";
      return {
        name: Project ? Project.name : null,
        format: typeof Format !== "undefined" && Format ? Format.id : null,
        saved_path: Project && Project.save_path ? Project.save_path : null,
        cubes: has("Cube") ? Cube.all.length : 0,
        meshes: has("Mesh") ? Mesh.all.length : 0,
        groups: has("Group") ? Group.all.length : 0,
        textures: has("Texture")
          ? Texture.all.map((t) => ({
              name: t.name,
              width: t.width,
              height: t.height,
            }))
          : [],
        animations: has("Animation")
          ? Animation.all.map((a) => ({
              name: a.name,
              length: a.length,
              loop: a.loop,
            }))
          : [],
      };
    },

    async export_gltf(input) {
      return exportGlb(input);
    },

    async run_blender_pipeline(input) {
      const glb = String(input.glb_path || "");
      if (!/\.(glb|gltf)$/i.test(glb) || !fs.existsSync(glb)) {
        throw new Error(
          "glb_path does not exist or is not a .glb/.gltf file: " + glb,
        );
      }
      const scale = Number(input.scale_factor);
      if (!(scale > 0))
        throw new Error(
          "scale_factor is required and must be > 0. Ask the user for it.",
        );
      const { mode, mode_reason } = decideMode(input.mode);
      const fbx = path.join(
        path.dirname(glb),
        safeName(input.output_name || path.basename(glb, path.extname(glb))) +
          ".fbx",
      );
      const [result] = await runBlenderJobs([
        { src: glb, dst: fbx, scale, mode, tex_scale: TEXTURE_SCALE },
      ]);
      if (result.error)
        throw new Error(
          "Blender failed on this model: " +
            result.error +
            "\n" +
            (result.trace || ""),
        );
      return Object.assign(result, { mode_reason });
    },
  };

  // export active project as .glb
  async function exportGlb(input = {}) {
    const options = {
      encoding: "binary",
      embed_textures: true,
      animations: input.animations !== false,
    };
    if (typeof input.scale === "number") options.scale = input.scale;
    const content = await Codecs.gltf.compile(options);
    const file = path.join(
      getOutputDir(),
      safeName(input.file_name || (Project && Project.name)) + ".glb",
    );
    fs.writeFileSync(file, Buffer.from(content));
    return { glb_path: file, bytes: fs.statSync(file).size };
  }

  // textured -> single, untextured -> split
  function decideMode(requested) {
    if (requested === "single" || requested === "split")
      return { mode: requested, mode_reason: "requested" };
    const n = typeof Texture !== "undefined" ? Texture.all.length : 0;
    return n > 0
      ? { mode: "single", mode_reason: "auto: model has " + n + " texture(s)" }
      : { mode: "split", mode_reason: "auto: model has no textures" };
  }

  // one blender run for all jobs
  async function runBlenderJobs(jobs) {
    const workDir = path.join(os.tmpdir(), "blockbench_agent");
    fs.mkdirSync(workDir, { recursive: true });
    const scriptPath = path.join(workDir, "_agent_pipeline.py");
    const jobsPath = path.join(workDir, "_agent_jobs.json");
    fs.writeFileSync(scriptPath, BLENDER_SCRIPT);
    fs.writeFileSync(jobsPath, JSON.stringify(jobs));

    const blender = resolveBlender();
    const args = [
      "-b",
      "--factory-startup",
      "--python",
      scriptPath,
      "--",
      jobsPath,
    ];
    const timeoutMs = 120000 + 60000 * jobs.length;

    const { code, out } = await new Promise((resolve, reject) => {
      const proc = child_process.spawn(blender, args);
      let buf = "";
      const timer = setTimeout(() => {
        proc.kill();
        reject(
          new Error(
            "Blender timed out after " + Math.round(timeoutMs / 1000) + " s",
          ),
        );
      }, timeoutMs);
      proc.stdout.on("data", (d) => (buf += d));
      proc.stderr.on("data", (d) => (buf += d));
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(
          new Error(
            'Could not start Blender ("' + blender + '"): ' + e.message,
          ),
        );
      });
      proc.on("close", (c) => {
        clearTimeout(timer);
        resolve({ code: c, out: buf });
      });
    });

    const line = out.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
    if (code !== 0 || !line)
      throw new Error(
        "Blender failed (exit " + code + "). Last output:\n" + out.slice(-1500),
      );
    return JSON.parse(line.slice("RESULT_JSON:".length)).results;
  }

  // bulk export (open tabs or a folder, one blender run)
  let progressRow = null;
  function progress(text) {
    if (progressRow) progressRow.detail = text;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForTextures(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ready = Texture.all.every(
        (t) => t.error || (t.img && t.img.complete && t.img.naturalWidth > 0),
      );
      if (ready) return true;
      await sleep(100);
    }
    return false;
  }

  TOOL_DEFS.push({
    name: "bulk_export",
    description:
      'Export many models to FBX in one go: every open tab (source "open_tabs") or every .bbmodel file in a folder (source "folder"). ' +
      "Each model goes through the same pipeline as a single export (GLB, then Blender: 10x texture upscale, join, single/split mode, FBX), and Blender is started only once. " +
      'Mode "auto" decides per model from its textures. Folder files that were not already open are opened, exported and closed again without saving. ' +
      "FBX files go to each model's agent_exports folder (or the output folder setting). Returns one line per model.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["open_tabs", "folder"] },
        folder: {
          type: "string",
          description: 'Folder path, required for source "folder".',
        },
        recursive: {
          type: "boolean",
          description: "Also look in subfolders. Default false.",
        },
        scale_factor: {
          type: "number",
          description: "FBX scale for every model. Must come from the user.",
        },
        mode: { type: "string", enum: ["auto", "single", "split"] },
      },
      required: ["source", "scale_factor"],
    },
  });

  // open/switch to each model, run fn, close what we opened
  async function forEachModel(input, fn, progressLabel = "Model") {
    const startProject = Project;
    const report = [];
    let items = [];
    if (input.source === "current") {
      if (!Project) throw new Error("No model is open.");
      items = [
        { project: Project, key: "tab:" + ModelProject.all.indexOf(Project) },
      ];
    } else if (input.source === "open_tabs") {
      items = ModelProject.all.map((p, i) => ({ project: p, key: "tab:" + i }));
      if (!items.length) throw new Error("No tabs are open.");
    } else if (input.source === "folder") {
      const dir = String(input.folder || "")
        .trim()
        .replace(/^"|"$/g, "");
      if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        throw new Error("Folder not found: " + dir);
      const walk = (d) =>
        fs
          .readdirSync(d, { withFileTypes: true })
          .sort((x, y) => (x.name < y.name ? -1 : 1))
          .flatMap((e) => {
            const full = path.join(d, e.name);
            if (e.isDirectory())
              return input.recursive && !/^agent_(exports|packs)$/.test(e.name)
                ? walk(full)
                : [];
            return /\.bbmodel$/i.test(e.name) ? [full] : [];
          });
      items = walk(dir).map((file) => ({ file, key: file }));
      if (!items.length)
        throw new Error(
          "No .bbmodel files in " +
            dir +
            (input.recursive ? " (including subfolders)" : ""),
        );
    } else {
      throw new Error('source must be "current", "open_tabs" or "folder".');
    }

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      let label = it.project ? it.project.name : path.basename(it.file);
      progress(`${progressLabel} ${i + 1}/${items.length}: ${label}`);
      let openedByUs = null;
      try {
        if (it.project) {
          if (it.project.select() === false)
            throw new Error("could not switch to this tab");
        } else {
          const already = ModelProject.all.find((p) => p.save_path === it.file);
          if (already) already.select();
          else {
            const before = ModelProject.all.length;
            loadModelFile({
              path: it.file,
              name: path.basename(it.file),
              content: fs.readFileSync(it.file, "utf8"),
            });
            await sleep(50);
            if (ModelProject.all.length === before)
              throw new Error("Blockbench could not open the file");
            openedByUs = Project;
          }
        }
        await sleep(30);
        if (!(await waitForTextures()))
          report.push(`${label}: some textures did not finish loading`);
        label = Project.name || label;
        await fn({
          key: it.key,
          label,
          file: it.file || Project.save_path || null,
        });
      } catch (e) {
        report.push(`${label}: failed: ${e.message || e}`);
      } finally {
        if (openedByUs) {
          try {
            await openedByUs.close(true);
          } catch (e) {
            /* ignore */
          }
        }
      }
    }
    if (startProject && ModelProject.all.includes(startProject))
      startProject.select();
    return report;
  }

  TOOL_IMPL.bulk_export = async function (input) {
    const scale = Number(input.scale_factor);
    if (!(scale > 0))
      throw new Error(
        "scale_factor is required and must be > 0. Ask the user for it.",
      );
    const jobs = [];

    // write a glb per model
    const report = await forEachModel(
      input,
      async ({ label }) => {
        const { mode, mode_reason } = decideMode(input.mode);
        const { glb_path } = await exportGlb({});
        jobs.push({
          name: label,
          src: glb_path,
          dst: glb_path.replace(/\.glb$/i, ".fbx"),
          scale,
          mode,
          tex_scale: TEXTURE_SCALE,
          mode_reason,
        });
      },
      "GLB",
    );
    if (!jobs.length)
      throw new Error("Nothing was exported:\n- " + report.join("\n- "));

    // then convert all of them in one go
    progress(`Blender: ${jobs.length} model(s)…`);
    const results = await runBlenderJobs(jobs);
    const lines = jobs.map((j, i) => {
      const r = results[i] || {};
      return r.error || !r.exists
        ? `✗ ${j.name}: ${r.error || "FBX not written"}`
        : `✓ ${j.name} → ${r.fbx} (${j.mode}, ${j.mode_reason})`;
    });
    progress("");
    return {
      exported: lines.filter((l) => l.startsWith("✓")).length,
      failed:
        lines.filter((l) => l.startsWith("✗")).length +
        report.filter((r) => /failed/.test(r)).length,
      scale,
      models: lines,
      notes: report,
    };
  };

  // auto-rig

  // allowed bones -> parent (tail_N chains to tail_N-1)
  const RIG_TEMPLATES = {
    humanoid: {
      root: null,
      torso: "root",
      chest: "torso",
      h_head: "chest",
      lower_jaw: "h_head",
      right_arm: "chest",
      right_hand: "right_arm",
      left_arm: "chest",
      left_hand: "left_arm",
      right_leg: "root",
      right_foot: "right_leg",
      left_leg: "root",
      left_foot: "left_leg",
    },
    quadruped: {
      root: null,
      body: "root",
      neck: "body",
      h_head: "body", // 'neck' if the rig has one
      lower_jaw: "h_head",
      front_right_leg: "body",
      front_left_leg: "body",
      back_right_leg: "body",
      back_left_leg: "body",
      front_right_foot: "front_right_leg",
      front_left_foot: "front_left_leg",
      back_right_foot: "back_right_leg",
      back_left_foot: "back_left_leg",
    },
  };

  function templateParent(template, name, byName) {
    const t = RIG_TEMPLATES[template];
    if (template === "quadruped" && name === "h_head" && byName && byName.neck)
      return "neck";
    if (Object.prototype.hasOwnProperty.call(t, name)) return t[name];
    if (template === "quadruped") {
      const m = /^tail_(\d+)$/.exec(name);
      if (m) return m[1] === "0" ? "body" : "tail_" + (Number(m[1]) - 1);
    }
    return undefined;
  }

  const isRigElement = (el) => el && (el.type === "cube" || el.type === "mesh");
  let lastInspect = null; // ids given to the AI index into uuids

  // world-space corners, incl. parent rotations
  function worldCorners(el) {
    let pts = [];
    if (el.type === "mesh" && el.vertices) {
      pts = Object.values(el.vertices).map(
        (v) =>
          new THREE.Vector3(
            v[0] + el.origin[0],
            v[1] + el.origin[1],
            v[2] + el.origin[2],
          ),
      );
    } else {
      const a = el.from,
        b = el.to;
      for (const x of [a[0], b[0]])
        for (const y of [a[1], b[1]])
          for (const z of [a[2], b[2]]) pts.push(new THREE.Vector3(x, y, z));
    }
    const order =
      (typeof Format !== "undefined" && Format && Format.euler_order) || "ZYX";
    const rotateAbout = (rot, origin) => {
      if (!rot || !origin || (!rot[0] && !rot[1] && !rot[2])) return;
      const e = new THREE.Euler(
        (rot[0] * Math.PI) / 180,
        (rot[1] * Math.PI) / 180,
        (rot[2] * Math.PI) / 180,
        order,
      );
      const o = new THREE.Vector3(origin[0], origin[1], origin[2]);
      pts.forEach((p) => p.sub(o).applyEuler(e).add(o));
    };
    rotateAbout(el.rotation, el.origin);
    for (
      let g = el.parent;
      g && typeof g === "object" && g.type === "group";
      g = g.parent
    )
      rotateAbout(g.rotation, g.origin);
    return pts;
  }

  function bboxOf(pts) {
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    pts.forEach((p) => {
      const a = [p.x, p.y, p.z];
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], a[i]);
        max[i] = Math.max(max[i], a[i]);
      }
    });
    return { min, max };
  }
  const r2 = (v) => Math.round(v * 100) / 100;

  // front/side/top views as a png
  function drawDiagram(items, opts = {}) {
    const hueOf = opts.hueOf || ((it) => (it.id * 137) % 360);
    const labelOf = opts.labelOf || ((it) => String(it.id));
    const legend = opts.legend || [];
    const LEGEND_COLS = 6,
      legendRows = Math.ceil(legend.length / LEGEND_COLS);
    const PANEL = 380,
      PAD = 30,
      W = PANEL * 3,
      H = PANEL + 30,
      FULL_H = H + legendRows * 20 + (legendRows ? 10 : 0);
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = FULL_H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#1e1f22";
    ctx.fillRect(0, 0, W, FULL_H);
    const views = [
      {
        title: "FRONT (facing it: creature's right = screen left)",
        h: (p) => -p[0],
        v: (p) => p[1],
      },
      {
        title: "SIDE (from creature's right: front = screen right)",
        h: (p) => -p[2],
        v: (p) => p[1],
      },
      {
        title: "TOP (front = screen top, right = screen right)",
        h: (p) => p[0],
        v: (p) => -p[2],
      },
    ];
    const all = bboxOf(
      items.flatMap((it) => [
        { x: it.min[0], y: it.min[1], z: it.min[2] },
        { x: it.max[0], y: it.max[1], z: it.max[2] },
      ]),
    );
    views.forEach((view, vi) => {
      const ox = vi * PANEL;
      const hs = [view.h(all.min), view.h(all.max)],
        vs = [view.v(all.min), view.v(all.max)];
      const hMin = Math.min(...hs),
        hMax = Math.max(...hs),
        vMin = Math.min(...vs),
        vMax = Math.max(...vs);
      const s = (PANEL - PAD * 2) / Math.max(hMax - hMin, vMax - vMin, 1);
      const cx = ox + PANEL / 2 - ((hMin + hMax) / 2) * s,
        cy = 30 + PANEL / 2 + ((vMin + vMax) / 2) * s;
      const X = (h) => cx + h * s,
        Y = (v) => cy - v * s;
      ctx.strokeStyle = "#444";
      ctx.strokeRect(ox + 0.5, 0.5, PANEL - 1, H - 1);
      ctx.fillStyle = "#ddd";
      ctx.font = "13px sans-serif";
      ctx.fillText(view.title, ox + 8, 18);
      ctx.strokeStyle = "#555";
      ctx.setLineDash([4, 4]);
      if (vi < 2) {
        ctx.beginPath();
        ctx.moveTo(ox, Y(0));
        ctx.lineTo(ox + PANEL, Y(0));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const rects = items
        .map((it) => {
          const h1 = view.h(it.min),
            h2 = view.h(it.max),
            v1 = view.v(it.min),
            v2 = view.v(it.max);
          const x = X(Math.min(h1, h2)),
            y = Y(Math.max(v1, v2)),
            w = Math.abs(h2 - h1) * s,
            hgt = Math.abs(v2 - v1) * s;
          return { it, x, y, w, hgt };
        })
        .sort((a, b) => b.w * b.hgt - a.w * a.hgt);
      rects.forEach(({ it, x, y, w, hgt }) => {
        const hue = hueOf(it);
        ctx.fillStyle = `hsla(${hue},70%,55%,0.25)`;
        ctx.fillRect(x, y, Math.max(w, 1), Math.max(hgt, 1));
        ctx.strokeStyle = `hsl(${hue},80%,65%)`;
        ctx.strokeRect(x, y, Math.max(w, 1), Math.max(hgt, 1));
      });
      rects.forEach(({ it, x, y, w, hgt }) => {
        const label = labelOf(it);
        if (label == null) return;
        ctx.font = "bold 12px sans-serif";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#000";
        ctx.strokeText(label, x + w / 2 - 4, y + hgt / 2 + 4);
        ctx.lineWidth = 1;
        ctx.fillStyle = "#fff";
        ctx.fillText(label, x + w / 2 - 4, y + hgt / 2 + 4);
      });
      // pivots; overlapping ones share a dot
      const spots = [];
      (opts.points || []).forEach((pt) => {
        const px = X(view.h(pt.p)),
          py = Y(view.v(pt.p));
        const same = spots.find(
          (sp) => Math.abs(sp.px - px) < 4 && Math.abs(sp.py - py) < 4,
        );
        if (same) same.labels.push(pt.label);
        else spots.push({ px, py, hue: pt.hue, labels: [pt.label] });
      });
      spots.forEach((sp) => {
        ctx.beginPath();
        ctx.arc(sp.px, sp.py, 4, 0, Math.PI * 2);
        ctx.fillStyle = `hsl(${sp.hue},90%,60%)`;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.font = "10px sans-serif";
        ctx.fillStyle = "#fff";
        sp.labels.forEach((l, i) =>
          ctx.fillText(l, sp.px + 6, sp.py - 4 + i * 11),
        );
      });
    });
    legend.forEach((l, i) => {
      const lx = 10 + (i % LEGEND_COLS) * (W / LEGEND_COLS),
        ly = H + 18 + Math.floor(i / LEGEND_COLS) * 20;
      ctx.fillStyle = `hsl(${l.hue},80%,60%)`;
      ctx.fillRect(lx, ly - 10, 12, 12);
      ctx.fillStyle = "#ddd";
      ctx.font = "12px sans-serif";
      ctx.fillText(l.label, lx + 18, ly);
    });
    return canvas.toDataURL("image/png").split(",")[1];
  }

  TOOL_DEFS.push(
    {
      name: "inspect_model",
      description:
        "Look at the open model for rigging. Returns every cube/mesh with a numeric id, its name, current bone, world-space bounding box (min/max/center/size), " +
        "the existing bones, and an IMAGE with front/side/top views where every element is drawn as a box labelled with its id. " +
        "Axes: +Y up, front of the creature = -Z, creature's right side = +X. Call this before apply_rig.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "apply_rig",
      description:
        "Rebuild the bone hierarchy of the open model (one undo step). Give the template and the full list of bones. " +
        "Template bones and their required parents — humanoid: root > torso > chest > (h_head > lower_jaw, right_arm > right_hand, left_arm > left_hand); root > right_leg > right_foot, root > left_leg > left_foot. " +
        "quadruped: root > body > (neck > h_head > lower_jaw, front_right_leg > front_right_foot, front_left_leg > front_left_foot, back_right_leg > back_right_foot, back_left_leg > back_left_foot, tail_0 > tail_1 > tail_2 ...); if the model has no neck, h_head goes directly under body. " +
        "Every leg and arm must be split in two: inner cubes in *_leg / *_arm, outer cubes in its *_foot / *_hand child (a limb made of one single cube cannot be split and is reported). " +
        "Every pivot must lie inside or on the edge of one of that bone's own cubes (bones without cubes, like root, are exempt). " +
        "Leave out template bones the model has no part for. Extra bones (not in the template) are allowed for parts that need to move on their own, with any parent. " +
        "Every element id from inspect_model must be in exactly one bone. Existing bones with the same name are reused, so their animations stay linked; other existing bones are removed.",
      input_schema: {
        type: "object",
        properties: {
          template: { type: "string", enum: ["humanoid", "quadruped"] },
          bones: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                parent: {
                  type: ["string", "null"],
                  description: "Parent bone name; null only for root.",
                },
                pivot: {
                  type: "array",
                  items: { type: "number" },
                  minItems: 3,
                  maxItems: 3,
                  description: "Rotation point [x,y,z] in model units.",
                },
                elements: {
                  type: "array",
                  items: { type: "integer" },
                  description: "Element ids from inspect_model.",
                },
              },
              required: ["name", "parent", "pivot", "elements"],
            },
          },
        },
        required: ["template", "bones"],
      },
    },
  );

  TOOL_IMPL.inspect_model = async function () {
    const els = Outliner.elements.filter(isRigElement);
    if (!els.length) throw new Error("The open model has no cubes or meshes.");
    const items = els.map((el, id) => {
      const b = bboxOf(worldCorners(el));
      return { id, el, min: b.min, max: b.max };
    });
    lastInspect = {
      project: Project,
      uuids: els.map((e) => e.uuid),
      boxes: items.map((it) => ({ min: it.min, max: it.max })),
      reviewRounds: 0,
    };
    const groupName = (g) =>
      g && typeof g === "object" && g.type === "group" ? g.name : "root(none)";
    const all = bboxOf(
      items.flatMap((it) => [
        { x: it.min[0], y: it.min[1], z: it.min[2] },
        { x: it.max[0], y: it.max[1], z: it.max[2] },
      ]),
    );
    const data = {
      axes: "+Y up, front = -Z, creature right = +X, units = Blockbench pixels",
      model_bounds: { min: all.min.map(r2), max: all.max.map(r2) },
      animations:
        typeof Animation !== "undefined"
          ? Animation.all.map((a) => a.name)
          : [],
      existing_bones: Group.all.map((g) => ({
        name: g.name,
        parent: groupName(g.parent),
        pivot: g.origin.map(r2),
        rotation: g.rotation.map(r2),
      })),
      elements: items.map((it) => ({
        id: it.id,
        name: it.el.name,
        type: it.el.type,
        bone: groupName(it.el.parent),
        min: it.min.map(r2),
        max: it.max.map(r2),
        center: it.min.map((v, i) => r2((v + it.max[i]) / 2)),
        size: it.min.map((v, i) => r2(it.max[i] - v)),
      })),
    };
    const content = [{ type: "text", text: JSON.stringify(data) }];
    try {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: drawDiagram(items),
        },
      });
    } catch (e) {
      content.push({
        type: "text",
        text: "Diagram could not be drawn: " + e.message,
      });
    }
    return { __content: content };
  };

  // pivot checks
  const JOINT_TOL = 1.5; // px
  const MIRROR_TOL = 0.5; // px
  // humanoid legs hang from root but join the torso
  const JOINT_WITH = { humanoid: { right_leg: "torso", left_leg: "torso" } };
  // distance from point to box (0 inside)
  function boxDistance(p, box) {
    return Math.hypot(
      ...[0, 1, 2].map((i) =>
        Math.max(box.min[i] - p[i], 0, p[i] - box.max[i]),
      ),
    );
  }
  function unionBox(ids) {
    if (!ids.length) return null;
    const min = [Infinity, Infinity, Infinity],
      max = [-Infinity, -Infinity, -Infinity];
    ids.forEach((id) =>
      [0, 1, 2].forEach((i) => {
        min[i] = Math.min(min[i], lastInspect.boxes[id].min[i]);
        max[i] = Math.max(max[i], lastInspect.boxes[id].max[i]);
      }),
    );
    return { min, max };
  }
  // overlap of two boxes grown by tol, null if they don't touch
  function contactRegion(a, b, tol) {
    const min = [],
      max = [];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.max(a.min[i], b.min[i]);
      max[i] = Math.min(a.max[i], b.max[i]);
      if (min[i] > max[i] + 2 * tol) return null;
      if (min[i] > max[i]) {
        const m = (min[i] + max[i]) / 2;
        min[i] = max[i] = m;
      }
    }
    return { min, max, center: min.map((v, i) => r2((v + max[i]) / 2)) };
  }
  const isMirrorBox = (a, b) =>
    Math.abs(a.min[0] + b.max[0]) <= MIRROR_TOL &&
    Math.abs(a.max[0] + b.min[0]) <= MIRROR_TOL &&
    [1, 2].every(
      (i) =>
        Math.abs(a.min[i] - b.min[i]) <= MIRROR_TOL &&
        Math.abs(a.max[i] - b.max[i]) <= MIRROR_TOL,
    );

  // rig reviewer: separate call, only sees the picture + bone data
  const MAX_REVIEW_ROUNDS = 2; // then apply anyway with warnings
  const REVIEWER_PROMPT = [
    "You review a proposed rig (bone setup) for a Minecraft-style model made of cubes in Blockbench. You did not make it; judge only the picture and data you are given.",
    "Axes: +Y is up, the front of the creature faces -Z, the creature's own right side is +X. Units are pixels (16 = one block).",
    "The picture shows front, side and top views. Cubes are coloured by the bone they belong to (see the legend); dots are bone pivots, labelled with the bone name.",
    "Check two things.",
    "1) PARTS: does every bone hold the right part? Legs are the pieces under the body that reach the ground; front legs are at -Z, back legs at +Z; right is +X.",
    "The head is at the front end, a tail at the back end, a neck between body and head. *_foot / *_hand must be the outer (lower or farther) part of its limb.",
    "Watch for: swapped left/right or front/back, a tail or ear treated as a limb, head cubes left in the body, a limb missing a cube.",
    "2) PIVOTS: each pivot must be where that part bends. Leg: on the top face where it meets the body. Arm: at the shoulder, on the contact face with the chest, with Y about midway up the chest cubes (not at the top of the arm). Foot/hand: on its top face (knee/elbow joint).",
    "h_head: back-bottom of the head (neck joint). lower_jaw: back edge of the jaw (hinge). neck: where it meets the body. tail_0: face touching the body; each next tail segment: its front face.",
    "chest: at the waist where it meets the torso. body/torso: centered on x/z axis, but lower point on the y-axis that connects to the leg bones. Mirrored left/right limbs must have mirrored pivots. A pivot in the middle or at the far end of a limb is wrong.",
    "Only report real problems that would make the rig look or animate wrong; ignore offsets of 1 pixel or less and style choices. If everything is fine, approve.",
    "For each problem, name the bone and give a concrete fix (which cubes to move, or the pivot coordinates to use). Answer by calling submit_review.",
  ].join(" ");

  async function reviewRig(template, bones) {
    const row =
      (say("tool", "Rig reviewer", {
        status: "running",
        detail: "checking parts and pivots…",
      }),
      state.messages[state.messages.length - 1]);
    try {
      const boneOf = {};
      bones.forEach((b) =>
        (b.elements || []).forEach((id) => (boneOf[id] = b.name)),
      );
      const hue = {};
      bones.forEach((b, i) => (hue[b.name] = (i * 137 + 20) % 360));
      const items = lastInspect.boxes.map((box, id) => ({
        id,
        min: box.min,
        max: box.max,
        bone: boneOf[id],
      }));
      const image = drawDiagram(items, {
        hueOf: (it) => hue[it.bone],
        labelOf: () => null,
        points: bones
          .filter((b) => b.name !== "root")
          .map((b) => ({ p: b.pivot, label: b.name, hue: hue[b.name] })),
        legend: bones
          .filter((b) => (b.elements || []).length)
          .map((b) => ({ label: b.name, hue: hue[b.name] })),
      });
      const data = bones.map((b) => {
        const ids = (b.elements || []).filter((id) => lastInspect.boxes[id]);
        const box = ids.length
          ? bboxOf(
              ids.flatMap((id) =>
                [lastInspect.boxes[id].min, lastInspect.boxes[id].max].map(
                  (a) => ({ x: a[0], y: a[1], z: a[2] }),
                ),
              ),
            )
          : null;
        return {
          bone: b.name,
          parent: b.parent,
          pivot: b.pivot,
          cubes: ids.length,
          box: box
            ? { min: box.min.map(r2), max: box.max.map(r2) }
            : "no cubes",
        };
      });
      const reply = await anthropicRequest(
        {
          max_tokens: 1500,
          system: REVIEWER_PROMPT,
          // forced tool_choice gives a 400 on newer models, so auto + strict
          tools: [
            {
              name: "submit_review",
              description:
                "Submit the review result. Always call this exactly once.",
              strict: true,
              input_schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  verdict: { type: "string", enum: ["approve", "fix"] },
                  issues: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      properties: {
                        bone: { type: "string" },
                        problem: { type: "string" },
                        fix: { type: "string" },
                      },
                      required: ["bone", "problem", "fix"],
                    },
                  },
                },
                required: ["verdict", "issues"],
              },
            },
          ],
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Template: ${template}. Bones (pivot and the box around each bone's cubes):\n${JSON.stringify(data)}\n\nReview the rig in the picture and answer by calling submit_review.`,
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: image,
                  },
                },
              ],
            },
          ],
        },
        abortController ? abortController.signal : undefined,
      );
      const call = (reply.content || []).find(
        (b) => b.type === "tool_use" && b.name === "submit_review",
      );
      if (!call)
        throw new Error("the reviewer answered without calling submit_review");
      const issues = Array.isArray(call.input.issues) ? call.input.issues : [];
      const verdict =
        call.input.verdict === "fix" && issues.length ? "fix" : "approve";
      row.status = verdict === "approve" ? "ok" : "fail";
      row.detail =
        verdict === "approve"
          ? "approved"
          : `${issues.length} issue(s): ` +
            issues.map((i) => i.bone).join(", ");
      return { verdict, issues };
    } catch (e) {
      if (e.name === "AbortError") throw e;
      // review failed: still apply, just warn
      row.status = "fail";
      row.detail = "review skipped: " + e.message;
      return { verdict: "approve", issues: [], skipped: e.message };
    }
  }

  TOOL_IMPL.apply_rig = async function (input) {
    const template = input.template;
    if (!RIG_TEMPLATES[template])
      throw new Error('template must be "humanoid" or "quadruped".');
    if (!lastInspect || lastInspect.project !== Project)
      throw new Error("Call inspect_model first (for this project).");
    const bones = Array.isArray(input.bones) ? input.bones : [];
    const errors = [];

    // validate
    const byName = {};
    bones.forEach((b) => {
      if (!/^[a-z][a-z0-9_]*$/.test(String(b.name)))
        errors.push(`Bad bone name "${b.name}" (use lowercase snake_case).`);
      if (byName[b.name]) errors.push(`Duplicate bone "${b.name}".`);
      byName[b.name] = b;
    });
    if (!byName.root || byName.root.parent !== null)
      errors.push('There must be a bone "root" with parent null.');
    bones.forEach((b) => {
      if (b.name === "root") return;
      if (!byName[b.parent])
        errors.push(
          `Bone "${b.name}": parent "${b.parent}" is not in the bone list.`,
        );
      const required = templateParent(template, b.name, byName);
      if (required !== undefined && b.parent !== required)
        errors.push(
          `Bone "${b.name}" must have parent "${required}" in the ${template} template.`,
        );
      if (
        !Array.isArray(b.pivot) ||
        b.pivot.length !== 3 ||
        b.pivot.some((n) => typeof n !== "number" || !isFinite(n))
      )
        errors.push(`Bone "${b.name}": pivot must be [x,y,z].`);
    });
    bones.forEach((b) => {
      const seen = new Set();
      for (let n = b; n && n.parent !== null; n = byName[n.parent]) {
        if (seen.has(n.name)) {
          errors.push(`Bone "${b.name}" is part of a parent loop.`);
          break;
        }
        seen.add(n.name);
      }
    });
    // each element exactly once
    const owner = {};
    bones.forEach((b) =>
      (b.elements || []).forEach((id) => {
        if (!(id >= 0 && id < lastInspect.uuids.length))
          errors.push(`Bone "${b.name}": element id ${id} does not exist.`);
        else if (owner[id] !== undefined)
          errors.push(
            `Element ${id} is in both "${owner[id]}" and "${b.name}".`,
          );
        else owner[id] = b.name;
      }),
    );
    const missing = lastInspect.uuids
      .map((_, id) => id)
      .filter((id) => owner[id] === undefined);
    if (missing.length)
      errors.push("Elements not assigned to any bone: " + missing.join(", "));
    const elements = lastInspect.uuids.map((u) => OutlinerNode.uuids[u]);
    if (elements.some((e) => !e))
      errors.push(
        "The model changed since inspect_model. Call inspect_model again.",
      );
    // reused groups must be unrotated
    const rotated = Group.all.filter((g) =>
      g.rotation.some((v) => Math.abs(v) > 1e-6),
    );
    if (rotated.length)
      errors.push(
        "These bones are rotated in the rest pose, so rigging would move parts: " +
          rotated.map((g) => g.name).join(", ") +
          ". Reset their rotation to 0 first.",
      );
    // pivot must be inside/on one of the bone's cubes
    const EPS = 0.01;
    const inside = (p, box) =>
      p.every((v, i) => v >= box.min[i] - EPS && v <= box.max[i] + EPS);
    bones.forEach((b) => {
      const ids = (b.elements || []).filter((id) => lastInspect.boxes[id]);
      if (!ids.length || !Array.isArray(b.pivot) || b.pivot.length !== 3)
        return;
      if (!ids.some((id) => inside(b.pivot, lastInspect.boxes[id]))) {
        const hint = ids
          .map(
            (id) =>
              `${id}: min ${lastInspect.boxes[id].min.map(r2)} max ${lastInspect.boxes[id].max.map(r2)}`,
          )
          .join("; ");
        errors.push(
          `Bone "${b.name}": pivot [${b.pivot}] is outside its cubes. It must be inside or on the edge of one of them (${hint}).`,
        );
      }
    });
    // legs -> leg + foot, arms -> arm + hand (outer part = farther from pivot)
    const warnings = [];
    const center = (ids) =>
      [0, 1, 2].map(
        (i) =>
          ids.reduce(
            (sum, id) =>
              sum +
              (lastInspect.boxes[id].min[i] + lastInspect.boxes[id].max[i]) / 2,
            0,
          ) / ids.length,
      );
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const LIMBS = [
      ["_leg", "_foot", "leg", "foot"],
      ["_arm", "_hand", "arm", "hand"],
    ];
    LIMBS.forEach(([limbSuffix, endSuffix, limbWord, endWord]) => {
      bones
        .filter(
          (b) =>
            b.name.endsWith(limbSuffix) &&
            templateParent(template, b.name) !== undefined,
        )
        .forEach((limb) => {
          const endName = limb.name.slice(0, -limbSuffix.length) + endSuffix;
          const end = byName[endName];
          const limbIds = (limb.elements || []).filter(
            (id) => lastInspect.boxes[id],
          );
          const endIds = end
            ? (end.elements || []).filter((id) => lastInspect.boxes[id])
            : [];
          if (limbIds.length + endIds.length === 1) {
            warnings.push(
              `${limb.name} is a single cube, so it could not be split into ${limbWord} + ${endWord}.`,
            );
            return;
          }
          if (!end)
            errors.push(
              `Bone "${limb.name}" must be split: add "${endName}" (parent "${limb.name}") with the outer (${endWord}) cubes.`,
            );
          else if (!limbIds.length || !endIds.length)
            errors.push(
              `"${limb.name}" and "${endName}" must each get at least one cube (inner part = ${limbWord}, outer part = ${endWord}).`,
            );
          else if (
            Array.isArray(limb.pivot) &&
            dist(center(endIds), limb.pivot) <=
              dist(center(limbIds), limb.pivot)
          ) {
            errors.push(
              `"${endName}" cubes must be the outer part of the ${limbWord} (farther from the "${limb.name}" pivot than the "${limb.name}" cubes).`,
            );
          }
        });
    });

    // joint check: pivot where the bone meets its parent part
    const cubesOf = (name) =>
      byName[name]
        ? (byName[name].elements || []).filter((id) => lastInspect.boxes[id])
        : [];
    bones.forEach((b) => {
      if (b.parent === null || !Array.isArray(b.pivot) || b.pivot.length !== 3)
        return;
      const own = unionBox(cubesOf(b.name));
      if (!own) return;
      let jointName = (JOINT_WITH[template] || {})[b.name];
      if (!jointName || !byName[jointName]) {
        jointName = b.parent;
        const seen = new Set();
        while (
          jointName &&
          byName[jointName] &&
          !cubesOf(jointName).length &&
          !seen.has(jointName)
        ) {
          seen.add(jointName);
          jointName = byName[jointName].parent;
        }
      }
      const jointIds = jointName ? cubesOf(jointName) : [];
      if (!jointIds.length) return;
      const contact = contactRegion(own, unionBox(jointIds), JOINT_TOL);
      if (!contact) {
        warnings.push(
          `${b.name} does not touch "${jointName}", so its pivot was not checked against the joint`,
        );
        return;
      }
      const dist = Math.min(
        ...jointIds.map((id) => boxDistance(b.pivot, lastInspect.boxes[id])),
      );
      if (dist > JOINT_TOL) {
        errors.push(
          `Bone "${b.name}": pivot [${b.pivot}] is ${r2(dist)} px away from "${jointName}", but it must be at the joint where they touch. ` +
            `Suggested pivot: [${contact.center}] (centre of the contact area), or another point on that contact face.`,
        );
      }
    });

    // torso and chest bend from their bottom edge for human rigs
    if (template === "humanoid") {
      ["torso", "chest"].forEach((name) => {
        const b = byName[name];
        if (!b || !Array.isArray(b.pivot) || b.pivot.length !== 3) return;
        const box = unionBox(cubesOf(name));
        if (!box) return;
        const bottom = box.min[1];
        if (Math.abs(b.pivot[1] - bottom) > JOINT_TOL) {
          const suggested = [
            r2((box.min[0] + box.max[0]) / 2),
            r2(bottom),
            r2((box.min[2] + box.max[2]) / 2),
          ];
          errors.push(
            `Bone "${name}": pivot [${b.pivot}] must be at the bottom of its cubes (y = ${r2(bottom)}) so it bends naturally. Suggested pivot: [${suggested}].`,
          );
        }
      });
    }

    // arms pivot at the shoulder: midway up the chest
    if (template === "humanoid") {
      const chestBox = unionBox(cubesOf("chest"));
      if (chestBox) {
        const midY = (chestBox.min[1] + chestBox.max[1]) / 2;
        ["right_arm", "left_arm"].forEach((name) => {
          const b = byName[name];
          if (!b || !Array.isArray(b.pivot) || b.pivot.length !== 3) return;
          if (Math.abs(b.pivot[1] - midY) > JOINT_TOL) {
            errors.push(
              `Bone "${name}": pivot [${b.pivot}] must be at the shoulder, midway up the chest (y = ${r2(midY)}). Suggested pivot: [${b.pivot[0]}, ${r2(midY)}, ${b.pivot[2]}].`,
            );
          }
        });
      }
    }

    // mirrored limbs need mirrored pivots
    bones.forEach((b) => {
      const m = SIDE_RE.exec(b.name);
      if (!m || m[2] !== "right" || !Array.isArray(b.pivot)) return;
      const other = byName[otherSide(b.name)];
      if (!other || !Array.isArray(other.pivot)) return;
      const a = unionBox(cubesOf(b.name)),
        c = unionBox(cubesOf(other.name));
      if (!a || !c || !isMirrorBox(a, c)) return;
      const mirrored = [-b.pivot[0], b.pivot[1], b.pivot[2]];
      if (mirrored.some((v, i) => Math.abs(v - other.pivot[i]) > MIRROR_TOL)) {
        errors.push(
          `"${b.name}" and "${other.name}" are mirror images, so their pivots must mirror: "${b.name}" is [${b.pivot}], so "${other.name}" should be [${mirrored}] (it is [${other.pivot}]). Fix whichever one is wrong.`,
        );
      }
    });
    if (errors.length)
      throw new Error("Rig not applied:\n- " + errors.join("\n- "));

    // second opinion
    const review = await reviewRig(template, bones);
    const reviewNotes = [];
    if (review.verdict === "fix") {
      const list = review.issues.map(
        (i) => `${i.bone}: ${i.problem} → ${i.fix}`,
      );
      if (lastInspect.reviewRounds < MAX_REVIEW_ROUNDS) {
        lastInspect.reviewRounds++;
        throw new Error(
          `Rig not applied: the reviewer found problems (review ${lastInspect.reviewRounds}/${MAX_REVIEW_ROUNDS}). ` +
            "Fix them (or explain in your reply why one is wrong) and call apply_rig again:\n- " +
            list.join("\n- "),
        );
      }
      list.forEach((l) =>
        reviewNotes.push(
          "reviewer issue not fixed after " +
            MAX_REVIEW_ROUNDS +
            " rounds: " +
            l,
        ),
      );
    }
    if (review.skipped) reviewNotes.push("review skipped: " + review.skipped);

    // apply
    const oldGroups = Group.all.slice();
    const others = Outliner.elements.filter((e) => !isRigElement(e)); // locators etc.
    Undo.initEdit({
      outliner: true,
      groups: oldGroups,
      elements: elements.concat(others),
      selection: true,
    });

    const existing = {};
    oldGroups.forEach((g) => {
      if (!existing[g.name]) existing[g.name] = g;
    });
    const reuse = new Set(bones.map((b) => existing[b.name]).filter(Boolean));

    elements.forEach((e) => e.addTo());
    oldGroups.forEach((g) => g.addTo());
    others.forEach((e) => {
      if (e.parent && e.parent.type === "group" && !reuse.has(e.parent))
        e.addTo();
    });
    oldGroups.filter((g) => !reuse.has(g)).forEach((g) => g.remove(false));

    const made = {};
    const build = (b) => {
      if (made[b.name]) return made[b.name];
      const parent = b.parent === null ? undefined : build(byName[b.parent]);
      let g = existing[b.name];
      if (g) g.extend({ origin: b.pivot.slice(), rotation: [0, 0, 0] });
      else
        g = new Group({
          name: b.name,
          origin: b.pivot.slice(),
          rotation: [0, 0, 0],
        });
      g.addTo(parent);
      if (!existing[b.name]) g.init();
      g.isOpen = true;
      return (made[b.name] = g);
    };
    bones.forEach(build);

    bones.forEach((b) =>
      (b.elements || []).forEach((id) => elements[id].addTo(made[b.name])),
    );

    Canvas.updateAllPositions();
    if (Canvas.updateAllBones) Canvas.updateAllBones();
    Undo.finishEdit("Auto rig", {
      outliner: true,
      groups: Object.values(made),
      elements: elements.concat(others),
      selection: true,
    });

    const tree = (name, depth) =>
      "  ".repeat(depth) +
      name +
      ` (${(byName[name].elements || []).length})\n` +
      bones
        .filter((b) => b.parent === name)
        .map((b) => tree(b.name, depth + 1))
        .join("");
    return {
      applied: true,
      template,
      bones: bones.length,
      removed_bones: oldGroups.filter((g) => !reuse.has(g)).map((g) => g.name),
      extra_bones: bones
        .filter((b) => templateParent(template, b.name) === undefined)
        .map((b) => b.name),
      tree: tree("root", 0),
      warnings: warnings.concat(reviewNotes),
      review: review.skipped
        ? "skipped"
        : review.verdict === "approve"
          ? "approved" +
            (lastInspect.reviewRounds
              ? ` after ${lastInspect.reviewRounds} correction(s)`
              : "")
          : "applied with open reviewer issues",
      undo: "Ctrl+Z undoes the whole rig",
    };
  };

  // sync opposite faces
  const FACE_PAIRS = {
    north_south: ["north", "south"],
    east_west: ["east", "west"],
  };
  const PLANE_AXIS_PAIR = { 2: "north_south", 0: "east_west" };

  function pickTargets(target) {
    if (target === "selected") return Cube.selected.slice();
    if (target === "all") return Cube.all.slice();
    if (Array.isArray(target)) {
      if (!lastInspect || lastInspect.project !== Project)
        throw new Error(
          'Element ids come from inspect_model; call it first, or use "selected"/"all".',
        );
      return target
        .map((id) => OutlinerNode.uuids[lastInspect.uuids[id]])
        .filter((e) => e && e.type === "cube");
    }
    throw new Error(
      'target must be "selected", "all" or a list of element ids.',
    );
  }

  TOOL_DEFS.push({
    name: "sync_faces",
    description:
      "Copy the UV (and texture) of one face to the opposite face of the same cube, mirrored so the texture lines up from both sides. " +
      'Pairs: north_south or east_west. pair "auto" only works on planes (a cube with zero size on Z -> north_south, zero size on X -> east_west); ' +
      "for normal cubes the pair must be given. source = the face that is already correct; if omitted, a face with no texture or an empty UV is overwritten by the other one, otherwise north / east is used. " +
      'target: "selected" (cubes selected in Blockbench), "all", or element ids from inspect_model. Box-UV cubes are skipped. One undo step.',
    input_schema: {
      type: "object",
      properties: {
        target: {
          description: '"selected", "all", or an array of element ids',
          anyOf: [
            { type: "string", enum: ["selected", "all"] },
            { type: "array", items: { type: "integer" } },
          ],
        },
        pair: { type: "string", enum: ["auto", "north_south", "east_west"] },
        source: { type: "string", enum: ["north", "south", "east", "west"] },
      },
      required: ["target"],
    },
  });

  TOOL_IMPL.sync_faces = async function (input) {
    const cubes = pickTargets(input.target);
    if (!cubes.length)
      throw new Error(
        input.target === "selected"
          ? "No cubes are selected."
          : "No cubes found.",
      );
    const pairMode = input.pair || "auto";
    if (
      input.source &&
      pairMode !== "auto" &&
      !FACE_PAIRS[pairMode].includes(input.source)
    ) {
      throw new Error(`source "${input.source}" is not part of ${pairMode}.`);
    }
    const synced = [],
      skipped = [];
    const isEmpty = (f) =>
      !f ||
      f.texture === null ||
      f.texture === false ||
      (f.uv[0] === f.uv[2] && f.uv[1] === f.uv[3]);

    Undo.initEdit({ elements: cubes, uv_only: true });
    cubes.forEach((cube) => {
      const label = `${cube.name} (${cube.uuid.slice(0, 6)})`;
      if (cube.box_uv) return skipped.push(label + ": box UV");
      let pair = pairMode;
      if (pair === "auto") {
        const size = [0, 1, 2].map((i) => Math.abs(cube.to[i] - cube.from[i]));
        pair = PLANE_AXIS_PAIR[size.findIndex((v, i) => i !== 1 && v === 0)];
        if (input.source)
          pair =
            input.source === "north" || input.source === "south"
              ? "north_south"
              : "east_west";
        if (!pair)
          return skipped.push(
            label + ": not a plane, give pair north_south or east_west",
          );
      }
      const [a, b] = FACE_PAIRS[pair];
      let from =
        input.source && FACE_PAIRS[pair].includes(input.source)
          ? input.source
          : null;
      if (!from)
        from = isEmpty(cube.faces[a]) && !isEmpty(cube.faces[b]) ? b : a;
      const to = from === a ? b : a;
      const src = cube.faces[from],
        dst = cube.faces[to];
      if (isEmpty(src))
        return skipped.push(`${label}: ${from} face has no texture/UV to copy`);

      // mirror: flip u, or v if rotated 90/270
      const uv = src.uv.slice();
      const rot = (((src.rotation || 0) % 360) + 360) % 360;
      if (rot === 90 || rot === 270) [uv[1], uv[3]] = [uv[3], uv[1]];
      else [uv[0], uv[2]] = [uv[2], uv[0]];
      dst.uv = uv;
      dst.rotation = src.rotation || 0;
      dst.texture = src.texture;
      cube.autouv = 0; // otherwise blockbench overwrites it
      synced.push(`${label}: ${from} → ${to}`);
    });
    Canvas.updateView({
      elements: cubes,
      element_aspects: { uv: true, faces: true },
    });
    Undo.finishEdit("Sync opposite faces");
    if (typeof UVEditor !== "undefined" && UVEditor.loadData)
      UVEditor.loadData();
    return {
      synced: synced.length,
      skipped: skipped.length,
      details: synced.concat(skipped.map((s) => "skipped " + s)).slice(0, 60),
      undo: "Ctrl+Z",
    };
  };

  // share uv between mirrored left/right limbs (east/west faces)
  const SIDE_RE = /(^|_)(right|left)(_|$)/;
  const otherSide = (name) =>
    name.replace(
      SIDE_RE,
      (m, a, side, b) => a + (side === "right" ? "left" : "right") + b,
    );
  const mirroredUV = (uv, rotation) => {
    const out = uv.slice();
    const rot = (((rotation || 0) % 360) + 360) % 360;
    if (rot === 90 || rot === 270) [out[1], out[3]] = [out[3], out[1]];
    else [out[0], out[2]] = [out[2], out[0]];
    return out;
  };
  const EPSM = 0.001;
  const isXMirror = (a, b) =>
    Math.abs(a.from[0] + b.to[0]) < EPSM &&
    Math.abs(a.to[0] + b.from[0]) < EPSM &&
    [1, 2].every(
      (i) =>
        Math.abs(a.from[i] - b.from[i]) < EPSM &&
        Math.abs(a.to[i] - b.to[i]) < EPSM,
    );

  TOOL_DEFS.push({
    name: "share_mirrored_limb_uv",
    description:
      "For limbs that exist as right_* / left_* bones (right_leg/left_leg, front_right_foot/front_left_foot, right_arm/left_arm ...): " +
      "for every cube in the source-side bone that has an exact X-mirrored twin (mirrored across x = 0) in the other-side bone, point the EAST and WEST faces of both cubes " +
      "(4 faces) at the UV of one source face, mirrored so the same height/depth uses the same pixel on every face. This saves texture space. " +
      "Only east/west faces are changed. Cubes without an exact twin, and box-UV cubes, are skipped and reported. One undo step.",
    input_schema: {
      type: "object",
      properties: {
        bones: {
          type: "array",
          items: { type: "string" },
          description:
            'Bone names on either side to process (e.g. ["right_leg","right_foot"]). Omit for all right/left pairs.',
        },
        source_side: {
          type: "string",
          enum: ["right", "left"],
          description: "Whose UV is kept. Default right.",
        },
        source_face: {
          type: "string",
          enum: ["east", "west"],
          description:
            "Which face of the source cube is kept. Default: its outer face (east for right, west for left).",
        },
      },
    },
  });

  TOOL_IMPL.share_mirrored_limb_uv = async function (input) {
    const sourceSide = input.source_side === "left" ? "left" : "right";
    const sourceFace =
      input.source_face || (sourceSide === "right" ? "east" : "west");
    const groups = Group.all.filter((g) => {
      const m = SIDE_RE.exec(g.name);
      return m && m[2] === sourceSide;
    });
    const wanted =
      input.bones && input.bones.length
        ? new Set(
            input.bones.map((n) =>
              SIDE_RE.test(n) && SIDE_RE.exec(n)[2] !== sourceSide
                ? otherSide(n)
                : n,
            ),
          )
        : null;
    const pairs = [],
      report = [];
    groups.forEach((g) => {
      if (wanted && !wanted.has(g.name)) return;
      const twin = Group.all.find((o) => o.name === otherSide(g.name));
      if (!twin)
        return report.push(`${g.name}: no "${otherSide(g.name)}" bone`);
      const srcCubes = g.children.filter((c) => c.type === "cube");
      const twinCubes = twin.children.filter((c) => c.type === "cube");
      const used = new Set();
      srcCubes.forEach((c) => {
        const m = twinCubes.find((t) => !used.has(t) && isXMirror(c, t));
        if (!m)
          return report.push(
            `${g.name}/${c.name}: no exact mirrored twin in ${twin.name}`,
          );
        used.add(m);
        if (c.box_uv || m.box_uv)
          return report.push(`${g.name}/${c.name}: box UV, skipped`);
        const f = c.faces[sourceFace];
        if (!f || f.texture === null || f.texture === false)
          return report.push(
            `${g.name}/${c.name}: ${sourceFace} face has no texture`,
          );
        pairs.push({ bone: g.name, twinBone: twin.name, src: c, twin: m });
      });
      twinCubes
        .filter((t) => !used.has(t))
        .forEach((t) =>
          report.push(
            `${twin.name}/${t.name}: no exact mirrored twin in ${g.name}`,
          ),
        );
    });
    if (!groups.length)
      throw new Error(`No ${sourceSide}_* bones found. Rig the model first.`);
    if (!pairs.length)
      throw new Error(
        "No exactly mirrored cube pairs found:\n- " + report.join("\n- "),
      );

    const cubes = pairs.flatMap((p) => [p.src, p.twin]);
    Undo.initEdit({ elements: cubes, uv_only: true });
    pairs.forEach(({ src, twin }) => {
      const f = src.faces[sourceFace];
      const eastUV =
        sourceFace === "east" ? f.uv.slice() : mirroredUV(f.uv, f.rotation);
      const westUV = mirroredUV(eastUV, f.rotation);
      [src, twin].forEach((c) => {
        c.faces.east.uv = eastUV.slice();
        c.faces.west.uv = westUV.slice();
        ["east", "west"].forEach((d) => {
          c.faces[d].texture = f.texture;
          c.faces[d].rotation = f.rotation || 0;
        });
        c.autouv = 0;
      });
    });
    Canvas.updateView({
      elements: cubes,
      element_aspects: { uv: true, faces: true },
    });
    Undo.finishEdit("Share mirrored limb UV");
    if (typeof UVEditor !== "undefined" && UVEditor.loadData)
      UVEditor.loadData();
    return {
      shared_cube_pairs: pairs.length,
      faces_now_sharing_one_uv: pairs.length * 4,
      pairs: pairs
        .map((p) => `${p.bone}/${p.src.name} ↔ ${p.twinBone}/${p.twin.name}`)
        .slice(0, 60),
      skipped: report.slice(0, 60),
      note: "Texture areas previously used by the other east/west faces are now unused and can be cleared or repacked.",
      undo: "Ctrl+Z",
    };
  };

  async function runTool(name, input) {
    const fn = TOOL_IMPL[name];
    if (!fn) throw new Error("Unknown tool: " + name);
    return fn(input || {});
  }

  // agent loop
  const SYSTEM_PROMPT = [
    "You are an assistant built into the Blockbench 3D editor, helping with Minecraft-style model workflows.",
    "You act through tools. Typical export job: get_project_info -> export_gltf -> run_blender_pipeline.",
    'For several models ("all open tabs", "everything in this folder") use bulk_export once instead of repeating single exports. List the per-model results briefly.',
    'Export modes: leave mode as "auto" (the tool decides from the model\'s textures); only pass "single" or "split" if the user explicitly asks for one. Tell the user which mode was used and why (mode_reason in the result).',
    "Rules: only do what the user asked; the scale factor must come from the user, so ask for it if they did not give one;",
    "never generate or invent models, textures or animations; report file paths and any tool errors plainly.",
    "Auto-rig job: inspect_model -> study the numbers AND the image to identify each part -> apply_rig.",
    "Rigging: use the template the user names; otherwise humanoid for two-legged models with arms, quadruped for four-legged ones.",
    "Use the template bone names exactly (front_right_leg, tail_0, h_head ...); left/right are the creature's own sides (+X = right); front = -Z.",
    "Four-legged models: if there is a neck (cubes between the body and the head), make a neck bone (body > neck > h_head) with those cubes; do not leave neck cubes in body or h_head. Pivot the neck where it meets the body.",
    "Split every leg and arm in two: the inner cubes (attached to the body) are *_leg / *_arm, the outer cubes (shin/paw/foot, forearm/hand) are its *_foot / *_hand bone.",
    "Pivots go where the part bends, and MUST be inside or on the edge of one of that bone's own cubes (use the min/max from inspect_model): leg at the top face where it meets the body, arm at the shoulder joint: on the contact face with the chest, Y about midway up the chest cubes,",
    "foot at the top face of the foot cubes (the knee/ankle joint), hand at the top of the hand cubes, h_head at the back-bottom of the head (neck), lower_jaw at the back edge of the jaw (hinge),",
    "tail_0 at the face touching the body and each next tail segment at its front face, chest at the lowest y value where it meets the torso, torso and body should be centered on the x/z axis, and have the lowest y value within the main cube.",
    "Every pivot (except root) must sit on the contact face between the bone and the part it hangs from; mirrored left/right limbs need mirrored pivots. The code checks both and suggests a pivot if you miss.",
    "Report any warnings from apply_rig to the user.",
    "If the user asks for extra bones such as fingers, toes, claws or ears, add them as extra bones under the part they grow from (fingers/claws under the *_hand or *_foot, ears under h_head), named like right_hand_finger_0, right_hand_finger_1; pivot each one on the face where it joins its parent part. The *_hand / *_foot itself must still keep at least one cube (the palm or sole).",
    "Mirrored limbs (right_* / left_* bones): share_mirrored_limb_uv makes all east/west faces of exactly mirrored cubes use one UV. Default source is the right side's outer (east) face; ask if the user wants the left kept instead only when they hint at it.",
    'Face syncing: when the user says "selected"/"these", use target "selected". If they did not say which side is correct and both faces are textured, ask before syncing.',
    "Split a long tail into tail_0, tail_1, ... by the cubes along it. Small details go in the bone of the part they sit on; only add extra bones for parts that clearly move on their own.",
    "If the model has animations, tell the user that removed or renamed bones lose their keyframes and ask before applying.",
    "If apply_rig returns errors, fix them and call it again. apply_rig also sends your plan to an independent reviewer agent that checks parts and pivot placement; treat its issues like errors (fix them, re-checking the cube boxes from inspect_model). After applying, show the bone tree briefly, say what the reviewer changed or flagged, and mention Ctrl+Z.",
    "Keep replies short. Reply in English unless the user writes in another language.",
  ].join(" ");

  const MAX_STEPS = 10;

  const state = {
    messages: [], // shown in the ui
    draft: "",
    busy: false,
  };
  let history = []; // sent to the api
  let abortController = null;

  function say(role, text, extra) {
    state.messages.push(Object.assign({ role, text }, extra));
    setTimeout(() => {
      const el = panel && panel.vue && panel.vue.$refs && panel.vue.$refs.log;
      if (el) el.scrollTop = el.scrollHeight;
    }, 0);
  }

  // one messages api call (agent + reviewer)
  async function anthropicRequest(body, signal) {
    // strip non-ascii, pasted keys break the header otherwise
    const key = String(getSetting("bbagent_api_key") || "").replace(
      /[^\x21-\x7E]/g,
      "",
    );
    if (!key)
      throw new Error(
        'No API key. Add it in File > Settings > General > "Agent: Anthropic API key".',
      );

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(
        Object.assign(
          { model: String(getSetting("bbagent_model") || "claude-sonnet-5-5") },
          body,
        ),
      ),
    });
    const data = await res.json();
    if (!res.ok)
      throw new Error(
        (data && data.error && data.error.message) || "API error " + res.status,
      );
    return data;
  }

  const MAX_OUTPUT_TOKENS = 16000;
  function callClaude(signal) {
    return anthropicRequest(
      {
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools: TOOL_DEFS,
        messages: history,
      },
      signal,
    );
  }

  async function sendMessage(text) {
    text = String(text || "").trim();
    if (!text || state.busy) return;
    state.busy = true;
    state.draft = "";
    say("user", text);
    history.push({ role: "user", content: text });
    abortController = new AbortController();
    let finished = false,
      hadError = false,
      finalText = "";

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        const reply = await callClaude(abortController.signal);

        // hit max_tokens: drop the half tool call so history stays valid
        if (reply.stop_reason === "max_tokens") {
          say(
            "error",
            `The agent's reply was cut off: it hit the ${MAX_OUTPUT_TOKENS}-token output limit (usually a very long rig plan). Try a smaller step, e.g. rig only the legs first, or say "try again".`,
          );
          hadError = true;
          break;
        }
        history.push({ role: "assistant", content: reply.content });

        const textParts = reply.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (textParts) {
          say("assistant", textParts);
          finalText = textParts;
        }

        const toolCalls = reply.content.filter((b) => b.type === "tool_use");
        if (reply.stop_reason !== "tool_use" || toolCalls.length === 0) {
          if (!textParts) {
            say(
              "error",
              `The agent stopped without a reply (stop reason: ${reply.stop_reason || "unknown"}). Say "continue" or try again.`,
            );
            hadError = true;
          }
          finished = true;
          break;
        }

        const results = [];
        for (const call of toolCalls) {
          say("tool", TOOL_LABELS[call.name] || call.name, {
            status: "running",
            detail: "",
          });
          const row = state.messages[state.messages.length - 1];
          progressRow = row;
          try {
            const out = await runTool(call.name, call.input);
            row.status = "ok";
            const content =
              out && out.__content ? out.__content : JSON.stringify(out);
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content,
            });
          } catch (err) {
            row.status = "fail";
            row.detail = err.message.split("\n")[0];
            hadError = true;
            results.push({
              type: "tool_result",
              tool_use_id: call.id,
              content: String(err.message),
              is_error: true,
            });
          }
        }
        history.push({ role: "user", content: results });

        if (step === MAX_STEPS - 1)
          say("error", "Stopped: reached the " + MAX_STEPS + "-step limit.");
      }
      if (finished && !hadError && !asksQuestion(finalText))
        compactHistory(text, finalText);
    } catch (err) {
      if (err.name === "AbortError") say("error", "Stopped.");
      else say("error", err.message);
      // drop a dangling tool_use
      const last = history[history.length - 1];
      if (
        last &&
        last.role === "assistant" &&
        Array.isArray(last.content) &&
        last.content.some((b) => b.type === "tool_use")
      ) {
        history.pop();
      }
    } finally {
      state.busy = false;
      abortController = null;
    }
  }

  // after a clean run, keep only the last request + reply (saves tokens)
  const asksQuestion = (t) => /\?[\s*_`)"']*$/m.test(t || "");
  function compactHistory(userText, finalText) {
    history = [
      {
        role: "user",
        content: "[Previous task, for context only] " + userText,
      },
      { role: "assistant", content: finalText || "Done." },
    ];
    say("divider", "Task done · context cleared");
  }

  function stopAgent() {
    if (abortController) abortController.abort();
  }

  function clearChat() {
    stopAgent();
    history = [];
    state.messages.splice(0, state.messages.length);
  }

  // ui
  let panel, openAction, styles;

  const TOOL_LABELS = {
    get_project_info: "Read project",
    export_gltf: "Export GLB",
    run_blender_pipeline: "Blender → FBX",
    inspect_model: "Inspect model",
    apply_rig: "Apply rig",
    sync_faces: "Sync faces",
    share_mirrored_limb_uv: "Share limb UV",
    bulk_export: "Bulk export",
  };

  // tiny markdown: code blocks, bold, inline code, headings, file paths
  const PATH_RE =
    /^(?:[A-Za-z]:\\[^\s"'<>|*?`]+|\/(?:[^\s"'<>|*?`/]+\/)+[^\s"'<>|*?`/]+)$/;
  const FENCE_RE = /```[^\n`]*\n?([\s\S]*?)(?:```|$)/g;
  const TOKEN_RE =
    /\*\*([^*\n]+)\*\*|`([^`\n]+)`|([A-Za-z]:\\[^\s"'<>|*?`]+)|^#{1,6} +([^\n]+)$/gm;
  function inlineSegments(text, out) {
    let last = 0,
      m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(text))) {
      if (m.index > last)
        out.push({ type: "text", value: text.slice(last, m.index) });
      if (m[1] != null)
        out.push({ type: "bold", value: m[1].replace(/`/g, "") });
      else if (m[2] != null)
        out.push({ type: PATH_RE.test(m[2]) ? "path" : "code", value: m[2] });
      else if (m[4] != null)
        out.push({ type: "bold", value: m[4].replace(/\*\*/g, "") });
      else {
        const p = m[3].replace(/[.,;:)\]]+$/, "");
        out.push({ type: "path", value: p });
        if (p.length < m[3].length)
          out.push({ type: "text", value: m[3].slice(p.length) });
      }
      last = TOKEN_RE.lastIndex;
    }
    if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  }
  function toSegments(text) {
    const out = [];
    let last = 0,
      m;
    FENCE_RE.lastIndex = 0;
    while ((m = FENCE_RE.exec(text))) {
      if (m.index > last) inlineSegments(text.slice(last, m.index), out);
      out.push({ type: "block", value: m[1].replace(/\n$/, "") });
      last = FENCE_RE.lastIndex;
      if (m[0].length === 0) FENCE_RE.lastIndex++;
    }
    if (last < text.length) inlineSegments(text.slice(last), out);
    out.forEach((seg, i) => {
      const next = out[i + 1];
      if (seg.type === "block" && next && next.type === "text")
        next.value = next.value.replace(/^\n/, "");
    });
    return out;
  }

  // reveal file in explorer/finder
  function openPath(p) {
    try {
      const shell = require("shell", {
        message: "Open exported files and folders from the agent chat.",
      });
      if (!shell) return;
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) shell.openPath(p);
      else if (fs.existsSync(p)) shell.showItemInFolder(p);
      else if (fs.existsSync(path.dirname(p))) shell.openPath(path.dirname(p));
      else Blockbench.showQuickMessage("Path not found: " + p, 2000);
    } catch (e) {
      console.warn("[bbagent] could not open path", e);
    }
  }

  const CSS = `
		.bbagent { display:flex; flex-direction:column; height:100%; min-height:260px; font-size:13px; }
		.bbagent-log { flex:1; overflow-y:auto; padding:8px 10px; display:flex; flex-direction:column; gap:6px; user-select:text; }
		.bbagent-empty { margin:auto; text-align:center; color:var(--color-subtle_text); padding:20px 10px; line-height:1.5; }
		.bbagent-msg { white-space:pre-wrap; word-break:break-word; line-height:1.45; }
		.bbagent-msg.bba-user { align-self:flex-end; max-width:85%; background:var(--color-selected); padding:6px 10px; border-radius:10px 10px 2px 10px; }
		.bbagent-msg.bba-assistant { align-self:stretch; padding:2px 2px; }
		.bbagent-msg.bba-error { background:rgba(200,60,60,0.18); border-left:3px solid #d05050; padding:5px 8px; border-radius:3px; }
		.bbagent-tool { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--color-subtle_text); padding:0 2px; }
		.bbagent-tool .material-icons { font-size:16px; }
		.bbagent-tool.ok .material-icons { color:#5bbf6a; }
		.bbagent-tool.fail .material-icons { color:#d05050; }
		.bbagent-tool.running .material-icons { animation:bbagent-spin 1s linear infinite; }
		.bbagent-tool .bba-detail { opacity:0.8; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
		@keyframes bbagent-spin { to { transform:rotate(360deg); } }
		.bbagent-divider { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--color-subtle_text); opacity:0.7; margin:2px 0; }
		.bbagent-divider::before, .bbagent-divider::after { content:''; flex:1; border-top:1px solid var(--color-border); }
		.bbagent-pre { margin:4px 0; padding:6px 8px; background:var(--color-back); border-radius:4px; font-family:var(--font-code, monospace); font-size:0.92em; white-space:pre; overflow-x:auto; }
		.bbagent-msg code { background:var(--color-back); padding:0 4px; border-radius:3px; font-family:var(--font-code, monospace); font-size:0.92em; }
		.bbagent-path { color:#4ea1ff; cursor:pointer; text-decoration:underline; text-underline-offset:2px; word-break:break-all; }
		.bbagent-path:hover { color:#7dbaff; }
		.bbagent-input { display:flex; flex-direction:column; gap:4px; padding:8px; border-top:1px solid var(--color-border); }
		.bbagent-input textarea { display:block; width:100% !important; box-sizing:border-box; min-height:60px; height:60px; max-height:200px; resize:vertical; padding:7px 9px; border-radius:6px; background:var(--color-back); border:1px solid var(--color-border); color:var(--color-text); }
		.bbagent-input-bar { display:flex; align-items:center; gap:4px; }
		.bbagent-hint { flex:1; font-size:11px; color:var(--color-subtle_text); opacity:0.7; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
		.bbagent-input textarea:focus { border-color:var(--color-accent); outline:none; }
		.bbagent-btn { flex:none; width:28px !important; min-width:0 !important; height:28px !important; display:flex; align-items:center; justify-content:center; border-radius:6px; cursor:pointer; background:var(--color-button); color:var(--color-text); border:none; padding:0; }
		.bbagent-btn:hover { background:var(--color-accent); color:var(--color-accent_text, #fff); }
		.bbagent-btn:disabled { opacity:0.4; cursor:default; background:var(--color-button); }
		.bbagent-btn .material-icons { font-size:18px; }
	`;

  function buildPanel() {
    panel = new Panel("bbagent_chat", {
      name: "Agent",
      icon: "smart_toy",
      growable: true,
      resizable: true,
      default_position: { slot: "right_bar", height: 420 },
      component: {
        data() {
          return state;
        },
        methods: {
          send() {
            sendMessage(this.draft);
          },
          stop: stopAgent,
          clear: clearChat,
          segments: toSegments,
          open: openPath,
          toolIcon(status) {
            return status === "ok"
              ? "check_circle"
              : status === "fail"
                ? "error"
                : "autorenew";
          },
        },
        template: `
					<div class="bbagent">
						<div class="bbagent-log" ref="log">
							<div v-if="!messages.length" class="bbagent-empty">
								Ask me to export or rig the open model.<br>e.g. "export to FBX, scale 0.5" or "auto rig as quadruped"
							</div>
							<template v-for="(m, i) in messages">
								<div v-if="m.role === 'divider'" :key="i" class="bbagent-divider">{{ m.text }}</div>
								<div v-else-if="m.role === 'tool'" :key="i" :class="['bbagent-tool', m.status]" :title="m.detail || ''">
									<i class="material-icons">{{ toolIcon(m.status) }}</i>
									<span>{{ m.text }}</span>
									<span v-if="m.detail" class="bba-detail">— {{ m.detail }}</span>
								</div>
								<div v-else :key="i" :class="['bbagent-msg', 'bba-' + m.role]"><template v-for="(seg, j) in segments(m.text)"><b v-if="seg.type === 'bold'" :key="j">{{ seg.value }}</b><code v-else-if="seg.type === 'code'" :key="j">{{ seg.value }}</code><pre v-else-if="seg.type === 'block'" :key="j" class="bbagent-pre">{{ seg.value }}</pre><span v-else-if="seg.type === 'path'" :key="j" class="bbagent-path" title="Show in folder" @click="open(seg.value)">{{ seg.value }}</span><template v-else>{{ seg.value }}</template></template></div>
							</template>
						</div>
						<div class="bbagent-input">
							<textarea v-model="draft" placeholder="Message the agent…" @keydown.enter.exact.prevent="send"></textarea>
							<div class="bbagent-input-bar">
								<span class="bbagent-hint">Enter to send · Shift+Enter for a new line</span>
								<button class="bbagent-btn" title="Clear chat" @click="clear" :disabled="busy || !messages.length"><i class="material-icons">delete_sweep</i></button>
								<button v-if="busy" class="bbagent-btn" title="Stop" @click="stop"><i class="material-icons">stop</i></button>
								<button v-else class="bbagent-btn" title="Send" @click="send" :disabled="!draft.trim()"><i class="material-icons">send</i></button>
							</div>
						</div>
					</div>`,
      },
    });
  }

  // register (clean up everything in onunload)
  Plugin.register(PLUGIN_ID, {
    title: "Blockbench Agent",
    author: "Omar Saib",
    description:
      "Chat with an AI agent inside Blockbench: export pipeline (glTF → Blender → FBX) and auto-rigging.",
    icon: "smart_toy",
    version: "0.1.0",
    variant: "desktop",
    min_version: "4.8.0",
    tags: ["Utility", "AI"],

    onload() {
      if (!fs) {
        Blockbench.showMessageBox({
          title: "Blockbench Agent",
          message: "This plugin needs the desktop app (Node access).",
        });
        return;
      }
      registerSettings();
      persistSettings();
      Blockbench.on("update_settings", persistSettings);
      styles = Blockbench.addCSS(CSS);
      buildPanel();
      openAction = new Action("bbagent_open", {
        name: "Open Agent Chat",
        description: "Show the agent chat panel",
        icon: "smart_toy",
        click() {
          try {
            if (panel.slot === "hidden") panel.moveTo("right_bar");
            panel.fold(false);
            panel.moveToFront();
          } catch (e) {
            console.warn("[bbagent] could not focus panel", e);
          }
        },
      });
      MenuBar.addAction(openAction, "tools");
    },

    onunload() {
      stopAgent();
      Blockbench.removeListener("update_settings", persistSettings);
      if (openAction) openAction.delete();
      if (panel) panel.delete();
      if (styles) styles.delete();
      settings.forEach((s) => s.delete && s.delete());
    },
  });
})();
