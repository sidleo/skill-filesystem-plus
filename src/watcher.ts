/**
 * skill-filesystem-plus change watching — @sidleo3/skill-filesystem-plus
 *
 * Keeps a discovered skill catalog current when the filesystem changes outside
 * the first-party `write`/`edit` tools: an external IDE, git, or a shell
 * command. The built-in `dsh-skill-filesystem` covers this with Chokidar, and
 * without it a skill added on disk stays invisible until the next catalog
 * rebuild — the one substantive behaviour gap this module closes.
 *
 * Two responsibilities, mirroring the built-in provider's design:
 *
 *  - **Existing roots** are watched with Chokidar at depth 1. Only events that
 *    can change the catalog matter (a direct `<name>.md`, a direct
 *    `<name>/SKILL.md`, or a direct child directory appearing/disappearing);
 *    edits under `references/`, `scripts/` and friends are ignored so a skill's
 *    own resources do not churn the model's catalog.
 *  - **Missing roots** are probed one path segment at a time with
 *    `fs.watchFile`, walking up to the nearest existing ancestor. A root that
 *    does not exist yet (a `.claude/skills` directory the user has not created)
 *    is therefore picked up when it appears, without polling the whole tree.
 *
 * Events are coalesced per microtask batch into one invalidation. A watcher
 * that fails (or whose root disappears) is marked unhealthy and re-armed, so a
 * transient failure does not silently end change detection.
 *
 * @module @sidleo3/skill-filesystem-plus/watcher
 */

import { realpathSync, statSync, unwatchFile, watchFile } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import chokidar from 'chokidar'

/** Tuning for the watcher; all fields have working defaults. */
export interface WatchConfig {
  /** Use polling instead of native filesystem events. */
  usePolling: boolean
  /** Quiet period before an atomic write is reported. */
  stabilityThresholdMs: number
  /** Poll / probe interval, in milliseconds. */
  pollIntervalMs: number
  /** Upper bound on simultaneously watched roots. */
  maxProjects: number
  /** Follow symlinked roots. */
  followSymlinks: boolean
}

export const DEFAULT_WATCH_CONFIG: WatchConfig = {
  usePolling: false,
  stabilityThresholdMs: 200,
  pollIntervalMs: 500,
  maxProjects: 64,
  followSymlinks: true,
}

/** One watcher handle, either a Chokidar watcher or a missing-root probe. */
interface WatchHandle {
  close(): Promise<void> | void
}

/** How one root is currently being observed. */
type WatchMode =
  | { kind: 'root'; anchor: string }
  | { kind: 'ancestor'; nextPath: string }

/** Per-root watcher state. */
interface RootState {
  path: string
  /**
   * The real path actually watched, once a watcher is open.
   *
   * Chokidar reports events against this path, and on a platform where the
   * configured root traverses a symlink (macOS `/tmp` → `/private/tmp`) it
   * differs from `path`. Comparing events against `path` would make every
   * containment check fail and silently drop all of them.
   */
  anchor?: string
  handle?: WatchHandle
  unhealthy: boolean
  /** Pending open/rewatch, so concurrent callers share one attempt. */
  opening?: Promise<void>
}

/** Logger seam; the host passes its Cordis logger, tests may omit it. */
export interface WatchLogger {
  warn(message: string): void
}

/**
 * Watch a changing set of skill roots and invalidate once per change batch.
 *
 * The caller re-reports the current root list on every discovery, and this
 * manager attaches, detaches, and re-arms watchers to match. It never reads
 * skill content itself — invalidation only asks the registry to rebuild.
 */
export class SkillWatcher {
  private readonly states = new Map<string, RootState>()
  private readonly config: WatchConfig
  private closing = false
  private invalidationQueued = false
  /** Roots deferred because `maxProjects` was already reached. */
  private deferred: string[] = []

  constructor(
    private readonly invalidate: () => void,
    private readonly logger: WatchLogger | undefined,
    config: Partial<WatchConfig> = {},
  ) {
    this.config = { ...DEFAULT_WATCH_CONFIG, ...config }
  }

  /**
   * Attach watchers to exactly `roots`.
   *
   * Roots that dropped out of the list are released, and newly reported ones
   * are attached — so a config change that redefines the scan layers takes
   * effect without a restart.
   *
   * @param roots - absolute skill root paths to observe.
   */
  async observeRoots(roots: readonly string[]): Promise<void> {
    if (this.closing) return
    const wanted = new Set(roots)
    for (const [path, state] of [...this.states]) {
      if (wanted.has(path)) continue
      this.states.delete(path)
      await this.closeHandle(state)
    }
    // Anything deferred last round gets another chance once capacity frees up.
    const queue = [...new Set([...this.deferred, ...roots])]
    this.deferred = []
    for (const path of queue) {
      if (this.closing) return
      if (this.states.has(path)) continue
      if (this.states.size >= this.config.maxProjects) {
        this.deferred.push(path)
        continue
      }
      const state: RootState = { path, unhealthy: false }
      this.states.set(path, state)
      try {
        await this.ensureWatcher(state)
      } catch { /* recorded unhealthy; a rewatch is scheduled */ }
    }
  }

  /** Release every watcher and stop observing. */
  async dispose(): Promise<void> {
    this.closing = true
    const states = [...this.states.values()]
    this.states.clear()
    this.deferred = []
    await Promise.all(states.map(state => this.closeHandle(state)))
  }

  private async closeHandle(state: RootState): Promise<void> {
    const handle = state.handle
    state.handle = undefined
    state.anchor = undefined
    if (handle === undefined) return
    try {
      await handle.close()
    } catch (error) {
      this.logger?.warn('skill-filesystem-plus: failed to close watcher: ' + messageOf(error))
    }
  }

  /** Open (or re-open) the watcher for one root, retrying until stable. */
  private async ensureWatcher(state: RootState): Promise<void> {
    if (state.opening !== undefined) return state.opening
    const opening = this.openStableWatcher(state)
    state.opening = opening
    try {
      await opening
    } finally {
      if (state.opening === opening) state.opening = undefined
    }
  }

  private async openStableWatcher(state: RootState): Promise<void> {
    while (!this.closing && this.states.has(state.path)) {
      const mode = await resolveWatchMode(state.path, this.config.followSymlinks)
      const handle = mode.kind === 'ancestor'
        ? this.openAncestorProbe(state, mode)
        : await this.openRootWatcher(state, mode)
      // The path can change while opening (a missing root appears, or a live
      // root disappears). Keep the handle only if the mode is still current.
      if (sameMode(mode, await resolveWatchMode(state.path, this.config.followSymlinks))) {
        state.handle = handle
        // Events arrive against the watched (real) path, so record it.
        state.anchor = mode.kind === 'root' ? mode.anchor : undefined
        state.unhealthy = false
        return
      }
      await closeQuietly(handle)
    }
  }

  /**
   * Probe a missing root one segment at a time.
   *
   * `fs.watchFile` on the nearest existing ancestor's next path segment turns
   * "the directory was created" into an event without walking the tree.
   */
  private openAncestorProbe(state: RootState, mode: { kind: 'ancestor'; nextPath: string }): WatchHandle {
    const listener = (): void => { void this.onProbeEvent(state, mode) }
    watchFile(mode.nextPath, { persistent: false, interval: this.config.pollIntervalMs }, listener)
    return { close: () => { unwatchFile(mode.nextPath, listener) } }
  }

  private async onProbeEvent(state: RootState, mode: { kind: 'ancestor'; nextPath: string }): Promise<void> {
    let current: WatchMode
    try {
      current = await resolveWatchMode(state.path, this.config.followSymlinks)
    } catch (error) {
      if (!this.closing && this.states.has(state.path)) this.onWatcherError(state, error)
      return
    }
    if (this.closing || !this.states.has(state.path) || sameMode(mode, current)) return
    this.queueInvalidation()
    state.unhealthy = true
    await this.rewatch(state)
  }

  private async openRootWatcher(state: RootState, mode: { kind: 'root'; anchor: string }): Promise<WatchHandle> {
    const watcher = chokidar.watch(mode.anchor, {
      persistent: true,
      ignoreInitial: true,
      depth: 1,
      followSymlinks: this.config.followSymlinks,
      atomic: true,
      awaitWriteFinish: {
        stabilityThreshold: this.config.stabilityThresholdMs,
        pollInterval: this.config.pollIntervalMs,
      },
      usePolling: this.config.usePolling,
      interval: this.config.pollIntervalMs,
    })
    let ready = false
    let settle: () => void = () => {}
    const settled = new Promise<void>(res => { settle = res })
    let rejected: unknown
    watcher.on('error', (error: unknown) => {
      if (!ready) {
        rejected = error
        settle()
        return
      }
      if (!this.closing && this.states.has(state.path)) this.onWatcherError(state, error)
    })
    watcher.once('ready', () => {
      ready = true
      settle()
    })
    for (const event of ['add', 'addDir', 'change', 'unlink', 'unlinkDir'] as const) {
      watcher.on(event, (path: string) => { this.onWatchEvent(state, mode, event, path) })
    }
    const handle: WatchHandle = { close: () => watcher.close() }
    try {
      await settled
      if (rejected !== undefined) throw rejected
    } catch (error) {
      await closeQuietly(handle)
      throw error
    }
    return handle
  }

  private onWatchEvent(
    state: RootState,
    mode: { kind: 'root'; anchor: string },
    event: string,
    path: string,
  ): void {
    if (this.closing || !this.states.has(state.path)) return
    // Filter against the WATCHED path, not the configured one: when the root
    // traverses a symlink these differ, and using `state.path` would reject
    // every event.
    const root = state.anchor ?? state.path
    const target = resolve(path)
    if (!isRelevantEvent(root, event, target)) return
    this.queueInvalidation()
    if (target === mode.anchor && event === 'unlinkDir') {
      // The root itself vanished: re-resolve from an ancestor next time.
      state.unhealthy = true
      void this.rewatch(state)
    }
  }

  private onWatcherError(state: RootState, error: unknown): void {
    if (this.closing) return
    this.logger?.warn(`skill-filesystem-plus: watcher for ${state.path} failed: ${messageOf(error)}`)
    state.unhealthy = true
    this.queueInvalidation()
    void this.rewatch(state)
  }

  /** Replace a failed watcher without letting one attempt block the next. */
  private async rewatch(state: RootState): Promise<void> {
    if (this.closing || !this.states.has(state.path)) return
    await this.closeHandle(state)
    try {
      await this.ensureWatcher(state)
    } catch { /* stays unhealthy; the next event retries */ }
  }

  /** Coalesce a burst of events into one invalidation. */
  private queueInvalidation(): void {
    if (this.closing || this.invalidationQueued) return
    this.invalidationQueued = true
    queueMicrotask(() => {
      this.invalidationQueued = false
      if (this.closing) return
      this.invalidate()
    })
  }
}

/** Resolve how a root should be watched right now. */
async function resolveWatchMode(rootPath: string, followSymlinks: boolean): Promise<WatchMode> {
  const anchor = followSymlinks ? safeRealpath(rootPath) : rootPath
  if (existsSync(anchor)) return { kind: 'root', anchor }
  // Walk up to the nearest existing ancestor; watch the path segment that
  // would have to appear for the root to exist.
  let current = anchor
  for (let depth = 0; depth < 64; depth++) {
    const parent = resolve(current, '..')
    if (parent === current) break
    if (existsSync(parent)) return { kind: 'ancestor', nextPath: current }
    current = parent
  }
  return { kind: 'ancestor', nextPath: anchor }
}

/** Realpath when the path exists (so symlinked roots are watched through). */
function safeRealpath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/** Whether a path exists, treating every stat failure as absent. */
function existsSync(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Whether two observations describe the same target.
 *
 * Both fields matter: two `ancestor` modes differ when the next missing path
 * segment changes (a parent appeared, so the probe must move down one level),
 * and ignoring that would leave the probe watching a path that can no longer
 * become the root.
 */
function sameMode(a: WatchMode, b: WatchMode): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'root' && b.kind === 'root') return a.anchor === b.anchor
  if (a.kind === 'ancestor' && b.kind === 'ancestor') return a.nextPath === b.nextPath
  return true
}

async function closeQuietly(handle: WatchHandle): Promise<void> {
  try {
    await handle.close()
  } catch { /* closing is best-effort */ }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether one filesystem event can change the catalog.
 *
 * Only depth-1 shapes matter: a flat `<name>.md`, a bundle's `<name>/SKILL.md`,
 * or a child directory appearing/disappearing. Everything deeper (a bundle's
 * `references/` or `scripts/`) is deliberately ignored, so editing a skill's
 * own resources does not invalidate the catalog. Dot-entries are ignored to
 * match discovery, which skips them.
 */
function isRelevantEvent(root: string, event: string, path: string): boolean {
  const segments = containedSegments(root, path)
  if (segments === undefined) return false
  if (segments.length === 0) return event === 'addDir' || event === 'unlinkDir'
  if (segments[0].startsWith('.')) return false
  if (segments.length === 1) {
    if (event === 'addDir' || event === 'unlinkDir') return true
    return segments[0].endsWith('.md')
  }
  return segments.length === 2 && segments[1] === 'SKILL.md' && event !== 'addDir' && event !== 'unlinkDir'
}

/** Path segments of `path` below `root`, or undefined when outside it. */
function containedSegments(root: string, path: string): string[] | undefined {
  const child = relative(root, path)
  if (child.length === 0) return []
  if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) return undefined
  return child.split(sep)
}
