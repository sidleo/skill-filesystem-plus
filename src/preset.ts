/**
 * skill-filesystem-plus per-preset provider row — @sidleo3/skill-filesystem-plus/preset
 *
 * Session-plane entry, inserted by the preset manager (src/wizard.ts) into a
 * copied agent preset next to the disabled `skill-filesystem` row. This row
 * registers the skill-filesystem-plus provider into THIS preset's layer of the skills
 * registry, replacing the built-in local discovery for exactly the presets
 * the user enabled.
 *
 * Discovery, precedence, and config follow the user-editable configuration
 * persisted by the host entry (src/index.ts); the persisted GUI config is
 * re-read on every `list` through `ctx.fs`, so a GUI change takes effect
 * on the next catalog refresh without a restart.
 *
 * @module @sidleo3/skill-filesystem-plus/preset
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { DEFAULT_CONFIG, normalizeConfig, type SkillScanConfig } from './config.ts'
import { makeSkillProvider, resolveDshHome, resolveUserHome, type ProviderFs } from './provider.ts'
import { SkillWatcher } from './watcher.ts'

export const name = 'skill-filesystem-plus'
export const inject = ['skills']

/** Current config file name stored under the DSH home (same as the host entry). */
const CONFIG_FILENAME = 'dsh-skill-filesystem-plus.json'
/** Legacy config file name from the pre-rename `@sidleo3/skill-scan` package. */
const LEGACY_CONFIG_FILENAME = 'dsh-skill-scan.json'

let cachedConfig: { key: string; config: SkillScanConfig } | undefined

/** Read the persisted config through `ctx.fs` (the preset-row environment
 * restricts node:fs synchronous reads). Reads the current file, falling back
 * to the legacy `dsh-skill-scan.json` so the user's scan layers / parent
 * dirs survive the package rename. Falls back to the preset-row snapshot. */
async function readConfigCached(
  ctx: Context,
  fallback: SkillScanConfig,
): Promise<SkillScanConfig> {
  try {
    const fileSystem = ctx.get('fs') as
      | { resolve(path: string): Promise<unknown>; readText(target: unknown): Promise<string> }
      | undefined
    if (fileSystem === undefined) return fallback
    const home = resolveDshHome(ctx as unknown as { get(name: string): unknown })
    if (home === undefined) return fallback
    const candidates = [CONFIG_FILENAME, LEGACY_CONFIG_FILENAME]
    let lastError: unknown
    for (const filename of candidates) {
      try {
        const path = home + '/' + filename
        const target = await fileSystem.resolve(path)
        const raw = await fileSystem.readText(target)
        const config = normalizeConfig(JSON.parse(raw))
        cachedConfig = { key: path, config }
        return config
      } catch (error) {
        lastError = error
      }
    }
    void lastError
    return cachedConfig?.config ?? fallback
  } catch {
    return cachedConfig?.config ?? fallback
  }
}

export function apply(ctx: Context, config: Partial<SkillScanConfig> = {}): void {
  const skills = ctx.get('skills')
  if (skills === undefined) return
  const fallback = normalizeConfig({ ...DEFAULT_CONFIG, ...config })

  const fs = ctx.get('fs') as ProviderFs | undefined
  let control: SkillProviderControl | undefined

  // Re-read the persisted config before each discovery so GUI saves take
  // effect on the next catalog refresh without a restart.
  const readConfig = (): Promise<SkillScanConfig> => readConfigCached(ctx, fallback)

  // Watch the discovered roots so skills added by an external IDE, git, or a
  // shell command reach the catalog: the first-party `fs/observed` events
  // below only cover the model's own writes. The watcher follows whatever
  // roots the latest scan used, so editing the scan layers re-arms it.
  const logger = (ctx as unknown as { logger?: { warn(message: string): void } }).logger
  const watcher = new SkillWatcher(() => control?.invalidate(), logger)

  const provider = makeSkillProvider(
    readConfig,
    {
      fs,
      home: () => resolveUserHome(ctx as unknown as { get(name: string): unknown }),
      onRoots: roots => { void watcher.observeRoots(roots.map(r => r.root)) },
    },
  )

  const unregister = skills.registerProvider((c) => { control = c; return provider })

  // `fs/observed` is augmented by dsh-fs, which this package does not depend
  // on at type level; cast to the runtime event shape.
  const emitObserved = (ctx as unknown as {
    on(name: string, listener: (target: unknown, obs: unknown, actor: unknown) => void): unknown
  }).on.bind(ctx)
  emitObserved('fs/observed', (_target: unknown, _obs: unknown, actor: unknown) => {
    const actorName = actor && typeof actor === 'object' && 'name' in actor ? (actor as { name?: unknown }).name as string | undefined : undefined
    if (actorName !== 'write' && actorName !== 'edit') return
    control?.invalidate()
  })

  // Cordis effect disposal: release every watcher handle on unload, or a
  // disabled preset would leak handles across reloads.
  const effect = (ctx as unknown as { effect?: (fn: () => () => void) => unknown }).effect
  if (typeof effect === 'function') {
    effect.call(ctx, () => () => { void watcher.dispose() })
  }

  void unregister
}