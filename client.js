/**
 * DSH 工作移植插件 —— Client 侧
 *
 * 通道：Client 通过 ctx.remote.commands.execute() 执行 Host 注册的命令。
 *   命令 dshmig-bridge 带一个 JSON 参数，返回结果文本。
 *   这是 Client -> Host 的官方通道，不需要额外代码生成。
 *
 * 界面：
 *   · 侧边栏底部「迁移」按钮（与提醒按钮同排）
 *   · 点击后弹出面板：导出 / 导入
 */

window.__ModuleLoader__.load({
  id: '@iridensity_gray/dsh-work-migrator',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const PREFIX = 'dshmig'
    /** 构建标识：显示在面板标题里，用来确认加载的是哪一版 */
    const BUILD = 'v1.3-b64url'
    const INK = '#1f2329'
    const INK_MUTED = '#5f6672'
    const ACCENT = '#2f6feb'

    // ---- 共享状态 ----
    const listeners = new Set()
    let state = {
      view: null,          // null | 'menu' | 'export' | 'import'
      busy: false,
      error: '',
      ok: '',
      local: null,         // { groups, workspaces }
      sel: {},             // 导出勾选
      outFile: '',
      packPath: '',
      pack: null,          // inspectPack 的结果
      assign: {}           // 导入归属
    }
    function getState () { return state }
    function setState (patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
      for (const fn of listeners) fn()
    }
    function subscribe (fn) { listeners.add(fn); return () => listeners.delete(fn) }
    function useStore () {
      return React.useSyncExternalStore
        ? React.useSyncExternalStore(subscribe, getState, getState)
        : getState()
    }

    const CSS = `
.dswm-mask{position:fixed;inset:0;background:rgba(0,0,0,.42);z-index:9998;
  display:flex;align-items:center;justify-content:center;padding:24px}
.dswm-panel{background:#fff;color:${INK};border-radius:12px;
  box-shadow:0 16px 48px rgba(0,0,0,.32);width:min(820px,100%);
  max-height:86vh;display:flex;flex-direction:column;font-size:13px;font-family:inherit}
.dswm-head{padding:14px 18px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:8px}
.dswm-title{margin:0;font-size:15px;font-weight:600;flex:1}
.dswm-x{border:0;background:transparent;font-size:20px;line-height:1;cursor:pointer;
  color:${INK_MUTED};padding:2px 8px;border-radius:6px;font-family:inherit}
.dswm-x:hover{background:rgba(0,0,0,.06)}
.dswm-body{padding:16px 18px;overflow:auto;flex:1}
.dswm-foot{padding:12px 18px;border-top:1px solid #eee;display:flex;gap:8px;
  align-items:center;justify-content:flex-end}
.dswm-hint{color:${INK_MUTED};font-size:12px;margin-right:auto}
.dswm-btn{padding:6px 14px;border-radius:8px;cursor:pointer;font-size:13px;
  border:1px solid #ccc;background:transparent;color:${INK};font-family:inherit}
.dswm-btn:hover{background:rgba(0,0,0,.05)}
.dswm-btn:disabled{opacity:.45;cursor:default}
.dswm-primary{background:${ACCENT};color:#fff;border-color:${ACCENT}}
.dswm-primary:hover{opacity:.9;background:${ACCENT}}
.dswm-sec{margin-bottom:16px}
.dswm-lb{font-weight:600;font-size:12px;color:${INK_MUTED};margin-bottom:8px}
.dswm-row{display:flex;align-items:center;gap:9px;padding:6px 8px;border-radius:7px}
.dswm-row:hover{background:rgba(0,0,0,.04)}
.dswm-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dswm-sub{color:${INK_MUTED};font-size:11px;max-width:300px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.dswm-tag{padding:1px 6px;border-radius:4px;font-size:11px;background:#f0f0f0;color:${INK_MUTED}}
.dswm-in,.dswm-sel{padding:6px 9px;border-radius:7px;font-size:12px;font-family:inherit;
  border:1px solid #ccc;background:#fff;color:${INK};box-sizing:border-box}
.dswm-in{width:100%}
.dswm-err{color:#d33;font-size:12px;margin:6px 0;white-space:pre-wrap}
.dswm-ok{color:#2a8a3e;font-size:12px;margin:6px 0;white-space:pre-wrap}
.dswm-empty{color:${INK_MUTED};font-size:12px;padding:8px}
`

    function useStyle () {
      React.useEffect(() => {
        if (document.querySelector('style[data-dswm]')) return
        const el = document.createElement('style')
        el.setAttribute('data-dswm', '')
        el.textContent = CSS
        document.head.appendChild(el)
      }, [])
    }

    // ---- 侧边栏按钮 ----
    function MigrateButton ({ wide, onClick }) {
      const s = useStore()
      const isOpen = s.view !== null
      const [hover, setHover] = React.useState(false)
      const hot = hover || isOpen
      return h('button', {
        type: 'button',
        'aria-label': '导出/导入开发工作',
        'aria-expanded': isOpen,
        onClick,
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        title: '导出 / 导入开发工作',
        style: {
          position: 'relative', display: 'flex', alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: 8, width: wide ? 'auto' : '100%', height: 34,
          padding: wide ? '0 10px' : 0,
          // flex 1 1 0：与提醒、删除两个按钮平分宽度，hover 色块才一样大
          flex: wide ? '1 1 0' : 'none',
          borderRadius: 10, border: 'none',
          // 不常驻：只在悬停或面板打开时显示浅蓝底
          background: hot ? '#e6f0ff' : 'transparent',
          cursor: 'pointer', fontSize: 13,
          color: hot ? '#1a6fd4' : INK_MUTED
        }
      },
      h('span', { style: { position: 'relative', display: 'inline-flex' } },
        h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M7 8h9m0 0-2.4-2.4M16 8l-2.4 2.4',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'
          }),
          h('path', {
            d: 'M17 16H8m0 0 2.4-2.4M8 16l2.4 2.4',
            stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round'
          }))),
      wide ? h('span', { style: { flex: '0 0 auto', textAlign: 'left', whiteSpace: 'nowrap' } }, '迁移') : null)
    }

    // ---- 面板 ----
    function Panel ({ onClose, call }) {
      useStyle()
      const s = useStore()
      if (s.view === null) return null
      const busy = s.busy

      const nav = (view) => setState({ view, error: '', ok: '' })

      async function loadLocal () {
        setState({ busy: true, error: '', ok: '' })
        try {
          const data = await call('localState', {})
          setState({ busy: false, error: '', local: data })
        } catch (e) {
          setState({ busy: false, error: String(e.message || e) })
        }
      }

      async function readPack () {
        if (!s.packPath) { setState({ error: '请填写包路径', ok: '' }); return }
        setState({ busy: true, error: '', ok: '' })
        try {
          const mf = await call('inspectPack', { packFile: s.packPath })
          const assign = {}
          for (const w of mf.works || []) assign[w.name] = { kind: 'original' }
          // 成功时明确清空 error，避免上一次失败的提示残留
          setState({ busy: false, error: '', pack: mf, assign, ok: `读到 ${(mf.works || []).length} 个工作` })
        } catch (e) {
          setState({ busy: false, error: String(e.message || e), ok: '' })
        }
      }

      async function runExport () {
        const paths = Object.keys(s.sel).filter(k => s.sel[k])
        if (!paths.length) { setState({ error: '请先勾选要导出的工作', ok: '' }); return }
        if (!s.outFile) { setState({ error: '请填写保存路径', ok: '' }); return }
        setState({ busy: true, error: '', ok: '' })
        try {
          const r = await call('doExport', { paths, outFile: s.outFile })
          setState({ busy: false, error: '', ok: (r && r.text) || '导出完成' })
        } catch (e) {
          setState({ busy: false, error: String(e.message || e) })
        }
      }

      async function runImport () {
        const pack = s.pack
        if (!pack) { setState({ error: '请先读取包', ok: '' }); return }
        const assignments = []
        for (const w of pack.works || []) {
          const a = s.assign[w.name] || { kind: 'original' }
          if (a.kind === 'skip') continue
          if (a.kind === 'original') {
            assignments.push({ workName: w.name, targetPath: w.path, isOriginal: true })
          } else if (a.kind === 'group') {
            assignments.push({ workName: w.name, targetPath: joinPath(a.parent, w.name), groupName: a.title })
          } else if (a.kind === 'new') {
            if (!a.title || !a.parent) {
              setState({ error: `「${w.name}」请填写新分组名和父目录`, ok: '' }); return
            }
            assignments.push({
              workName: w.name,
              targetPath: joinPath(a.parent, a.title, w.name),
              createGroup: { title: a.title, parent: a.parent }
            })
          }
        }
        if (!assignments.length) { setState({ error: '没有可导入的工作', ok: '' }); return }
        setState({ busy: true, error: '', ok: '' })
        try {
          const r = await call('doImport', { packFile: s.packPath, assignments })
          setState({ busy: false, error: '', ok: (r && r.text) || '导入完成，请重启 DSH' })
        } catch (e) {
          setState({ busy: false, error: String(e.message || e) })
        }
      }

      const works = s.local ? (s.local.workspaces || []) : []
      const groups = s.local ? (s.local.groups || []) : []
      const pack = s.pack

      let body
      if (s.view === 'menu') {
        body = h('div', null,
          h('div', { className: 'dswm-sec' },
            h('div', { className: 'dswm-lb' }, '把开发工作连同对话一起搬走'),
            h('div', { style: { lineHeight: 1.9, color: INK_MUTED } },
              '导出：把工作（代码 + 数据 + 对话记录 + 目录结构）打包成一个 .dsht 文件。',
              h('br'),
              '导入：把包里的工作按你指定的分组放到本机，对话随之恢复。',
              h('br'),
              '新建分组时会自动创建对应文件夹。'
            )
          )
        )
      } else if (s.view === 'export') {
        const allSelected = works.length > 0 && works.every(w => s.sel[w.path])
        const someSelected = works.some(w => s.sel[w.path])
        const setAll = (on) => setState(() => {
          const next = {}
          for (const w of works) next[w.path] = on
          return { sel: next }
        })
        body = h('div', null,
          h('div', { className: 'dswm-sec' },
            h('div', { className: 'dswm-lb', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('span', null, `选择要导出的工作（已选 ${works.filter(w => s.sel[w.path]).length} / ${works.length}）`),
              h('button', {
                type: 'button', className: 'dswm-btn',
                style: { padding: '2px 8px', fontSize: 11 },
                onClick: () => setAll(!allSelected),
                disabled: busy || works.length === 0
              }, allSelected ? '全不选' : '全选'),
              h('button', {
                type: 'button', className: 'dswm-btn',
                style: { padding: '2px 8px', fontSize: 11 },
                onClick: loadLocal, disabled: busy
              }, busy ? '读取中…' : '刷新')
            ),
            works.length === 0
              ? h('div', { className: 'dswm-empty' }, '点「刷新」读取当前工作区')
              : works.map(w => h('label', { key: w.id || w.path, className: 'dswm-row' },
                h('input', {
                  type: 'checkbox',
                  checked: !!s.sel[w.path],
                  onChange: e => setState(st => ({ sel: { ...st.sel, [w.path]: e.target.checked } }))
                }),
                h('span', { className: 'dswm-nm' }, w.title),
                h('span', { className: 'dswm-tag' }, `${w.sessionIds ? w.sessionIds.length : 0} 会话`),
                h('span', { className: 'dswm-sub', title: w.path }, w.path)
              ))
          ),
          h('div', { className: 'dswm-sec' },
            h('div', { className: 'dswm-lb' }, '保存为（完整路径，含 .dsht）'),
            h('input', {
              className: 'dswm-in',
              value: s.outFile,
              placeholder: '例如 D:\\Harness Record\\导出.dsht',
              onChange: e => setState({ outFile: e.target.value })
            })
          )
        )
      } else {
        body = h('div', null,
          h('div', { className: 'dswm-sec' },
            h('div', { className: 'dswm-lb' }, '移植包路径'),
            h('div', { style: { display: 'flex', gap: 8 } },
              h('input', {
                className: 'dswm-in',
                value: s.packPath,
                placeholder: '.dsht 文件的完整路径',
                onChange: e => setState({ packPath: e.target.value })
              }),
              h('button', {
                type: 'button', className: 'dswm-btn', onClick: readPack, disabled: busy
              }, busy ? '读取中…' : '读取')
            )
          ),
          pack ? h('div', { className: 'dswm-sec' },
            h('div', { className: 'dswm-lb', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
              h('span', null, `包内工作（${(pack.works || []).length} 个）——逐个指定归属`),
              h('button', {
                type: 'button', className: 'dswm-btn',
                style: { padding: '2px 8px', fontSize: 11 },
                onClick: () => setState(st => {
                  const next = {}
                  for (const w of pack.works || []) next[w.name] = { kind: 'original' }
                  return { assign: next }
                })
              }, '全部保持原分组')
            ),
            h('div', { style: { fontSize: 12, color: INK_MUTED, marginBottom: 8 } },
              `本机现有分组：${groups.length ? groups.map(g => g.title || g.path).join('、') : '（无）'}`),
            (pack.works || []).map(w => {
              const a = s.assign[w.name] || { kind: 'original' }
              const val = a.kind === 'group' ? `g:${a.parent}` : a.kind
              return h('div', { key: w.name, className: 'dswm-row', style: { flexWrap: 'wrap' } },
                h('span', { className: 'dswm-nm' }, w.name),
                h('span', { className: 'dswm-tag' }, `${(w.sessions || []).length} 会话`),
                h('select', {
                  className: 'dswm-sel',
                  value: val,
                  onChange: e => {
                    const v = e.target.value
                    setState(st => {
                      const cur = st.assign[w.name] || {}
                      const next = v.startsWith('g:')
                        ? { kind: 'group', parent: v.slice(2), title: (groups.find(g => g.path === v.slice(2)) || {}).title }
                        : v === 'new'
                          ? { kind: 'new', title: w.name, parent: cur.parent || '' }
                          : { kind: v }
                      return { assign: { ...st.assign, [w.name]: next } }
                    })
                  }
                },
                h('option', { value: 'original' }, '保持原分组'),
                groups.map(g => h('option', { key: g.path, value: `g:${g.path}` }, `归到 ${g.title || g.path}`)),
                h('option', { value: 'new' }, '+ 新建分组…'),
                h('option', { value: 'skip' }, '跳过')
                ),
                a.kind === 'new' ? h('input', {
                  className: 'dswm-in', style: { maxWidth: 190 },
                  placeholder: '新分组名',
                  value: a.title || '',
                  onChange: e => setState(st => ({
                    assign: { ...st.assign, [w.name]: { ...a, title: e.target.value } }
                  }))
                }) : null,
                a.kind === 'new' ? h('input', {
                  className: 'dswm-in', style: { maxWidth: 250 },
                  placeholder: '父目录（如 D:\\Harness Record）',
                  value: a.parent || '',
                  onChange: e => setState(st => ({
                    assign: { ...st.assign, [w.name]: { ...a, parent: e.target.value } }
                  }))
                }) : null
              )
            })
          ) : null
        )
      }

      const foot = s.view === 'menu'
        ? [
            h('button', { key: 'e', type: 'button', className: 'dswm-btn', onClick: () => nav('export') }, '导出'),
            h('button', { key: 'i', type: 'button', className: 'dswm-btn dswm-primary', onClick: () => nav('import') }, '导入')
          ]
        : [
            h('span', { key: 'h', className: 'dswm-hint' },
              s.view === 'import' ? '导入后需重启 DSH 生效。' : '导出不修改任何数据。'),
            h('button', { key: 'b', type: 'button', className: 'dswm-btn', onClick: () => nav('menu'), disabled: busy }, '返回'),
            s.view === 'export'
              ? h('button', { key: 'g', type: 'button', className: 'dswm-btn dswm-primary', onClick: runExport, disabled: busy }, busy ? '导出中…' : '开始导出')
              : h('button', { key: 'g', type: 'button', className: 'dswm-btn dswm-primary', onClick: runImport, disabled: busy || !pack }, busy ? '执行中…' : '开始导入')
          ]

      const title = s.view === 'menu' ? '工作迁移' : s.view === 'export' ? '导出开发工作' : '导入开发工作'

      return h('div', {
        className: 'dswm-mask',
        onMouseDown: e => { if (e.target === e.currentTarget) onClose() }
      },
      h('div', { className: 'dswm-panel', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'dswm-head' },
              h('h2', { className: 'dswm-title' },
            title,
            h('span', {
              style: { marginLeft: 8, fontSize: 11, fontWeight: 400, color: INK_MUTED }
            }, BUILD)),
          h('button', { type: 'button', className: 'dswm-x', onClick: onClose, 'aria-label': '关闭' }, '\u00d7')
        ),
        h('div', { className: 'dswm-body' },
          s.error ? h('div', { className: 'dswm-err' }, s.error) : null,
          s.ok ? h('div', { className: 'dswm-ok' }, s.ok) : null,
          body
        ),
        h('div', { className: 'dswm-foot' }, foot)
      ))
    }

    /**
     * UTF-8 安全的 base64url 编码（浏览器端）。
     *
     * 为什么不用普通 base64：
     *   普通 base64 会产出 `+` `/` `=`，其中 `+` 在 URL / 命令行参数里
     *   常被解码成空格，导致传参损坏（表现为路径在空格处被截断）。
     *   base64url 只用 A-Za-z0-9-_，绝对安全。
     */
    function b64encode (str) {
      const bytes = new TextEncoder().encode(str)
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH))
      }
      return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    }

    function joinPath (...parts) {
      const kept = parts.filter(p => p && String(p).trim())
      if (!kept.length) return ''
      const sep = String(kept[0]).includes('\\') ? '\\' : '/'
      return kept.map((p, i) => i === 0
        ? String(p).replace(/[\\/]+$/, '')
        : String(p).replace(/^[\\/]+|[\\/]+$/g, '')).join(sep)
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'sessions'],
      apply (ctx) {
        // 通过 remote 执行 Host 命令
        // 签名：remote.commands.execute(sessionId, line, attachments)
        //
        // ⚠️ 参数用 base64 传：
        //   JSON 里可能含空格（如 "Harness Record Export File"），
        //   直接拼进命令行会被 DSH 的命令解析器按空格截断。
        const call = async (tool, payload) => {
          const sessionId = currentSessionId(ctx)
          if (!sessionId) throw new Error('没有活动会话，无法执行')
          const json = JSON.stringify({ tool, payload })
          const b64 = b64encode(json)
          const line = `/dshmig-bridge ${b64}`
          let res
          try {
            res = await ctx.remote.commands.execute(sessionId, line, [])
          } catch (e) {
            throw new Error('调用失败：' + String(e && e.message ? e.message : e))
          }
          if (!res) throw new Error('命令没有返回结果')
          if (res.ok === false) {
            const msg = (res.error && (res.error.message || res.error.code)) || JSON.stringify(res.error || res)
            throw new Error('命令被拒绝：' + msg)
          }
          const text = extractText(res.value)
          if (!text) throw new Error('命令没有输出文本（value=' + JSON.stringify(res.value || null).slice(0, 200) + '）')
          let parsed
          try {
            parsed = JSON.parse(text)
          } catch {
            return { text }
          }
          if (parsed && parsed.ok === false) throw new Error(parsed.error || '执行失败')
          if (parsed && parsed.data) return parsed.data
          return parsed
        }

        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: `${PREFIX}.folder`,
          order: 20,
          inject: () => ({ onClick: () => setState({ view: 'menu', error: '', ok: '' }) })
        }, MigrateButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: `${PREFIX}.dialog`,
          inject: () => ({ onClose: () => setState({ view: null }), call })
        }, Panel))
      }
    }

    /** 取当前活动的会话 id */
    function currentSessionId (ctx) {
      try {
        const sessions = ctx.sessions
        if (sessions && typeof sessions.list?.getSnapshot === 'function') {
          const snap = sessions.list.getSnapshot()
          const ids = snap && snap.order ? snap.order : Object.keys(snap?.byId || {})
          if (ids && ids.length) return ids[0]
        }
        if (sessions && typeof sessions.current === 'function') {
          const cur = sessions.current()
          if (cur) return typeof cur === 'string' ? cur : cur.id
        }
        if (sessions && sessions.current) {
          const cur = sessions.current
          if (typeof cur === 'string') return cur
          if (cur && cur.id) return cur.id
        }
      } catch { /* 忽略 */ }
      return null
    }

    /**
     * 从命令结果里取文本。
     *
     * 实际返回结构：
     *   value = { commandId, result: { kind: 'success', text: '...' } }
     */
    function extractText (value) {
      if (!value) return ''
      if (typeof value === 'string') return value
      if (value.result) {
        const inner = extractText(value.result)
        if (inner) return inner
      }
      if (typeof value.text === 'string') return value.text
      if (Array.isArray(value)) {
        for (const item of value) {
          const t = extractText(item)
          if (t) return t
        }
      }
      return ''
    }
  }
})
