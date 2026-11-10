# Blockbench Support Agent

A Blockbench plugin that adds an AI chat panel. You tell it what you need ("rig this as a quadruped", "export all open tabs to FBX at scale 0.5") and it does the work through a set of tools inside Blockbench and Blender.

It doesn't generate models, textures or animations. It only automates the repetitive parts of working on models you made yourself.

![Auto-rigging demo](docs/demo1.gif)

## Features

**Auto-rigging**

- Builds a humanoid or quadruped bone hierarchy (legs split into leg + foot, arms into arm + hand, neck and tail chains)
- The agent looks at rendered front/side/top views of the model to work out which cubes are which body part
- Code checks every plan before it's applied: each pivot has to sit inside its own cubes and where the bone joins its parent, and left/right limbs have to mirror each other
- A second agent reviews the rig from a picture of it and sends it back if something looks wrong
- Applied as one undo step

**Export pipeline**

- Blockbench → glTF → Blender (headless) → FBX
- Picks the mode from the model: textured models export as one mesh with embedded textures, untextured ones get split by material
- Textures are upscaled 10x (nearest neighbour) so pixel art stays sharp
- Bulk export of all open tabs or a whole folder of `.bbmodel` files, with a single Blender run

**UV tools**

- Sync opposite faces (north/south, east/west) so a texture lines up from both sides
- Point the east/west faces of mirrored left/right limbs at one UV area to save texture space

## How it works

The panel runs an agent loop against the Claude API. Each feature is a tool: a JSON schema the model sees plus a function that does the actual work in Blockbench or Blender. The model decides which tools to call and in what order. The code validates every input and does all the geometry and file work, so the AI never touches the model directly.

After a task finishes, the chat history is trimmed down to the last request and reply to keep token costs low.

## Requirements

- Blockbench desktop app (not the web version)
- Blender 4.x for FBX export
- An Anthropic API key

## Installation

1. Download `blockbench_agent.js`
2. In Blockbench: **File → Plugins → Load Plugin from File**, then pick the file
3. Open **File → Settings → General** and fill in:
   - **Agent: Anthropic API key**
   - **Agent: Blender executable** (optional, it auto-detects common install folders)
   - **Agent: output folder** (optional, defaults to next to the `.bbmodel`)
4. Open the panel with **Tools → Open Agent Chat**

## Example prompts

- `Rig this model as a quadruped`
- `Export this to FBX at scale 0.5`
- `Export everything in C:\models\mobs at scale 1`
- `Sync the north and south faces of the selected cubes`
- `Share the UV between the left and right legs`

## License

MIT
