/**
 * skill-filesystem-plus preset manager — @sidleo3/skill-filesystem-plus
 *
 * Per-preset takeover of skill discovery.
 *
 * A preset is a declarative `@deepseek-ai/dsh-agent-preset` Loader row, and
 * `@deepseek-ai/dsh-agent-preset-registry` neither scans directories nor
 * accepts preset paths: its `list()`/`resolve()` return display metadata only
 * — no composition path, no read, no write. Overriding a shipped preset is
 * therefore a **bundle patch**: a `preset-<id>` override entry in the
 * profile's `cordis.patch.yml`.
 *
 * Enabling one preset writes that override row: it replaces the preset's whole
 * `plugins` list (patch semantics are replace, not merge), so the row copies
 * every shipped plugin row verbatim with the built-in `skill-filesystem` row
 * disabled and the `/preset` provider row appended. Disabling removes exactly
 * our own row and leaves every other patch entry byte-identical, so other
 * plugins' takeovers and the user's own overrides survive.
 *
 * Editing is LINE-BASED, not parse→re-serialize: both the shipped composition
 * and the profile patch carry `!!js` custom tags (e.g.
 * `disabled: !!js process.platform === 'win32'`), which a full round-trip
 * would evaluate to plain strings — `disabled` would then read as a truthy
 * string and the shell tools would silently disappear. Every copied row is
 * preserved as literal text; only indentation is interpreted.
 *
 * Runs only in the formal host, which holds full `ctx` (`ctx.profileContext`,
 * `ctx.agentPresets`, `node:fs`).
 *
 * @module @sidleo3/skill-filesystem-plus/wizard
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'

/** The preset row id the skill-filesystem-plus provider row registers under. */
export const PIPELINE_ROW_ID = 'skill-filesystem-plus-pipeline'
/** Package subpath the provider row loads. */
export const PIPELINE_PACKAGE = '@sidleo3/skill-filesystem-plus/preset'
/** Row id of the built-in local skill provider inside each preset. */
const BUILTIN_ROW_ID = 'skill-filesystem'
/** Module name of the declarative preset row we override. */
const PRESET_MODULE = '@deepseek-ai/dsh-agent-preset'
/** Bundle that ships the built-in preset declarations. */
const WEB_APP_PACKAGE = '@deepseek-ai/dsh-web-app'

/** Minimal host-context shape for the wizard (profile patch + write hook). */
export interface WizardContext {
  get(name: string): unknown
  /** Optional patch write hook. Tests stub this to avoid touching the filesystem. */
  writeComposition?(id: string, content: string): Promise<void>
}

interface AgentPresetInfo {
  id: string
  name?: string
  description?: string
  order?: number
}

interface AgentPresetsService {
  list(): Promise<AgentPresetInfo[]>
}

/** One shipped plugin row, preserved as literal text. */
interface ShippedRow {
  id: string
  /** Row lines dedented to the row level, `- id:` first. */
  lines: string[]
}

function agentPresets(ctx: WizardContext): AgentPresetsService | undefined {
  return ctx.get('agentPresets') as AgentPresetsService | undefined
}

/** The profile's patch document path, or undefined when no managed profile is active. */
function profilePatchPath(ctx: WizardContext): string | undefined {
  const profile = ctx.get('profileContext') as { patchPath?: string; dir?: string } | undefined
  if (profile?.patchPath !== undefined) return profile.patchPath
  return profile?.dir === undefined ? undefined : join(profile.dir, 'cordis.patch.yml')
}

/**
 * Backup file path, kept beside the patch the takeover wrote so the audit
 * trail travels with the profile rather than with a preset directory that no
 * longer exists.
 */
function backupPath(patchPath: string): string {
  return join(dirname(patchPath), '.skill-filesystem-plus-backup', 'cordis.patch.yml')
}

/**
 * Locate every patch file that can declare a preset.
 *
 * A preset is declared by an `@deepseek-ai/dsh-agent-preset` row inside any
 * bundle patch, not only the ones shipped in `dsh-web-app/presets`. A user
 * profile adds its own preset bundles (`@local/dsh-yh-standard-preset` and
 * friends), and those declare their preset in a plain `./cordis.patch.yml`.
 * Enumerating only the shipped directory would silently drop every custom
 * preset from the roster.
 *
 * Resolution starts from this plugin's own location (the plugin is installed
 * inside the profile, so its `node_modules` chain reaches the harness), with
 * the profile directory as a fallback for installs that hoist it elsewhere.
 *
 * @returns absolute patch paths, shipped presets first.
 */
async function presetPatchFiles(ctx: WizardContext): Promise<string[]> {
  const profile = ctx.get('profileContext') as { dir?: string; startedBundles?: readonly string[] } | undefined
  const bases = [import.meta.url, profile?.dir === undefined ? undefined : join(profile.dir, 'package.json')]
    .filter((value): value is string => typeof value === 'string')
  const out: string[] = []
  const seen = new Set<string>()

  const push = (path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    out.push(path)
  }

  // 1. Shipped presets: always present, so the roster never depends on the
  //    profile manifest being readable.
  for (const base of bases) {
    try {
      const directory = join(dirname(createRequire(base).resolve(`${WEB_APP_PACKAGE}/package.json`)), 'presets')
      for (const entry of await readdir(directory)) {
        if (entry.endsWith('.patch.yml')) push(join(directory, entry))
      }
      break
    } catch { /* try the next base */ }
  }

  // 2. Every bundle the profile composes, so custom preset bundles count too.
  const bundles = profile?.startedBundles ?? (await readProfileBundles(profile?.dir))
  for (const bundle of bundles) {
    for (const base of bases) {
      try {
        const manifestPath = createRequire(base).resolve(`${bundle}/package.json`)
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
        const declared = manifest.dsh?.bundle?.patch
        const list = Array.isArray(declared) ? declared : (declared === undefined ? [] : [declared])
        for (const entry of list) {
          if (typeof entry !== 'string') continue
          push(join(dirname(manifestPath), entry))
        }
        break
      } catch { /* this base cannot resolve the bundle */ }
    }
  }
  return out
}

/** Read the profile's composed bundle list from its own manifest. */
async function readProfileBundles(profileDir: string | undefined): Promise<readonly string[]> {
  if (profileDir === undefined) return []
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = manifest.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((b): b is string => typeof b === 'string') : []
  } catch {
    return []
  }
}

/** Strip one layer of matching quotes from a YAML scalar. */
function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Parse the plugin rows out of a `plugins:` list body.
 *
 * Line-oriented on purpose: the patch carries `!!js` tags that a YAML
 * round-trip would evaluate and rewrite, so only indentation is interpreted
 * here and every scalar is preserved as literal text.
 *
 * @param raw - the patch file's lines.
 * @param startIndex - line index of the `plugins:` key, or -1 when absent.
 * @returns one row per `- id:` entry, dedented to the row level.
 */
function parsePluginRowsAt(raw: string[], startIndex: number): ShippedRow[] {
  if (startIndex < 0) return []
  const keyIndent = /^(\s*)plugins:/.exec(raw[startIndex])?.[1].length ?? 0
  const body: string[] = []
  for (let i = startIndex + 1; i < raw.length; i++) {
    const line = raw[i]
    if (line.trim() === '') {
      body.push(line)
      continue
    }
    if ((/^(\s*)/.exec(line)?.[1].length ?? 0) <= keyIndent) break
    body.push(line)
  }
  const nonEmpty = body.filter(line => line.trim() !== '')
  const minIndent = nonEmpty.length === 0
    ? 0
    : Math.min(...nonEmpty.map(line => /^(\s*)/.exec(line)?.[1].length ?? 0))
  const dedented = body.map(line => (line.trim() === '' ? '' : line.slice(minIndent)))
  const rows: ShippedRow[] = []
  let current: string[] | undefined
  for (const line of dedented) {
    if (/^-\s+id:/.test(line)) {
      if (current !== undefined) rows.push(toRow(current))
      current = [line]
    } else if (current !== undefined) {
      current.push(line)
    }
  }
  if (current !== undefined) rows.push(toRow(current))
  return rows
}

/** One preset declared by a patch file, with its plugin composition. */
interface DeclaredPreset {
  id: string
  rows: ShippedRow[]
}

/**
 * Find every preset declared by one patch file.
 *
 * A patch may nest its rows under `- insert:` (shipped and custom preset
 * bundles both do), so handle both shapes: each `- id: <x>` row whose `name`
 * is the preset module declares a preset, and the `plugins:` key that follows
 * at a deeper indent is that preset's composition.
 */
function parseDeclaredPresets(text: string): DeclaredPreset[] {
  const raw = text.split(/\r?\n/)
  const out: DeclaredPreset[] = []
  for (let i = 0; i < raw.length; i++) {
    const opener = /^(\s*)-\s+id:\s*(['"]?)([^'"]*)\2\s*$/.exec(raw[i])
    if (opener === null) continue
    const idIndent = opener[1].length
    // The row body ends at the next line at or above the row's own indent.
    let end = raw.length
    for (let j = i + 1; j < raw.length; j++) {
      const line = raw[j]
      if (line.trim() === '') continue
      if ((/^(\s*)/.exec(line)?.[1].length ?? 0) <= idIndent) { end = j; break }
    }
    const rowLines = raw.slice(i, end)
    const isPresetRow = rowLines.some(line => /^\s+name:\s*['"]?@deepseek-ai\/dsh-agent-preset['"]?\s*$/.test(line))
    if (!isPresetRow) continue
    // The roster keys on the preset's own `config.id`, NOT the row id: the
    // shipped rows are `preset-standard` while the preset id is `standard`,
    // and a custom bundle may name its row anything.
    const configId = readNestedId(rowLines)
    if (configId === undefined) continue
    const pluginsAt = rowLines.findIndex(line => /^\s+plugins:\s*$/.test(line))
    if (pluginsAt < 0) continue
    out.push({ id: configId, rows: parsePluginRowsAt(rowLines, pluginsAt) })
    i = end - 1
  }
  return out
}

/**
 * Read the `config.id` value out of one declared preset row.
 *
 * @param rowLines - the row's lines, relative to the row opener.
 * @returns the declared preset id, or undefined when the row carries none.
 */
function readNestedId(rowLines: string[]): string | undefined {
  const configAt = rowLines.findIndex(line => /^\s+config:\s*$/.test(line))
  if (configAt < 0) return undefined
  const configIndent = /^(\s*)config:/.exec(rowLines[configAt])?.[1].length ?? 0
  for (let i = configAt + 1; i < rowLines.length; i++) {
    const line = rowLines[i]
    if (line.trim() === '') continue
    const indent = /^(\s*)/.exec(line)?.[1].length ?? 0
    if (indent <= configIndent) return undefined
    const id = /^\s+id:\s*(.+?)\s*$/.exec(line)
    if (id !== null) return unquote(id[1])
  }
  return undefined
}

/** Build one shipped row, dropping the trailing blank lines the body may carry. */
function toRow(lines: string[]): ShippedRow {
  const trimmed = [...lines]
  while (trimmed.length > 0 && trimmed[trimmed.length - 1].trim() === '') trimmed.pop()
  const head = /^-\s+id:\s*(.+?)\s*$/.exec(trimmed[0] ?? '')
  return { id: head === null ? '' : unquote(head[1]), lines: trimmed }
}

/**
 * Read every shipped preset's plugin composition.
 *
 * A preset whose patch file is missing or unreadable is simply absent from the
 * map; the caller treats that as "cannot take over" rather than inventing rows.
 */
async function listPresetCompositions(ctx: WizardContext): Promise<Map<string, ShippedRow[]>> {
  const out = new Map<string, ShippedRow[]>()
  // A patch file may declare several presets (one `- insert:` list, or several
  // top-level rows), and a preset id is what the roster keys on — so read the
  // id out of each declared `dsh-agent-preset` row rather than from the
  // filename. That also covers custom preset bundles whose patch file is named
  // `cordis.patch.yml`.
  for (const path of await presetPatchFiles(ctx)) {
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch { continue }
    for (const declared of parseDeclaredPresets(text)) {
      if (!out.has(declared.id)) out.set(declared.id, declared.rows)
    }
  }
  return out
}

/** One preset in the roster with its takeover status. */
export interface PresetStatus {
  id: string
  name: string
  description?: string
  trust: string
  /** True when a backup of the original patch exists. */
  backupExists: boolean
  /** True when our override row is present with the pipeline row enabled. */
  pipelineActive: boolean
  /** True when the override row's built-in skill-filesystem row is disabled. */
  builtinDisabled: boolean
  /** True when takeover is fully in effect: pipeline active and builtin disabled. */
  enabled: boolean
  /** True when this preset can be taken over (it carries the built-in row). */
  hasSkillFilesystem: boolean
}

/** Structured takeover state of one preset, read from the profile patch. */
export interface TakeoverState {
  backupExists: boolean
  pipelineActive: boolean
  builtinDisabled: boolean
  hasSkillFilesystem: boolean
}

const EMPTY_STATE: TakeoverState = {
  backupExists: false,
  pipelineActive: false,
  builtinDisabled: false,
  hasSkillFilesystem: false,
}

/** The `- id:` value of a top-level patch entry. */
function patchEntryId(row: unknown): string | undefined {
  if (row === null || typeof row !== 'object') return undefined
  const value = (row as { id?: unknown }).id
  return typeof value === 'string' ? value : undefined
}

/**
 * Read the takeover state of one preset from the profile patch.
 *
 * Parsing is read-only here: `!!js` tags resolve to plain strings, which is
 * harmless for inspection — we compare `disabled === true` strictly, so a tag
 * string can never be mistaken for a disabled row.
 */
export async function readTakeoverState(
  ctx: WizardContext,
  presetId: string,
): Promise<TakeoverState> {
  const patchPath = profilePatchPath(ctx)
  if (patchPath === undefined) return EMPTY_STATE
  let backupExists = false
  try {
    await readFile(backupPath(patchPath), 'utf8')
    backupExists = true
  } catch { /* no backup */ }
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    return { ...EMPTY_STATE, backupExists }
  }
  let rows: unknown
  try {
    rows = parseDocument(text).toJS()
  } catch {
    return { ...EMPTY_STATE, backupExists }
  }
  if (!Array.isArray(rows)) return { ...EMPTY_STATE, backupExists }
  const override = rows.find(row => patchEntryId(row) === 'preset-' + presetId)
  if (override === null || typeof override !== 'object') return { ...EMPTY_STATE, backupExists }
  const plugins = (override as { config?: { plugins?: unknown } }).config?.plugins
  if (!Array.isArray(plugins)) return { ...EMPTY_STATE, backupExists }
  let pipelineActive = false
  let builtinDisabled = false
  let hasSkillFilesystem = false
  for (const plugin of plugins) {
    const id = patchEntryId(plugin)
    const disabled = (plugin as { disabled?: unknown }).disabled === true
    if (id === PIPELINE_ROW_ID) pipelineActive = !disabled
    if (id === BUILTIN_ROW_ID) {
      hasSkillFilesystem = true
      if (disabled) builtinDisabled = true
    }
  }
  return { backupExists, pipelineActive, builtinDisabled, hasSkillFilesystem }
}

/** Current takeover state of every shipped preset. */
export async function listPresets(ctx: WizardContext): Promise<PresetStatus[]> {
  const ap = agentPresets(ctx)
  if (ap === undefined) return []
  const presets = await ap.list()
  const compositions = await listPresetCompositions(ctx)
  const out: PresetStatus[] = []
  for (const p of presets) {
    const shippedHasBuiltin = compositions.get(p.id)?.some(row => row.id === BUILTIN_ROW_ID) ?? false
    const takeover = await readTakeoverState(ctx, p.id)
    out.push({
      id: p.id,
      name: p.name ?? p.id,
      description: p.description,
      trust: 'shipped',
      backupExists: takeover.backupExists,
      pipelineActive: takeover.pipelineActive,
      builtinDisabled: takeover.builtinDisabled,
      enabled: takeover.pipelineActive && takeover.builtinDisabled,
      hasSkillFilesystem: shippedHasBuiltin || takeover.hasSkillFilesystem,
    })
  }
  return out
}

/**
 * Split a patch document into top-level blocks.
 *
 * Blocks open at a `- id:` or `- insert:` line (column 0 only); every deeper
 * line belongs to its block. Everything before the first block (the file's
 * header comment) is kept as a leading block, and blank lines *between* blocks
 * are appended to the block that precedes them — so rebuilding reproduces the
 * original document with only our own block added or removed.
 */
interface RowBlock {
  lines: string[]
  /** The row's id ('' for the leading header / an `insert` block). */
  key: string
  /** True for the leading pre-first-block region (never matched as a row). */
  header?: boolean
}

function splitRows(text: string): RowBlock[] {
  const raw = text.split(/\r?\n/)
  // A trailing EOL yields a final '' that is not a line; drop it so re-joining
  // reproduces the original file ending exactly.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop()
  const blocks: RowBlock[] = []
  let current: RowBlock | undefined
  const flush = () => {
    if (current !== undefined && current.lines.length > 0) blocks.push(current)
    current = undefined
  }
  for (const line of raw) {
    const opener = /^-\s+id:\s*(['"]?)([^'"]*)\1\s*$/.exec(line)
    const isInsert = /^-\s+insert:\s*$/.test(line)
    if (opener !== null || isInsert) {
      flush()
      current = { lines: [line], key: opener === null ? '' : opener[2] }
    } else if (current !== undefined) {
      current.lines.push(line)
    } else {
      // Before the first block: start the header block instead of dropping it.
      current = { lines: [line], key: '', header: true }
    }
  }
  flush()
  return blocks
}

/**
 * Rebuild the document from blocks.
 *
 * `splitRows` already dropped the trailing `''` produced by the final EOL, so
 * joining with `eol` plus one trailing `eol` reproduces a file that ended with
 * a newline. A block whose own last line is blank (a trailing comment region
 * separated by a blank line) must NOT also gain that trailing `eol`, or each
 * write would grow the file by one empty line.
 */
function joinRows(blocks: RowBlock[], eol: '\n' | '\r\n', trailingEol: boolean): string {
  const lines = blocks.flatMap(block => block.lines)
  const body = lines.join(eol)
  const endsBlank = lines.length > 0 && lines[lines.length - 1].trim() === ''
  if (!trailingEol) return body
  return endsBlank ? body : body + eol
}

function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Re-indent one shipped row under the override row's `plugins:` key. */
function pluginRowLines(row: ShippedRow, disable: boolean): string[] {
  const out = row.lines.map(line => (line.trim() === '' ? '' : '      ' + line))
  if (disable) {
    const nameIndex = out.findIndex(line => /^\s+name:/.test(line))
    const disabledIndex = out.findIndex(line => /^\s+disabled:/.test(line))
    if (disabledIndex >= 0) out[disabledIndex] = '        disabled: true'
    else if (nameIndex >= 0) out.splice(nameIndex + 1, 0, '        disabled: true')
  }
  return out
}

/**
 * Enable takeover for one preset: write a `preset-<id>` override row into the
 * profile patch that copies the shipped composition with the built-in
 * `skill-filesystem` row disabled and the provider row appended.
 *
 * Line-based: the new block is authored explicitly and every pre-existing
 * block is emitted verbatim, so `!!js` tags elsewhere in the patch stay intact.
 */
export async function applyPreset(
  ctx: WizardContext,
  presetId: string,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(presetId)) return { ok: false, error: '预设 id 非法' }
  const patchPath = profilePatchPath(ctx)
  if (patchPath === undefined) {
    return { ok: false, error: 'profileContext 不可用：无法定位 profile 的 cordis.patch.yml' }
  }
  const ap = agentPresets(ctx)
  if (ap === undefined) return { ok: false, error: 'agentPresets 服务不可用' }
  const preset = (await ap.list()).find(p => p.id === presetId)
  if (preset === undefined) return { ok: false, error: '预设不存在: ' + presetId }
  const composition = (await listPresetCompositions(ctx)).get(presetId)
  if (composition === undefined || composition.length === 0) {
    return { ok: false, error: '读取预设 ' + presetId + ' 的组合失败，停止接管' }
  }
  if (!composition.some(row => row.id === BUILTIN_ROW_ID)) {
    return { ok: false, error: '预设 ' + presetId + ' 不含 skill-filesystem 行，无需接管' }
  }
  const existing = await readTakeoverState(ctx, presetId)
  if (existing.pipelineActive && existing.builtinDisabled) {
    return { ok: true, message: '预设 ' + presetId + ' 已生效' }
  }
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    text = ''
  }
  if (!existing.backupExists && text.length > 0) {
    try {
      await mkdir(dirname(backupPath(patchPath)), { recursive: true })
      await writeFile(backupPath(patchPath), text, 'utf8')
    } catch (error) {
      return { ok: false, error: '备份 profile patch 失败: ' + (error instanceof Error ? error.message : String(error)) }
    }
  }
  const eol = detectEol(text)
  const trailingEol = text === '' || text.endsWith('\n')
  const blocks = splitRows(text)
  const rowId = 'preset-' + presetId
  const prior = blocks.findIndex(block => !block.header && block.key === rowId)
  if (prior >= 0) blocks.splice(prior, 1)
  const lines = [
    `- id: ${rowId}`,
    `  name: ${JSON.stringify(PRESET_MODULE)}`,
    '  config:',
    `    id: ${presetId}`,
  ]
  if (preset.order !== undefined) lines.push(`    order: ${preset.order}`)
  if (preset.name !== undefined) lines.push(`    name: ${JSON.stringify(preset.name)}`)
  if (preset.description !== undefined) lines.push(`    description: ${JSON.stringify(preset.description)}`)
  lines.push('    plugins:')
  for (const row of composition) lines.push(...pluginRowLines(row, row.id === BUILTIN_ROW_ID))
  lines.push(`      - id: ${PIPELINE_ROW_ID}`, `        name: ${JSON.stringify(PIPELINE_PACKAGE)}`)
  // Our override must come last so it wins over any earlier preset row; skip a
  // blank separator line if the previous block already ends with one.
  const last = blocks[blocks.length - 1]
  if (last !== undefined && last.lines[last.lines.length - 1].trim() !== '') lines.unshift('')
  blocks.push({ lines, key: rowId })
  const edited = joinRows(blocks, eol, trailingEol)
  try {
    if ('writeComposition' in ctx) {
      await (ctx as { writeComposition(id: string, content: string): Promise<void> }).writeComposition(presetId, edited)
    } else {
      await writeFile(patchPath, edited, 'utf8')
    }
  } catch (error) {
    return { ok: false, error: '写入 profile patch 失败: ' + (error instanceof Error ? error.message : String(error)) }
  }
  return { ok: true, message: '预设 ' + presetId + ' 已接管：skill-filesystem 已禁用，skill-filesystem-plus 已接管。重启 DSH 后对新建会话生效。' }
}

/**
 * Disable takeover for one preset: remove exactly our own `preset-<id>`
 * override row. Every other patch entry — other plugins' inserts, managed
 * regions, the user's overrides — is emitted byte-identical.
 */
export async function removePreset(
  ctx: WizardContext,
  presetId: string,
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const patchPath = profilePatchPath(ctx)
  if (patchPath === undefined) {
    return { ok: false, error: 'profileContext 不可用：无法定位 profile 的 cordis.patch.yml' }
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(presetId)) return { ok: false, error: '预设 id 非法' }
  let text: string
  try {
    text = await readFile(patchPath, 'utf8')
  } catch {
    return { ok: true, message: '预设 ' + presetId + ' 未生效，无需取消' }
  }
  const eol = detectEol(text)
  const trailingEol = text.endsWith('\n')
  const blocks = splitRows(text)
  const rowId = 'preset-' + presetId
  const index = blocks.findIndex(block => !block.header && block.key === rowId)
  if (index < 0) return { ok: true, message: '预设 ' + presetId + ' 未生效，无需取消' }
  blocks.splice(index, 1)
  const edited = joinRows(blocks, eol, trailingEol)
  try {
    if ('writeComposition' in ctx) {
      await (ctx as { writeComposition(id: string, content: string): Promise<void> }).writeComposition(presetId, edited)
    } else {
      await writeFile(patchPath, edited, 'utf8')
    }
  } catch (error) {
    return { ok: false, error: '写入 profile patch 失败: ' + (error instanceof Error ? error.message : String(error)) }
  }
  return { ok: true, message: '预设 ' + presetId + ' 已取消：已移除本插件的接管行，其余配置保持不变。' }
}
