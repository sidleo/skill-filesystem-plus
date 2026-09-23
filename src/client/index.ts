// @ts-nocheck — DSH client-plugin factory is plain JS; tsc strict applies to the host side.
/**
 * skill-filesystem-plus Client — @sidleo3/skill-filesystem-plus
 *
 * DSH client-plugin contract: the bundle is a CommonJS factory registered via
 * `window.__ModuleLoader__.load({ id, factory })`, exporting `apply`/`inject`.
 * `React` resolves through the loader module table via `require("react")`, and
 * services are consumed through `ctx.get`. RPC to the host goes over
 * `fetch('/api/skill-filesystem-plus/*')`.
 *
 * This half drives the plugin's configuration page on the sidebar Plugins page:
 *  - per-preset takeover: list presets, enable/disable (apply/remove RPC)
 *  - four-layer scan toggles + parent-dir editor (config RPC)
 *  - scan-root preview for the current session cwd
 *
 * The page registers through the `plugins.bundle.config` slot, keyed by the npm
 * package name, and renders `view: 'page'`: the Plugins page owns the title,
 * icon and breadcrumb, so the body starts at the first section.
 *
 * @module @sidleo3/skill-filesystem-plus/client
 */

import React from 'react'

export const inject = ['slots']

/** The bundle package name; also the `plugins.bundle.config` registration key. */
const BUNDLE = '@sidleo3/skill-filesystem-plus'

export function apply(ctx) {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const h = React.createElement

  // Minimal local injectable stylesheet (no CSS-module pipeline dependency).
  const CSS = `
    .skillScanPage { display:flex; flex-direction:column; gap:4px; padding-bottom:8px }
    .skillScanLoading { font-size:13px; line-height:1.5; color:var(--dsw-alias-label-tertiary); padding:12px 0 }
    .skillScanSectionTitle { font-size:13px; font-weight:600; line-height:1.4; color:var(--dsw-alias-label-primary); margin:0 0 8px }
    .skillScanToggleRow { display:flex; align-items:flex-start; gap:8px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l2) }
    .skillScanToggleBody { flex:1 }
    .skillScanToggleLabel { font-size:13px; font-weight:500; line-height:1.5; color:var(--dsw-alias-label-primary) }
    .skillScanHint { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); margin-top:2px }
    .skillScanWarn { font-size:12px; color:var(--dsw-alias-label-error); margin-top:6px }
    .skillScanCheckbox { margin-top:3px; accent-color:var(--dsw-alias-brand-primary) }
    .skillScanPdRow { display:flex; align-items:center; gap:8px; margin:6px 0; padding:6px 8px; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; background:var(--dsw-alias-bg-layer-2); cursor:grab }
    .skillScanDragHandle { color:var(--dsw-alias-label-tertiary); font-size:14px; cursor:grab; user-select:none; flex:none }
    .skillScanRankOrder { color:var(--dsw-alias-label-tertiary); font-size:11px; flex:none; min-width:22px; text-align:right }
    .skillScanNameInput { flex:1; min-width:0; padding:5px 8px; border-radius:8px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); font:inherit; font-size:13px }
    .skillScanMiniBtn { appearance:none; border:0; background:none; cursor:pointer; color:var(--dsw-alias-label-tertiary); font-size:13px; padding:2px 4px; flex:none }
    .skillScanMiniBtn:hover { color:var(--dsw-alias-label-primary) }
    .skillScanAddBtn { margin-top:6px; appearance:none; border:1px solid var(--dsw-alias-border-l2); border-radius:8px; padding:5px 12px; background:none; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12.5px; cursor:pointer }
    .skillScanAddBtn:hover { color:var(--dsw-alias-label-primary); border-color:var(--dsw-alias-label-dimmed) }
    .skillScanPreviewBox { background:var(--dsw-alias-bg-layer-2); border-radius:8px; padding:8px; margin-bottom:6px; max-height:180px; overflow-y:auto }
    .skillScanPreviewRow { display:flex; align-items:center; gap:8px; padding:3px 0; font-size:12.5px }
    .skillScanRankBadge { background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-secondary); border-radius:4px; padding:1px 6px; font-size:11px; white-space:nowrap; flex:none }
    .skillScanSrcBadge { background:var(--dsw-alias-bg-module-platform); color:var(--dsw-alias-label-tertiary); border-radius:4px; padding:1px 6px; font-size:11px; white-space:nowrap; flex:none }
    .skillScanCode { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all }
    .skillScanOk { font-size:12.5px; color:var(--dsw-alias-label-primary) }
    .skillScanError { font-size:12.5px; color:var(--dsw-alias-label-error); margin-top:8px }
    .skillScanSection { margin-bottom:14px }
    .skillScanPresetRow { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--dsw-alias-border-l2) }
    .skillScanPresetBody { flex:1; min-width:0 }
    .skillScanPresetName { font-size:13px; font-weight:500; line-height:1.5; color:var(--dsw-alias-label-primary) }
    .skillScanPresetDesc { font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); margin-top:2px }
    .skillScanTag { display:inline-block; font-size:11px; line-height:1; padding:3px 6px; border-radius:999px; margin-top:4px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary) }
    .skillScanTagOn { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); color:var(--dsw-alias-brand-primary) }
    .skillScanTagOff { background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-tertiary) }
    .skillScanTagDirty { background:color-mix(in srgb, var(--dsw-alias-label-error) 14%, transparent); color:var(--dsw-alias-label-error) }
    .skillScanBusy { opacity:.6; pointer-events:none }
  `
  // Inject the stylesheet once per page (idempotent).
  if (typeof document !== 'undefined' && document.getElementById('skill-filesystem-plus-css') === null) {
    const tag = document.createElement('style')
    tag.id = 'skill-filesystem-plus-css'
    tag.dataset.plugin = '@sidleo3/skill-filesystem-plus'
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  /**
   * Display names for DSH's built-in presets.
   *
   * The roster reports the raw id (`standard`, `ptc`, …) — the shipped
   * declarations carry no `name` field. DSH's own preset picker localizes them
   * through `BUILT_IN_PRESET_KEYS` in `@deepseek-ai/dsh-client-ui-agent-preset`,
   * whose zh dictionary these strings match, so the two surfaces agree.
   */
  const PRESET_NAMES = {
    standard: '标准模式',
    ptc: 'PTC 模式',
    minimal: '极简模式',
    cordis: '创造模式',
  }

  /** One-line descriptions, matching DSH's zh dictionary. */
  const PRESET_DESCRIPTIONS = {
    standard: '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
    ptc: '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
    minimal: 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
    cordis: '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
  }

  /** `标准模式（standard）` — localized name, falling back to the raw id. */
  function presetLabel(preset) {
    const name = PRESET_NAMES[preset.id]
    if (name !== undefined) return name + '（' + preset.id + '）'
    // A user-declared preset carries its own name; only fall back to the id.
    return preset.name || preset.id
  }

  /**
   * Whether our override row exists but is only half in effect.
   *
   * `backupExists` is NOT a takeover signal: the backup is an audit trail that
   * survives unchecking, so treating it as "incomplete" cries wolf on every
   * preset that was ever taken over. Only an override row present while its
   * two halves disagree means the row is stale or was partly edited.
   */
  function presetHalfApplied(preset) {
    return !preset.enabled && (preset.pipelineActive !== preset.builtinDisabled)
  }

  function SkillScanPage() {
    const [config, setConfig] = React.useState(null)
    const [presets, setPresets] = React.useState(null)
    const [preview, setPreview] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState('')
    const [saved, setSaved] = React.useState(false)
    const [presetMsg, setPresetMsg] = React.useState('')

    React.useEffect(function () {
      let alive = true
      fetch('/api/skill-filesystem-plus/config').then(function (r) { return r.json() })
        .then(function (cfg) { if (alive) setConfig(cfg) }).catch(function () {})
      fetch('/api/skill-filesystem-plus/presets').then(function (r) { return r.json() })
        .then(function (data) { if (alive) setPresets(data && data.presets ? data.presets : []) }).catch(function () {})
      fetch('/api/skill-filesystem-plus/roots').then(function (r) { return r.json() })
        .then(function (res) { if (alive) setPreview(res) }).catch(function () {})
      return function () { alive = false }
    }, [])

    function save(next) {
      setError('')
      setConfig(next)
      setSaved(false)
      fetch('/api/skill-filesystem-plus/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      }).then(function (r) { return r.json() })
        .then(function (result) {
          if (result && result.ok) {
            setConfig(result.config)
            setSaved(true)
            return fetch('/api/skill-filesystem-plus/roots').then(function (r) { return r.json() })
          }
          throw new Error((result && result.error) || 'save failed')
        })
        .then(function (res) { if (res) setPreview(res) })
        .catch(function (err) { setError(String(err && err.message ? err.message : err)) })
    }

    function togglePreset(presetId, enable) {
      setBusy(true)
      setError('')
      setPresetMsg('')
      const path = enable ? '/api/skill-filesystem-plus/presets/apply' : '/api/skill-filesystem-plus/presets/remove'
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ presetId: presetId }),
      }).then(function (r) { return r.json() })
        .then(function (result) {
          if (result && result.ok) {
            setPresetMsg(result.message || (enable ? '已生效' : '已取消'))
            return fetch('/api/skill-filesystem-plus/presets').then(function (r) { return r.json() })
          }
          throw new Error((result && result.error) || '操作失败')
        })
        .then(function (data) {
          if (data) { setPresets(data && data.presets ? data.presets : []); setBusy(false) }
        })
        .catch(function (err) { setError(String(err && err.message ? err.message : err)); setBusy(false) })
    }

    if (config === null) {
      return h('div', { className: 'skillScanLoading' }, '加载配置…')
    }

    function ToggleRow(label, hint, checked, onToggle) {
      return h('div', { className: 'skillScanToggleRow', key: label },
        h('input', { type: 'checkbox', className: 'skillScanCheckbox', checked: checked, onChange: function (e) { onToggle(e.target.checked) } }),
        h('div', { className: 'skillScanToggleBody' },
          h('div', { className: 'skillScanToggleLabel' }, label),
          h('div', { className: 'skillScanHint' }, hint)))
    }
    function updateName(index, name) {
      const next = config.parentDirs.map(function (pd, i) { return i === index ? { name: name } : pd })
      save(Object.assign({}, config, { parentDirs: next }))
    }
    function removeDir(index) {
      const next = config.parentDirs.filter(function (_, i) { return i !== index })
      save(Object.assign({}, config, { parentDirs: next }))
    }
    function addDir() {
      setError('')
      setSaved(false)
      setConfig(Object.assign({}, config, { parentDirs: config.parentDirs.concat([{ name: '' }]) }))
    }
    function setToggle(key, value) {
      if (key === 'scanProject' && value && config.scanParents) return save(Object.assign({}, config, { scanProject: true, scanParents: false }))
      if (key === 'scanParents' && value && config.scanProject) return save(Object.assign({}, config, { scanParents: true, scanProject: false }))
      save(Object.assign({}, config, { [key]: value }))
    }

    const levelCount = [config.scanCwd, config.scanProject || config.scanParents, config.scanGlobal].filter(Boolean).length
    const mutualHint = config.scanProject && config.scanParents
      ? h('div', { className: 'skillScanWarn' }, '⚠ 扫描项目目录与遍历上级目录互斥，只能开一项')
      : null
    const rows = [
      ToggleRow('扫描 cwd 目录（会话工作目录）', '最高优先级 · <cwd>/<上级目录>/skills', config.scanCwd, function (v) { setToggle('scanCwd', v) }),
      ToggleRow('扫描项目目录', '中等优先级 · 最近含 .git 的祖先目录（项目根）', config.scanProject, function (v) { setToggle('scanProject', v) }),
      ToggleRow('遍历所有上级目录', '中等优先级 · 从工作目录向上逐级扫描', config.scanParents, function (v) { setToggle('scanParents', v) }),
      mutualHint,
      ToggleRow('扫描全局目录', '最低优先级 · 主目录 ~ 下', config.scanGlobal, function (v) { setToggle('scanGlobal', v) }),
    ]
    const parentRows = (config.parentDirs || []).map(function (pd, i) {
      return h('div', { key: i, className: 'skillScanPdRow' },
        h('span', { className: 'skillScanDragHandle' }, '⋮⋮'),
        h('input', { className: 'skillScanNameInput', value: pd.name, placeholder: '如 .claude', onChange: function (e) { updateName(i, e.target.value) } }),
        h('span', { className: 'skillScanRankOrder' }, '#' + (i + 1)),
        h('button', { type: 'button', className: 'skillScanMiniBtn', title: '删除', onClick: function () { removeDir(i) } }, '✕'))
    })
    const previewRows = preview && preview.roots && preview.roots.length > 0
      ? preview.roots.map(function (r, i) {
          return h('div', { key: i, className: 'skillScanPreviewRow' },
            h('span', { className: 'skillScanRankBadge' }, 'rank ' + r.rank),
            h('span', { className: 'skillScanSrcBadge' }, r.source),
            h('span', { className: 'skillScanCode', style: { flex: 1 } }, r.root))
        })
      : h('div', { className: 'skillScanHint' }, '暂无根目录')

    // ── Preset takeover section ─────────────────────────────────
    var presetList = (presets || [])
      .filter(function (p) { return p.hasSkillFilesystem })
      .map(function (p) {
        return h('div', { key: p.id, className: 'skillScanPresetRow' },
          h('input', { type: 'checkbox', className: 'skillScanCheckbox', checked: !!p.enabled, disabled: busy, onChange: function (e) { togglePreset(p.id, e.target.checked) } }),
          h('div', { className: 'skillScanPresetBody' },
            h('div', { className: 'skillScanPresetName' }, presetLabel(p)),
            h('div', { className: 'skillScanPresetDesc' }, PRESET_DESCRIPTIONS[p.id] || ''),
            h('span', { className: 'skillScanTag ' + (p.enabled ? 'skillScanTagOn' : (presetHalfApplied(p) ? 'skillScanTagDirty' : 'skillScanTagOff')) },
              p.enabled
                ? '● 已接管'
                : (presetHalfApplied(p) ? '⚠ 接管不完整（覆盖行状态不一致，重新勾选修复）' : '○ 内置技能发现'))))
      })
    var presetsEmpty = presetList.length === 0
      ? h('div', { className: 'skillScanHint' }, '未找到含 skill-filesystem 行的预设，或 agentPresets 服务不可用。')
      : null
    // Presets without a skill-filesystem row need no takeover; say so rather
    // than letting them silently vanish from the list.
    var presetsSkipped = (presets || [])
      .filter(function (p) { return !p.hasSkillFilesystem })
      .map(function (p) { return presetLabel(p) })
    var presetsSkippedHint = presetsSkipped.length === 0
      ? null
      : h('div', { className: 'skillScanHint' }, '未列出：' + presetsSkipped.join('、') + '（不含 skill-filesystem 行，无需接管）')

    // The Plugins page owns the title, icon and breadcrumb, so this body
    // renders its sections directly instead of a collapsible card.
    return h('div', { className: 'skillScanPage' + (busy ? ' skillScanBusy' : '') },
        h('div', { className: 'skillScanSection' },
          h('div', { className: 'skillScanSectionTitle' }, '生效的预设（多选，立即生效于新建会话）'),
          h('div', { className: 'skillScanHint' }, '勾选 = 在 profile 的 cordis.patch.yml 写入该 preset 的覆盖行（禁用其 skill-filesystem 行 + 接入 skill-filesystem-plus 发现）；取消 = 只删除本插件的覆盖行。'),
          presetsEmpty,
          presetList,
          presetsSkippedHint,
          presetMsg ? h('div', { className: 'skillScanOk' }, '✓ ' + presetMsg) : null),
        h('div', { className: 'skillScanSection' },
          h('div', { className: 'skillScanSectionTitle' }, '扫描层级（开关，优先级从高到低）'),
          rows,
          saved ? h('div', { className: 'skillScanOk' }, '✓ 配置已保存') : null),
        h('div', { className: 'skillScanSection' },
          h('div', { className: 'skillScanSectionTitle' }, 'skills 的上级目录名（可增删改）'),
          h('div', { className: 'skillScanHint' }, '默认 .dsh、.agents。添加一行即扫 <根>/<名称>/skills。'),
          parentRows,
          h('button', { type: 'button', className: 'skillScanAddBtn', onClick: addDir }, '+ 添加上级目录')),
        h('div', { className: 'skillScanSection' },
          h('div', { className: 'skillScanSectionTitle' }, '扫描根预览（当前会话 cwd）'),
          h('div', { className: 'skillScanPreviewBox' }, previewRows)),
        error ? h('div', { className: 'skillScanError' }, '✕ ' + error) : null)
  }

  // Register the configuration page into the sidebar Plugins page's
  // `plugins.bundle.config` slot, keyed by this bundle's package name. The
  // old `settings.plugin.item` slot no longer exists in DSH 0.1.7 — that
  // section is now the read-only built-in inventory — and `slots.inject`
  // waits for a slot declaration, so registering into it silently no-ops.
  slots.inject('plugins.bundle.config', function () {
    return slots.register(
      { name: 'plugins.bundle.config', key: BUNDLE, locale: 'skillFilesystemPlus' },
      function () { return h(SkillScanPage) })
  })
}