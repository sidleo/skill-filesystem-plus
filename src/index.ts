/**
 * skill-filesystem-plus Host entry — @sidleo3/skill-filesystem-plus
 *
 * A configurable skill discovery provider for DeepSeek Harness. Replaces the
 * fixed discovery of `dsh-skill-filesystem` — but only in presets the USER
 * explicitly enables. Installation changes nothing: this host entry exposes a
 * browser-facing JSON RPC surface (config get/set, roots preview, discovery
 * debug, preset takeover status and apply/remove). No preset is touched until
 * the user picks one in the GUI; removing a preset drops only this plugin's
 * override row.
 *
 * The configuration page lives on the sidebar Plugins page (the
 * `plugins.bundle.config` slot) and edits this plugin's own JSON file through
 * the RPC surface below.
 *
 * @module @sidleo3/skill-filesystem-plus
 */

import { readFileSync, writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CONFIG_FILE,
  DEFAULT_CONFIG,
  configFilePath,
  loadConfig,
  normalizeConfig,
  persistConfig,
  type SkillScanConfig,
} from './config.ts'
import { computeRoots, listRoot, resolveUserHome, type ProviderFs } from './provider.ts'
import {
  applyPreset,
  listPresets,
  readTakeoverState,
  removePreset,
  type PresetStatus,
  type TakeoverState,
} from './wizard.ts'

export type { SkillScanConfig, ParentDir } from './config.ts'
export { DEFAULT_CONFIG, normalizeConfig, loadConfig, persistConfig } from './config.ts'
export { makeSkillProvider, computeRoots, listRoot, decodeSkill } from './provider.ts'
export { SkillWatcher, DEFAULT_WATCH_CONFIG, type WatchConfig } from './watcher.ts'
export { applyPreset, removePreset, listPresets, readTakeoverState, type PresetStatus, type TakeoverState } from './wizard.ts'

export const name = 'skill-filesystem-plus'
// Hard dependency on the browser HTTP carrier so the GUI config endpoints
// are registered only after webServer is ready (same pattern as
// agent-instructions-plus).
export const inject = ['webServer'] as const

// ── Config schema ───────────────────────────────────────────────────
// `SettingsForms.register()` no longer exists in DSH 0.1.7 (the service now
// derives forms from each Loader entry's own `Config` schema), so the plugin
// declares its schema the standard way instead of registering a namespace.
// The Loader resolves this and hands the parsed values to `apply(ctx, config)`.
// The config surface itself still lives in this plugin's own JSON file
// (`~/.dsh/dsh-skill-filesystem-plus.json`), which takes precedence.
// Declared as a mutable interface: schemastery's inferred object type is
// mutable, and `SkillScanConfig`'s readonly members are not assignable to it.
// The explicit annotation also keeps the generated .d.ts portable — an
// inferred type would reference schemastery's vendored cosmokit through a
// pnpm-internal path.
export interface PluginConfig {
  scanCwd: boolean
  scanProject: boolean
  scanParents: boolean
  scanGlobal: boolean
  parentDirs: { name: string }[]
}

export const Config: z<PluginConfig> = z.object({
  scanCwd: z.boolean().default(true),
  scanProject: z.boolean().default(true),
  scanParents: z.boolean().default(false),
  scanGlobal: z.boolean().default(true),
  parentDirs: z.array(z.object({ name: z.string() })).default([{ name: '.dsh' }, { name: '.agents' }]),
})

// ── Plugin entry ────────────────────────────────────────────────────

export function apply(ctx: Context, config: SkillScanConfig = DEFAULT_CONFIG): void {
  // Disk config takes precedence over passed-in config.
  let cfg = loadConfig(normalizeConfig(config))
  let lastCwd: string | undefined

  // First-install config seed: write defaults so the GUI toggles match reality.
  const persisted = loadConfig()
  if (persisted === undefined) {
    const seeded = normalizeConfig({ ...DEFAULT_CONFIG })
    persistConfig(seeded)
    cfg = seeded
  }

  // ── HTTP RPC surface ────────────────────────────────────────────
  const webServer = ctx.get('webServer') as
    | { register(route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void }
    | undefined

  /** Drain a JSON request body into a string (lightweight read). */
  async function readBodyLight(req: { on?: (event: 'data' | 'end' | 'error', cb: (chunk?: Buffer) => void) => void }): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on?.('data', (chunk) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))) })
      req.on?.('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on?.('error', reject)
    })
  }

  function jsonResponse(res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, body: unknown): void {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  function jsonError(res: { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, message: string): void {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: message }))
  }

  const fs = ctx.get('fs') as ProviderFs | undefined
  const home = () => resolveUserHome(ctx as unknown as { get(name: string): unknown })

  if (webServer?.register) {
    // GET/POST /api/skill-filesystem-plus/config — current config / save config
    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/config',
      handler: async (req, res) => {
        const method = (req as { method?: string })?.method
        if (method === 'POST') {
          let parsed: unknown
          try {
            parsed = JSON.parse(await readBodyLight(req as { on?: (event: 'data' | 'end' | 'error', cb: (chunk?: Buffer) => void) => void }))
          } catch {
            return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, 'invalid JSON body')
          }
          try {
            cfg = normalizeConfig(parsed)
          } catch (error: unknown) {
            return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, error instanceof Error ? error.message : String(error))
          }
          persistConfig(cfg)
          return jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { ok: true, config: JSON.parse(JSON.stringify(cfg)) })
        }
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, JSON.parse(JSON.stringify(cfg)))
      },
    })

    // GET /api/skill-filesystem-plus/roots — scan root directories for a cwd
    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/roots',
      handler: async (req, res) => {
        const cwd = resolveCwdFromHttp(req)
        const roots = await computeRoots(cfg, cwd, { fs, home })
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { cwd, roots })
      },
    })

    // GET /api/skill-filesystem-plus/discover — scan and list skills
    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/discover',
      handler: async (req, res) => {
        const cwd = resolveCwdFromHttp(req)
        const roots = await computeRoots(cfg, cwd, { fs, home })
        const all = []
        for (const r of roots) for (const s of await listRoot(fs as ProviderFs, r.root)) all.push({ name: s.name, source: r.source, rank: r.rank })
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { cwd, roots, skills: all })
      },
    })

    // ── Preset takeover management ─────────────────────────────────
    // GET  /api/skill-filesystem-plus/presets          — roster + enabled status
    // POST /api/skill-filesystem-plus/presets/apply    — enable takeover for one preset
    // POST /api/skill-filesystem-plus/presets/remove   — disable takeover for one preset
    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/presets',
      handler: async (req, res) => {
        const presets: PresetStatus[] = await listPresets(ctx).catch((error: unknown) => {
          console.error('[skill-filesystem-plus] listPresets error:', error)
          return []
        })
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { presets })
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/presets/apply',
      handler: async (req, res) => {
        let parsed: { presetId?: string }
        try {
          parsed = JSON.parse(await readBodyLight(req as { on?: (event: 'data' | 'end' | 'error', cb: (chunk?: Buffer) => void) => void })) as { presetId?: string }
        } catch {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, 'invalid JSON body')
        }
        if (typeof parsed?.presetId !== 'string' || parsed.presetId.length === 0) {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, 'presetId 必填')
        }
        const result = await applyPreset(ctx, parsed.presetId).catch((error: unknown) => {
          console.error('[skill-filesystem-plus] applyPreset threw:', error)
          return { ok: false, error: 'applyPreset 异常: ' + (error instanceof Error ? error.message : String(error)), message: undefined }
        })
        if (!result.ok) {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, result.error ?? '启用失败')
        }
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { ok: true, message: result.message })
      },
    })

    webServer.register({
      kind: 'exact',
      path: '/api/skill-filesystem-plus/presets/remove',
      handler: async (req, res) => {
        let parsed: { presetId?: string }
        try {
          parsed = JSON.parse(await readBodyLight(req as { on?: (event: 'data' | 'end' | 'error', cb: (chunk?: Buffer) => void) => void })) as { presetId?: string }
        } catch {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, 'invalid JSON body')
        }
        if (typeof parsed?.presetId !== 'string' || parsed.presetId.length === 0) {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, 'presetId 必填')
        }
        const result = await removePreset(ctx, parsed.presetId).catch((error: unknown) => {
          console.error('[skill-filesystem-plus] removePreset threw:', error)
          return { ok: false, error: 'removePreset 异常: ' + (error instanceof Error ? error.message : String(error)), message: undefined }
        })
        if (!result.ok) {
          return jsonError(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, result.error ?? '取消失败')
        }
        jsonResponse(res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (body: string) => void }, { ok: true, message: result.message })
      },
    })
  } else {
    console.log('[skill-filesystem-plus] webServer unavailable — GUI config endpoints disabled')
  }

  /** Resolve cwd from the request query string (?cwd=…), session state, or workspace registry fallback. */
  function resolveCwdFromHttp(req: unknown): string {
    const url = (req as { url?: string })?.url
    if (typeof url === 'string') {
      const match = /[?&]cwd=([^&]+)/.exec(url)
      if (match) {
        try { return decodeURIComponent(match[1]) } catch { /* fall through */ }
      }
    }
    if (lastCwd) return lastCwd
    try {
      const registry = (ctx as unknown as Record<string, unknown>)['workspaceRegistry'] as
        { list?: () => Array<{ path?: string }> } | undefined
      const workspaces = registry?.list?.()
      if (Array.isArray(workspaces) && workspaces.length > 0) {
        const first = workspaces[0]
        if (first && typeof first.path === 'string' && first.path.length > 0) {
          lastCwd = first.path
          return first.path
        }
      }
    } catch { /* registry not available */ }
    return process.cwd()
  }

  // ── Track cwd from session events ───────────────────────────────
  // Cast to the runtime event shape: the `session/event` key is augmented by
  // dsh-session, which this package does not depend on at type level.
  (ctx as unknown as { on(name: string, listener: (session: unknown, event: { type?: string }) => void): void }).on('session/event', (_session, event) => {
    if (event.type === 'step/start') {
      const session = (_session as { header?: { cwd?: string } })
      if (session?.header?.cwd) lastCwd = session.header.cwd
    }
  })

  // NOTE: no host-plane provider registration. The skill-filesystem-plus provider runs
  // ONLY inside presets the user explicitly enabled (each copy carries the
  // /preset row). Installing or upgrading this bundle therefore changes
  // nothing until the user picks presets in the GUI — and removing a preset
  // restores the built-in skill-filesystem untouched.
}