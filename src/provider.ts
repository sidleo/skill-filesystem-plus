/**
 * skill-filesystem-plus shared provider logic — @sidleo3/skill-filesystem-plus
 *
 * Builds the SkillProvider implementation and the scan helpers. Both the host
 * entry (for RPC previews) and the per-preset row (src/preset.ts) construct
 * providers from this module, so discovery behavior stays identical wherever
 * the plugin is composed.
 *
 * @module @sidleo3/skill-filesystem-plus/provider
 */

import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'
import type { SkillProvider, SkillProviderControl, SkillCandidate, SkillDefinition } from '@deepseek-ai/dsh-skill'
import type { SkillScanConfig } from './config.ts'

/** Minimal `ctx`-provided `fs` surface used by the provider. */
export interface ProviderFs {
  resolve(p: string): Promise<unknown>
  stat(t: unknown): Promise<unknown>
  readText(t: unknown): Promise<string>
  listDir(t: unknown): Promise<Array<{ type: string; name: string; target: { displayPath: string } }>>
}

/** Minimal host-context shape this provider reads (fs, dshHomePath). */
export interface ScanContext {
  get(name: string): unknown
}

export interface SkillRoot { root: string; rank: number; source: string }
export interface ParsedSkill {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  content: string
  /** Absolute path of the skill file (SKILL.md or flat .md). */
  path: string
}

/** A function that resolves the DSH home directory (e.g. `~/.dsh`), or undefined. */
export type HomeResolver = () => string | undefined

export function frontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true': case 'yes': case 'on': case '1': return true
      case 'false': case 'no': case 'off': case '0': return false
    }
  }
  return undefined
}

export async function decodeSkill(
  fs: ProviderFs | undefined,
  path: string | undefined,
): Promise<ParsedSkill | undefined> {
  if (fs === undefined || path === undefined) return undefined
  let raw: string
  try { raw = await fs.readText(await fs.resolve(path)) } catch { return undefined }
  let doc: ReturnType<typeof parseDocument>
  try { doc = parseDocument(raw) } catch { return undefined }
  const data = (() => { try { return (doc.toJSON() ?? {}) as Record<string, unknown> } catch { return {} as Record<string, unknown> } })()
  const n = data.name
  const desc = data.description
  const whenToUse = data.whenToUse
  if (typeof n !== 'string' || typeof desc !== 'string' || n.length === 0 || desc.length === 0) return undefined
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n)) return undefined
  const body = raw.split('---', 3).slice(2).join('---').replace(/^\n+/, '')
  return {
    name: n,
    description: desc,
    ...(typeof whenToUse === 'string' && whenToUse.length > 0 ? { whenToUse } : {}),
    modelInvocable: frontmatterBoolean(data['disable-model-invocation']) !== true,
    userInvocable: frontmatterBoolean(data['user-invocable']) !== false,
    content: body,
    path,
  }
}

export async function listRoot(
  fs: ProviderFs | undefined,
  rootPath: string,
): Promise<ParsedSkill[]> {
  const out: ParsedSkill[] = []
  if (fs === undefined) return out
  let target
  try { target = await fs.resolve(rootPath) } catch { return out }
  if ((await fs.stat(target)) === undefined) return out
  let entries
  try { entries = await fs.listDir(target) } catch { return out }
  for (const entry of entries) {
    // Dot-entries are never skills: they are tooling state and editor/backup
    // residue that happens to sit beside real skills. A directory like
    // `.retail-business-report.bak.20260609_113104/` carries a `SKILL.md`
    // whose frontmatter repeats the live skill's `name`, so scanning it adds a
    // same-name, same-rank duplicate and the winner is decided by scan order —
    // an old backup can shadow the real skill. The scan ROOTS are unaffected:
    // `.dsh`/`.agents`/`.pi` are path components chosen by config, not
    // entries listed here.
    if (entry.name.startsWith('.')) continue
    if (entry.type === 'directory') {
      const s = await decodeSkill(fs, join(entry.target.displayPath, 'SKILL.md'))
      if (s) out.push(s)
    } else if (entry.type === 'file' && entry.name.endsWith('.md')) {
      const s = await decodeSkill(fs, entry.target.displayPath)
      if (s) out.push(s)
    }
  }
  return out
}

export interface ScanDeps {
  /** Optional `fs` service; absent disables all filesystem reads. */
  fs?: ProviderFs
  /** Resolve the USER home directory (global-layer base `~/<parentDir>/skills`). */
  home?: HomeResolver
  /**
   * Called with the resolved roots on every discovery, so a watcher can follow
   * the current scan layers (they change when the user edits the config).
   */
  onRoots?: (roots: readonly SkillRoot[]) => void
}

export async function computeRoots(
  cfg: SkillScanConfig,
  cwd: string | undefined,
  deps: ScanDeps,
): Promise<SkillRoot[]> {
  const roots: SkillRoot[] = []
  const seen = new Set<string>()
  const pushRoot = (base: string, rankBase: number, source: string): void => {
    if (!base) return
    for (let pi = 0; pi < cfg.parentDirs.length; pi++) {
      const name = cfg.parentDirs[pi].name
      if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') continue
      const root = join(base, name, 'skills')
      if (seen.has(root)) continue
      seen.add(root)
      roots.push({ root, rank: rankBase + pi, source })
    }
  }

  async function pathExists(full: string): Promise<boolean> {
    if (deps.fs === undefined) return false
    try { return (await deps.fs.stat(await deps.fs.resolve(full))) !== undefined } catch { return false }
  }
  async function projectRootOf(cwdPath: string): Promise<string> {
    let current = cwdPath
    for (let i = 0; i < 32; i++) {
      if (await pathExists(join(current, '.git'))) return current
      const parent = dirname(current)
      if (parent === current) return cwdPath
      current = parent
    }
    return cwdPath
  }

  if (cfg.scanCwd && cwd) pushRoot(cwd, 100, 'cwd')
  if (cwd) {
    if (cfg.scanProject) {
      pushRoot(await projectRootOf(cwd), 300, 'project')
    } else if (cfg.scanParents) {
      let base = dirname(cwd)
      for (let depth = 0; base && base.length > 1 && depth < 24; depth++) {
        pushRoot(base, 300 + depth * 10, 'parents')
        const parent = dirname(base)
        if (parent === base) break
        base = parent
      }
    }
  }
  if (cfg.scanGlobal) {
    const home = deps.home?.()
    if (home) pushRoot(home, 500, 'global')
  }
  roots.sort((a, b) => a.rank - b.rank)
  return roots
}

/**
 * Build a SkillProvider over the current config. `readConfig` is called on
 * every `list` (and may be async, allowing the preset row to re-read the
 * persisted GUI config through `ctx.fs`), so GUI changes take effect on the
 * next catalog refresh without a restart.
 */
export function makeSkillProvider(
  readConfig: () => SkillScanConfig | Promise<SkillScanConfig>,
  deps: ScanDeps,
  providerName = 'skill-filesystem-plus',
): SkillProvider {
  const provider: SkillProvider = {
    name: providerName,
    async list(options) {
      const cfg = await readConfig()
      const cwd = typeof options.cwd === 'string' && options.cwd.length > 0 ? options.cwd : undefined
      if (options.signal?.aborted) return []
      const roots = await computeRoots(cfg, cwd, deps)
      // Let the watcher follow the roots this scan actually used; it ignores
      // the call when the set is unchanged.
      try { deps.onRoots?.(roots) } catch { /* watching is best-effort */ }
      const candidates: SkillCandidate[] = []
      for (const r of roots) {
        if (options.signal?.aborted) return candidates
        for (const skill of await listRoot(deps.fs, r.root)) {
          const baseDir = skill.path.endsWith('SKILL.md')
            ? dirname(skill.path)
            : r.root
          candidates.push({
            name: skill.name,
            description: skill.description,
            ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
            invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
            provider: providerName,
            source: r.source,
            rank: r.rank,
            locator: { root: r.root, path: skill.path },
            resourceBase: { kind: 'directory' as const, path: baseDir },
            path: skill.path,
          })
        }
      }
      return candidates
    },
    async get(candidate): Promise<SkillDefinition | undefined> {
      await readConfig()
      const loc = candidate.locator as { root?: string; path?: string }
      const skillPath = loc?.path
      if (!skillPath) return undefined
      const skill = await decodeSkill(deps.fs, skillPath)
      if (!skill) return undefined
      const baseDir = skillPath.endsWith('SKILL.md') ? dirname(skillPath) : (loc.root ?? dirname(skillPath))
      return {
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse ? { whenToUse: skill.whenToUse } : {}),
        invocation: { modelInvocable: skill.modelInvocable, userInvocable: skill.userInvocable },
        source: candidate.source,
        provider: providerName,
        resourceBase: { kind: 'directory' as const, path: baseDir },
        path: skillPath,
        content: skill.content,
      }
    },
  }
  void provider
  return provider
}

/**
 * Resolve the DSH home (e.g. `~/.dsh`) from `dshHomePath` or environment
 * fallback. Used to locate the persisted config file.
 */
export function resolveDshHome(ctx: ScanContext): string | undefined {
  try {
    const hp = ctx.get('dshHomePath')
    if (typeof hp === 'function') return String(hp())
  } catch { /* fall through */ }
  try {
    const home = process.env.DSH_HOME?.trim() || process.env.HOME
    return home ? join(home, '.dsh') : undefined
  } catch {
    return undefined
  }
}

/**
 * Resolve the user home directory (e.g. `~`). Used as the base for the
 * global scan layer: `~/<parentDir>/skills` (`~/.dsh/skills`,
 * `~/.agents/skills`, `~/.pi/skills`, ...).
 */
export function resolveUserHome(ctx: ScanContext): string | undefined {
  try {
    const hp = ctx.get('dshHomePath')
    if (typeof hp === 'function') return dirname(String(hp()))
  } catch { /* fall through */ }
  try {
    const home = process.env.HOME
    return home || undefined
  } catch {
    return undefined
  }
}

/** Backward-compatible alias: DSH home (config location). */
export const resolveHome = resolveDshHome