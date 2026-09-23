# @sidleo3/skill-filesystem-plus

[English](README.md) | [中文](README.zh-CN.md)

A configurable skill discovery provider for [DeepSeek Harness](https://github.com/DeepSeekAI/deepseek-harness) (DSH). It replaces the fixed discovery of the built-in \`dsh-skill-filesystem\` with **editable scan layers and parent directories** — but only in presets you explicitly enable in the GUI.

> Renamed from \`@sidleo3/skill-scan\`; the GitHub repository \`sidleo/skill-scan\` is now \`sidleo/skill-filesystem-plus\`. Your old config (\`~/.dsh/dsh-skill-scan.json\`) is migrated automatically.

## Core design

- **Install = no-op**: installing the plugin changes nothing — no preset is copied or modified, and the built-in \`skill-filesystem\` keeps working
- **You decide the scope**: enable takeover per preset in the Web GUI (sidebar → Plugins → this plugin's config page)
- **Full replacement**: for an enabled preset, a \`preset-<id>\` override row is written into the profile's \`cordis.patch.yml\` (built-in \`skill-filesystem\` marked \`disabled\`, this plugin's \`/preset\` provider row appended); unselected presets keep built-in behavior untouched
- **Removal is surgical**: unchecking deletes only this plugin's own override row, leaving every other patch entry byte-identical
- **Config page survives DSH upgrades**: the page registers into the sidebar Plugins page's \`plugins.bundle.config\` slot (keyed by package name), and the settings live in this plugin's own JSON file — no dependency on DSH settings namespaces

## Features

- **Four scanning layers**: cwd (highest) → project/parents (mutually exclusive) → global (lowest)
- **scanParents mode**: walk every ancestor from cwd upward — no depth limit
- **Editable parent dirs**: default \`.dsh\`, \`.agents\`; add/remove/rename freely, drag to reorder (top = highest priority)
- **Config page**: sidebar → Plugins → this plugin — per-preset takeover + four-layer scan config + root preview
- **Live invalidation**: a model \`write\`/\`edit\` touching a \`<…>/skills/\` path invalidates the catalog immediately

## Installation

\`\`\`bash
# From npm (recommended)
dsh plugin --profile web add @sidleo3/skill-filesystem-plus

# From a local checkout (development)
dsh plugin --profile web add link:/path/to/skill-filesystem-plus
\`\`\`

Restart DSH after installing. **No further action needed** — the plugin touches no preset and the built-in skill-filesystem keeps working.

## Usage: enable per preset in the GUI

1. Open the sidebar **Plugins** page and enter this plugin's **config** page
2. Check the presets to take over (multi-select; only presets that can be taken over are listed)
3. A \`- id: preset-<id>\` override row is written into the profile's \`cordis.patch.yml\`: it copies the preset's shipped plugin rows verbatim, marks \`skill-filesystem\` with \`disabled: true\`, and appends the \`@sidleo3/skill-filesystem-plus/preset\` row
4. **Restart DSH**; sessions created afterwards on that preset use this plugin's four-layer discovery
5. Unchecking deletes only this plugin's own override row, leaving other patch entries untouched

> Running sessions are unaffected (preset composition is fixed at session creation); changes apply to sessions created afterwards.

## Configuration

\`\`\`typescript
interface SkillScanConfig {
  scanCwd: boolean           // default: true
  scanProject: boolean       // default: true (mutually exclusive with scanParents)
  scanParents: boolean       // default: false (mutually exclusive with scanProject)
  scanGlobal: boolean        // default: true
  parentDirs: { name: string }[]  // default: [{name:'.dsh'},{name:'.agents'}]
}
\`\`\`

Persisted at \`~/.dsh/dsh-skill-filesystem-plus.json\` (legacy \`dsh-skill-scan.json\` migrates automatically).

## How it works

1. **Install = no-op**: the host entry only exposes GUI RPC + declares the \`Config\` schema, and never touches a preset
2. **User picks presets**: the GUI calls \`/api/skill-filesystem-plus/presets/apply\`; the host reads the shipped composition (the declarative \`dsh-agent-preset\` row's \`presets/<id>.patch.yml\`) → backs up the profile patch → writes a \`preset-<id>\` override row into \`cordis.patch.yml\`
3. **Discovery**: that preset layer's \`/preset\` provider registers scope-aware (\`skills.registerProvider\`) and runs four-layer discovery, fully replacing built-in discovery
4. **Removal**: the GUI calls \`/api/skill-filesystem-plus/presets/remove\`, deleting only this plugin's own \`preset-<id>\` row
5. **Config live-reload**: the provider re-reads the disk config through \`ctx.fs\` on every \`list\`, so a GUI save takes effect on the next catalog refresh

> Override rows use **replace** (not merge) semantics, so the row must copy the preset's whole plugin list. Editing is **line-based, never parse→re-serialize**: preset rows carry \`!!js\` tags (e.g. \`disabled: !!js process.platform === 'win32'\`), and a full round-trip would evaluate them to strings — \`disabled\` would then read as truthy and the shell tools would silently disappear.

## Why "replace" matters

DSH resolves same-named skills by **layer before rank**. As long as the built-in \`skill-filesystem\` stays mounted in the preset layer, it wins every duplicate name regardless of your rank — so to make "duplicates resolved by your priority" actually work, that preset's \`skill-filesystem\` row must be disabled and the provider supplied by this plugin.

## Development

\`\`\`bash
pnpm install
pnpm build        # tsdown → lib/index.js + lib/preset.js + lib/client.js
pnpm typecheck    # tsc --noEmit
\`\`\`

## Notes

- After a DSH upgrade rewrites the shipped preset composition, an existing override row may become stale; uncheck and re-check in the GUI to rebuild it from the installed version
- \`skill-scan-blueprint/\` keeps the pre-rename dynamic-plugin form for reference (not part of the build)

## Compatibility

Built for **DSH 0.1.7-alpha** and later:

- The config page registers into the sidebar Plugins page's \`plugins.bundle.config\` slot (as of 0.1.7 the Settings "Plugins" section is a read-only built-in inventory, and the old \`settings.plugin.item\` slot no longer exists)
- Preset takeover writes override rows into the profile's \`cordis.patch.yml\` (\`agentPresetRegistry.list()\`/\`resolve()\` return display metadata only — no composition path, no read/write)
- Settings still persist in this plugin's own \`~/.dsh/dsh-skill-filesystem-plus.json\`

## License

MIT
