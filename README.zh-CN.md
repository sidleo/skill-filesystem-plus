# @sidleo3/skill-filesystem-plus

[English](README.md) | [中文](README.zh-CN.md)

为 [DeepSeek Harness](https://github.com/DeepSeekAI/deepseek-harness)（DSH）提供的**可配置技能发现提供方**，按 preset 选择性接管内置 `dsh-skill-filesystem` 的固定发现逻辑——四层扫描 + 可编辑的上级目录名，**只在用户显式勾选的 preset 中生效**。

> 本项目由 `@sidleo3/skill-scan` 更名而来；GitHub 仓库已改名为 `sidleo/skill-filesystem-plus`。旧配置（`~/.dsh/dsh-skill-scan.json`）会自动迁移。

## 核心设计

- **安装零改动**：插件安装后不做任何事，不复制、不修改任何 preset，内置 `skill-filesystem` 照常工作
- **用户决定生效范围**：在 Web GUI（侧栏 → 插件 → 本插件的配置页）里勾选要接管的 preset（多选）
- **完全替代**：勾选某个 preset 后，profile 的 `cordis.patch.yml` 里写入该 preset 的 `preset-<id>` 覆盖行（内置 `skill-filesystem` 行 `disabled`，并接入本插件的 `/preset` provider 行）；未勾选的 preset 完全保持内置行为
- **取消即恢复**：取消勾选只删除本插件自己那条覆盖行，其余 patch 条目逐字节不变
- **配置页跨 DSH 升级稳定**：页面注册进侧栏插件页的 `plugins.bundle.config` 插槽（以包名为 key），配置数据存在本插件自己的 JSON 文件里，不依赖 DSH 的设置命名空间

## 功能

| 层级 | 优先级 | 扫描路径 |
|---|---|---|
| **cwd**（会话工作目录） | 最高 | `<cwd>/<上级目录>/skills` |
| **项目目录**（最近含 `.git` 的祖先） | 中 — 与「上级遍历」互斥 | `<项目根>/<上级目录>/skills` |
| **上级遍历**（从 cwd 向上逐级） | 中 — 与「项目目录」互斥 | 每个祖先的 `<上级目录>/skills` |
| **全局**（用户主目录 `~`） | 最低 | `~/<上级目录>/skills` |

- **可编辑上级目录** — 默认 `.dsh`、`.agents`；可增删改，并**拖动排序调整优先级**（越靠上越优先）。
- **互斥二选一** — 项目目录扫描与上级遍历只能开一个（UI 与宿主双重校验）。
- **技能格式** — 目录包（`<名称>/SKILL.md`）与平铺 Markdown 文件（`<名称>.md`）；解析 frontmatter 的 `name`、`description`、`whenToUse`、`disable-model-invocation`、`user-invocable`。
- **重名裁决** — 不同名技能全部加载；同名的只保留优先级最高（rank 最小）者。
- **即时失效** — 模型 `write`/`edit` 命中 `<…>/skills/` 路径时立即刷新技能目录。
- **独立配置页** — 侧栏 → 插件 → 本插件卡片 → 配置，与内置插件配置页同一套 `--dsw-alias-*` token。

## 安装

### 从 npm 在线安装

```bash
dsh plugin --profile <profile> add @sidleo3/skill-filesystem-plus
```

`dsh plugin` 会把参数转发给 profile 目录里的 `pnpm`，并自动激活声明了 `dsh.bundle` 的包。装完重启 DSH 即可。

### 从本地 checkout 以 link 方式安装

```bash
git clone https://github.com/sidleo/skill-filesystem-plus.git
dsh plugin --profile <profile> add link:<仓库路径>
```

> 以 git 仓库方式安装（`pnpm add github:user/repo`）时，需在 profile 的 `pnpm-workspace.yaml` 里的 `allowBuilds` 中加入对应的包（pnpm 10+）。

## 使用：在 GUI 中按 preset 启用

1. 打开侧栏 **插件**，找到本插件卡片，进入它的**配置**页
2. 在「生效的预设」列表里勾选要接管的 preset（多选，只列出可接管的预设）
3. 勾选后写入 profile 的 `cordis.patch.yml`：新增一条 `- id: preset-<id>` 覆盖行，整份复制该预设的内置插件行、把 `skill-filesystem` 标为 `disabled: true`，并在末尾追加 `@sidleo3/skill-filesystem-plus/preset` 行
4. **重启 DSH** 后，新会话选择该 preset 时使用本插件的四层扫描发现技能
5. 取消勾选 = 只删除本插件那条覆盖行，其他 patch 条目一字不动

> 已运行中的会话不受勾选/取消影响（preset 组合在会话创建时固定）；改动对**之后新建**的会话生效。

## 配置

所有设置都在插件配置页里（**侧栏 → 插件 → 本插件 → 配置**）：

- 四个层级开关。
- 上级目录列表：拖动排序优先级、逐行删除。
- 当前会话 cwd 的扫描根实时预览。
- 调试面板：列出实际发现到的技能。
- 保存即写回并刷新技能目录。

配置持久化在 `~/.dsh/dsh-skill-filesystem-plus.json`（旧名 `dsh-skill-scan.json` 自动迁移）。

## 工作原理

1. **Install = no-op**：host 入口只暴露 GUI RPC + 声明 `Config` schema，不碰任何 preset
2. **User picks presets**：GUI 调 `/api/skill-filesystem-plus/presets/apply`，host 读取内置预设组合（`dsh-agent-preset` 声明式行的 `presets/<id>.patch.yml`）→ 备份 profile patch → 在 `cordis.patch.yml` 写入 `preset-<id>` 覆盖行（内置行逐行抄录，`skill-filesystem` 标 `disabled: true`，追加 `/preset` 行）
3. **Discovery**：该 preset 层里 `/preset` 行的 provider 在**该预设层**注册（`skills.registerProvider` 是 scope-aware），按四层扫描发现技能，完全替代内置发现
4. **Removal**：GUI 调 `/api/skill-filesystem-plus/presets/remove`，只删除本插件那条 `preset-<id>` 覆盖行
5. **Config live-reload**：provider 每次 `list` 都通过 `ctx.fs` 重读磁盘配置，GUI 保存后下一次目录刷新即生效

> patch 用的是 **replace** 语义（不是 merge），所以覆盖行必须整份复制该预设的插件行；编辑一律按**行**进行，绝不 parse→re-serialize——预设行含 `!!js` 标签（如 `disabled: !!js process.platform === 'win32'`），整份解析会把标签求值成字符串，`disabled` 变成真值导致 shell 工具静默消失。

## 为什么需要「替换」

DSH 对同名技能先按**层**再按 **rank** 裁决。只要内置 `skill-filesystem` 仍挂在预设层，同名的就会被它赢走，与你配置的 rank 无关——所以要让「重名按优先级」真正生效，必须把该 preset 的 `skill-filesystem` 行禁用、改由本插件 provider 提供。

## 开源说明

本仓库是**正式包形态**，代码先在 DSH 动态插件（`skf-1`）中实测通过后迁入。`src/` 是正式包源码；`skill-scan-blueprint/` 保留更名前的动态插件形态作参考（不参与构建）。

自行发布：

```bash
pnpm install
pnpm build      # tsdown → lib/index.js + lib/preset.js + lib/client.js
npm publish
```

> 宿主端依赖 DSH 私有包（`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-agent-preset`、`@deepseek-ai/dsh-agent-preset-registry` 等）。请在能解析到这些包的环境中构建；本包将其声明为 `peerDependencies` / `devDependencies`。

## 兼容性

适配 **DSH 0.1.7-alpha** 起：

- 配置页位于侧栏插件页的 `plugins.bundle.config` 插槽（0.1.7 起 Settings 的「插件」分区变为只读内置清单，旧的 `settings.plugin.item` 插槽已不存在）
- 预设接管通过 profile 的 `cordis.patch.yml` 覆盖行实现（`agentPresetRegistry` 的 `list()`/`resolve()` 只返回展示元信息，没有组合路径、没有 read/write）
- 配置数据仍存本插件自己的 `~/.dsh/dsh-skill-filesystem-plus.json`

## License

MIT
