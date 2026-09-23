# skill-filesystem-plus 项目规范

> DeepSeek Harness（DSH）可配置技能发现插件（原 skill-scan）：替代内置 `dsh-skill-filesystem`，四层扫描 + 可编辑上级目录 + 优先级拖拽，配置页在 Web GUI **侧栏「插件」页**里。
>
> 本文件是本仓库的唯一指令来源，CLAUDE.md / CODEBUDDY.md 为指向它的软链接。本仓库位于用户项目根（`/Users/zhang3/yh_zhang3/`）AGENTS.md 作用域内；与此处冲突时，**本仓库 AGENTS.md 优先**。

## 项目是什么

- **包名**：`@sidleo3/skill-filesystem-plus`（v0.2.4）
- **仓库**：GitHub `sidleo/skill-filesystem-plus`（分支 `main`）
- **作用**：按 preset 选择性接管 DSH 技能发现。四个层级开关（cwd 最高 / 项目或上级遍历（互斥）/ 全局最低） + 用户可编辑上级目录名列表（拖拽排序，靠前优先），**只在用户勾选的 preset 中生效**（参考 `agent-instructions-plus` 架构）。
- **为什么需要 replace**：DSH 同名技能按 *layer*（层）优先于 *rank* 解析。内置 `skill-filesystem` 若仍挂载在预设层，同名师技能它永远赢——要按 rank 覆盖必须把该 preset 的 `skill-filesystem` 行禁用、改由本插件 `/preset` 行提供（见 `src/wizard.ts`）。

## 目录结构

| 路径 | 说明 |
|---|---|
| `src/index.ts` | **Host 入口**：`inject=['webServer']`；`export const Config`（schemastery schema，供 Loader 解析；**不再**注册 settings namespace）、webServer RPC（config/presets/roots/discover）、preset 接管管理；**不注册全局 provider** |
| `src/preset.ts` | **预设层行**（`@sidleo3/skill-filesystem-plus/preset`）：`inject=['skills']`；在该预设层注册 skill-filesystem-plus provider（`skills.registerProvider` scope-aware），每次 `list` 经 `ctx.fs` 重读磁盘配置 |
| `src/provider.ts` | 共享 provider 构造：`makeSkillProvider` / `computeRoots` / `listRoot` / `decodeSkill`（host 预览与 preset 行共用） |
| `src/watcher.ts` | **变更监视**：`SkillWatcher`——Chokidar 深度 1 监视已存在的根 + `fs.watchFile` 逐段探测缺失根，事件按微任务合并后 `invalidate()`（对齐内置 `dsh-skill-filesystem` 的行为） |
| `src/config.ts` | 配置类型 + `normalizeConfig` + `loadConfig`/`persistConfig`（`~/.dsh/dsh-skill-filesystem-plus.json`） |
| `src/client/index.ts` | **Client 入口**：`inject=['slots']`；注册进 `plugins.bundle.config`（key = 包名）→ 侧栏「插件」→ 本插件的**配置页**：preset 多选接管 + 四层开关 + 上级目录编辑 + 根预览 |
| `src/wizard.ts` | preset 接管管理：`applyPreset`/`removePreset`/`listPresets`/`readTakeoverState`——往 profile 的 `cordis.patch.yml` 写/删 `preset-<id>` 覆盖行（备份到 profile 旁 `.skill-filesystem-plus-backup/cordis.patch.yml`，host-only） |
| `tsdown.config.ts` | 三输出：Host ESM → `lib/index.js`；Preset ESM → `lib/preset.js`；Client CJS（ModuleLoader 契约）→ `lib/client.js` |
| `cordis.patch.yml` | `- insert: {id: skill-filesystem-plus, name:'@sidleo3/skill-filesystem-plus'}` |
| `skill-scan-blueprint/` | 早期动态插件形态参考副本（不参与构建，非当前代码） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 声明；peer deps 指向 `@deepseek-ai/*` 0.1.7-alpha 版（`dsh-agent-presets` 已改名为 `dsh-agent-preset` + `dsh-agent-preset-registry`） |

## 常用命令（务必用 pnpm）

```bash
pnpm build        # tsdown → lib/index.js + lib/preset.js + lib/client.js（lib/ 不入库）
pnpm typecheck    # tsc --noEmit
```

## 本地安装 / 生效流程（核心循环）

本机 profile `web` 通过 `link:` 指向本目录，**代码改动 → 重建 → 重启 DSH Web GUI** 生效：

1. 改 `src/` 下代码
2. `pnpm build`（lib 更新，link 自动反映）
3. **用户重启 DSH Web GUI 进程**（插件是 profile bundle，只有重启才重新合成加载）
4. 验证：**侧栏「插件」页 → 本插件卡片 → 配置**（配置页在那里，不在设置里）；或检查技能目录是否出现（如 `scan-demo`）

接线命令（若 profile 丢了插件声明）：

```bash
dsh plugin --profile web add link:/Users/zhang3/yh_zhang3/Project/dsh插件/skill-filesystem-plus
```

这会把 `@sidleo3/skill-filesystem-plus` 写进 `~/.dsh/profiles/web/package.json` 的 `dependencies` + `dsh.profile.bundles`。**两个都要在**，否则插件不会合成加载。

## 架构要点（改代码前先读）

### Host（src/index.ts）

- `apply(ctx, config)`：`let cfg = loadConfig(normalizeConfig(config))` —— **磁盘配置优先**于传入 config。
- **`export const Config`**：schemastery schema（四层开关 + parentDirs）。DSH 0.1.7 起 `SettingsForms` **已无 `register()`**，表单由每个 Loader 条目自己的 `Config` schema 生成、解析后传给 `apply(ctx, config)`。必须显式标注类型（`z<PluginConfig>`）：推断类型会引用 schemastery 内嵌的 cosmokit 私有路径，导致 dts 生成报 TS2742。**不要**再调 `settings.register(...)`（该方法已不存在）。
- **配置持久化**：`~/.dsh/dsh-skill-filesystem-plus.json`（`loadConfig` 读 / `persistConfig` 写，node:fs 直写，best-effort 不抛错）。POST 保存后立即落盘。
- webServer 路由（**路径必须唯一**，不能重复注册同一 path）：
  - `GET/POST /api/skill-filesystem-plus/config`（POST：normalize → persist）
  - `GET /api/skill-filesystem-plus/roots`（当前 session cwd 的扫描根预览）
  - `GET /api/skill-filesystem-plus/discover`（调试：根 + 实际发现列表）
  - `GET /api/skill-filesystem-plus/presets`（roster + 接管状态）
  - `POST /api/skill-filesystem-plus/presets/apply` / `POST /api/skill-filesystem-plus/presets/remove`
- **不注册全局 provider**：provider 只在被接管的预设层注册（`src/preset.ts`）。
- `fs` 是 `ctx.get('fs')` 可选服务；`dshHomePath` 是 ctx 提供的函数。

### Preset 行（src/preset.ts）

- 由 wizard 写进 profile 的 `cordis.patch.yml`：`preset-<id>` 覆盖行内列出该预设的**全部**插件行（patch 是 replace 语义），`skill-filesystem` 行 `disabled: true`，末尾追加本 pipeline 行。
- `inject=['skills']`；`skills.registerProvider` 注册到**该预设层**（scope-aware）。
- 每次 `list` 前经 `ctx.fs` 重读 `~/.dsh/dsh-skill-filesystem-plus.json`（preset 行环境限制 node:fs 同步读），GUI 保存后下一次目录刷新即生效。
- `ctx.on('fs/observed', ...)` 只在 actor 为 write/edit 时 `control.invalidate()`（模型自己的写入）。
- **外部改动（IDE / git / shell）靠 `SkillWatcher`**：`makeSkillProvider` 的 `onRoots` 回调在每次 `list` 把解析出的根报给 watcher，watcher 据此增删监视（所以改扫描层级会自动重新挂载）；Chokidar 事件按深度 1 过滤（扁平 `*.md`、`<name>/SKILL.md`、子目录增删），bundle 内 `references/`/`scripts/` 的编辑**不**触发失效。dispose 挂在 `ctx.effect` 上，避免卸载后泄漏句柄。

### Client（src/client/index.ts）

- DSH client 契约：CJS bundle 经 `window.__ModuleLoader__.load({id, factory})` 注册（tsdown banner/intro/footer 处理），`require("react")` 走模块表，不用 import。
- 通过 `ctx.get('slots')` + `slots.inject('plugins.bundle.config', ...)` 注册**配置页**（list slot，key = 包名 `@sidleo3/skill-filesystem-plus`）；数据来自 `fetch('/api/skill-filesystem-plus/*')`（RPC，不走 slots props）。
- **`settings.plugin.item` 在 0.1.7 已不存在**（设置里那个分区变成只读内置清单）。`slots.inject` 等的是插槽**声明**，注册进一个没人声明的插槽**静默不生效、不报错**——所以升级后「配置卡片突然没了但宿主 RPC 照常」就是这个原因。
- 页面自绘标题/图标/面包屑，本插件只渲染 `view: 'page'` 的表单体（不要自己画卡片外壳/折叠头）。

### 类型

`ScanContext` 是最小接口（`get(): unknown`）。`session/event` 与 `fs/observed` 事件键由 dsh-session / dsh-fs augment，本包类型层不依赖它们，监听处用 `as unknown as { on(...) }` cast。client 首行 `// @ts-nocheck`（DSH client 工厂是纯 JS）。

### 踩坑记录（改 provider 前必读）

- **预设接管必须写 profile patch，不能改预设文件**：0.1.7 起 `agentPresetRegistry.list()`/`resolve()` **只返回展示元信息**（`{id,name?,description?,order?,broken?}`），**没有 `path`、没有 `read()`、没有 `write()`**；旧的 `~/.dsh/.agent-presets/` 目录扫描也已取消（`resolve().path` / `read()` 会抛异常，被 `catch` 吞掉 → 接管状态全部读成「未接管」）。预设改为 profile `cordis.yml` 里的 `preset-<id>` 声明式行，覆盖要走 profile 的 `cordis.patch.yml`。
- **patch / 预设行只能按行编辑，绝不 parse→re-serialize**：这些 YAML 带 `!!js` 自定义标签（如 `disabled: !!js process.platform === 'win32'`），整份解析会把标签求值成普通字符串，`disabled` 变成真值 → **shell 工具静默消失**。复制内置行时逐行抄原文，只解释缩进。
- **patch 写盘必须与原文逐字节可比**：`splitRows` 要保留首个块之前的注释头（否则注释被吃掉），`joinRows` 遇到「最后一行本身是空行」时不能再补 `eol`（否则每次写盘多一个空行）。`apply → remove` 必须回到**完全相同**的字节。
- **预设组合要遍历 profile 的所有 bundle，不能只认 `dsh-web-app/presets/`**：自定义预设包（如 `@local/dsh-yh-standard-preset`）把自己的 preset 声明写在 `./cordis.patch.yml` 里，`dsh.bundle.patch` 并不含 `/presets/`。只用内置目录枚举会**静默漏掉所有自定义预设**（界面上被当作「不含 skill-filesystem 行」过滤）。做法：读 `profileContext.startedBundles`（回退 profile `package.json` 的 `dsh.profile.bundles`），逐个解析其 `dsh.bundle.patch` 指向的文件。
- **preset 的 key 是 `config.id`，不是 patch 行的 id**：内置行写成 `- id: preset-standard` 而预设 id 是 `standard`，自定义包的命名又各不同。用行 id 查注册表必然 miss（表现为「明明有 skill-filesystem 行却报 hasSkillFilesystem: false」）。要从 `config:` 段里读 `id`（`readNestedId`）。
- **`backupExists` 不是接管状态**：备份是审计留痕，取消接管后仍留着。拿它判定「接管不完整」会在每个曾被接管的预设上误报。只有「覆盖行在、但 pipelineActive 与 builtinDisabled 不一致」才算半途状态。
- **扫描根下的 `.` 开头条目必须跳过**：`skills/` 里常混着编辑器/备份残留（`~/.agents/skills/.retail-business-report.bak.20260609_113104/`），它们带着 `SKILL.md` 且 frontmatter 的 `name` 与真身相同 → 产生**同名同 rank 的重复**，同名由扫描顺序裁决，旧备份可能盖住真技能。注意与扫描根无关：`.dsh`/`.agents`/`.pi` 是配置里选的路径段，不是这里列出的条目。
- **Chokidar 事件路径是 realpath，比较必须用 anchor**：监视根若经过符号链接（macOS `/tmp` → `/private/tmp`），chokidar 上报的是**真实路径**，与配置路径不一致。用配置路径做包含判断会让 `relative()` 返回 `..` 开头 → 所有事件被静默丢弃（现象：watcher 建起来了、句柄正常、就是永远不触发）。`RootState.anchor` 记录实际监视路径，事件过滤用它。
- **`sameMode` 要比较 `nextPath`，不能只比 kind**：缺失根探测点是「最近的已存在祖先的下一段路径」，父目录出现后探测点必须下移一层；只比 kind 会让探测停在再也变不成根的位置。
- **`locator` 必须携带技能文件路径，不能只存 skills 根**：`list` 返回的每个 candidate 的 `locator` 要存 `{ root, path }`（`path` 是技能文件绝对路径，目录型为 `<root>/<name>/SKILL.md`，扁平型为 `<root>/<name>.md`）。`get` 用 `loc.path` 加载正文。若只存 `root`，`get` 会读 `root/SKILL.md`（不存在）返回 undefined → 用户 `/skill-name` 显式调用时 `skills.get` 拿不到定义，不注入 `skill-invocation`（表现：assistant 说"I don't see it in the available skills list"）。`resourceBase` 目录型指向技能目录（`dirname(path)`），扁平型指向 skills 根。
- **`disable-model-invocation: true` 的技能不出现在模型目录**：tool-skill 的 catalog 注入 `filter(isModelInvocable)`，此类技能只通过用户 `/name` 命令调用（走 `skill-invocation` 注入）。skill.list（`/` 命令面板）仍会列出（filter userInvocable）。这是设计，不是 bug。
- **`resolveDshHome` 与 `resolveUserHome` 语义不同**：读配置（`~/.dsh/dsh-skill-filesystem-plus.json`）用 `resolveDshHome`（`dshHomePath()` 本身）；global 扫描层 base（`~/<parentDir>/skills`）用 `resolveUserHome`（`dirname(dshHomePath())`）。混用会导致读不到配置（fallback 默认 parentDirs 无 .pi）或 global 根错误。

## npm 发布

```bash
npm publish    # prepack 自动 pnpm build
npm view @sidleo3/skill-filesystem-plus   # 验证
```

发布要求：
- npm 登录身份 `sidleo3`（scope 匹配用户名）
- ~/.npmrc 需配置 auth token（Granular Access Token，**Bypass 2FA 必须开启**）
- 包名 `@sidleo3/skill-filesystem-plus`，在线安装：`dsh plugin --profile <p> add @sidleo3/skill-filesystem-plus`