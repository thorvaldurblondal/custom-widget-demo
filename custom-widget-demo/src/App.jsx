import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildEditRequest,
  buildQueryRequest,
  shapeOf,
  SDK_URL,
  defaultPreviewContext,
  preparePreviewHtml,
  widgetUrl,
  buildSocketUrl,
  messageType,
  newRequestId,
  pick,
  encodeMessage,
  decodeOutgoing,
} from './protocol.js'

const SETTINGS_KEY = 'customWidgetDemo.settings'
const DEFAULT_SETTINGS = {
  serverPrefix: 'http://localhost:8080/',
  sessionId: '',
  widgetId: '',
  useProxy: true,
  localSdk: true,
}
const HEARTBEAT_MS = 30_000
const PREVIEW_SETTLE_MS = 1_500 // wait after load for late errors before reporting
const PREVIEW_TIMEOUT_MS = 8_000 // report anyway if the preview never loads

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }
  } catch {
    return DEFAULT_SETTINGS
  }
}

const time = () => new Date().toLocaleTimeString([], { hour12: false })

export default function App() {
  const [settings, setSettings] = useState(loadSettings)
  const [phase, setPhase] = useState('form') // form | connecting | editor
  const [problem, setProblem] = useState('')
  const [session, setSession] = useState(null)
  const [wsState, setWsState] = useState('closed')
  const [closedReason, setClosedReason] = useState('')
  const [log, setLog] = useState([])
  const [chat, setChat] = useState([])
  const [running, setRunning] = useState(null) // requestId of the running VibeCodeRequest
  const [published, setPublished] = useState({ html: '', js: '' })
  const [draft, setDraft] = useState(null) // { html, js, version }
  const [showing, setShowing] = useState('published') // published | draft
  const [renderKey, setRenderKey] = useState(0)
  const [tokens, setTokens] = useState({ input: 0, output: 0, credits: null })
  const [previewContext, setPreviewContext] = useState(defaultPreviewContext)
  const [previewSrc, setPreviewSrc] = useState('')
  const [frameHeight, setFrameHeight] = useState(0)

  const wsRef = useRef(null)
  const settingsRef = useRef(settings)
  const sessionRef = useRef(null)
  const reportRef = useRef(null) // pending VibeCodePreviewReport
  const iframeRef = useRef(null)
  const previewContextRef = useRef(previewContext)
  previewContextRef.current = previewContext
  const showingRef = useRef(showing)
  showingRef.current = showing

  settingsRef.current = settings
  sessionRef.current = session

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
    } catch {
      /* ignore */
    }
  }, [settings])

  const addLog = useCallback((dir, channel, data) => {
    setLog((l) => [...l.slice(-499), { id: Math.random(), t: time(), dir, channel, data }])
  }, [])
  const addChat = useCallback((role, text, extra = {}) => {
    setChat((c) => [...c, { id: Math.random(), role, text, ...extra }])
  }, [])

  // ---------- Web socket ----------

  /** Sends one text frame exactly as given, e.g. VibeCodeHeartbeat{"vibeCodeSessionId":"…"} */
  const sendRaw = useCallback(
    (frame) => {
      const ws = wsRef.current
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        addLog('error', 'WS', 'Not connected, message not sent')
        return false
      }
      ws.send(frame)
      const parsed = (() => {
        try {
          return decodeOutgoing(frame)
        } catch {
          return null
        }
      })()
      addLog('out', 'WS', parsed ? `${parsed.type} ${JSON.stringify(parsed.payload, null, 2)}` : frame)
      return true
    },
    [addLog],
  )

  const send = useCallback(
    (type, payload = {}) => {
      const s = sessionRef.current
      return sendRaw(encodeMessage(type, { vibeCodeSessionId: s?.vibeCodeSessionId, ...payload }))
    },
    [sendRaw],
  )

  const flushPreviewReport = useCallback(() => {
    const r = reportRef.current
    if (!r) return
    clearTimeout(r.timer)
    reportRef.current = null
    // Without the SDK nothing above is reported, so say so instead of sending a clean-looking report.
    if (!r.sdkReady)
      r.errors.push({ kind: 'error', message: `The XPS SDK never started: index.html must load the SDK (${SDK_URL} or the S3 copy) before widget.js` })
    send('VibeCodePreviewReport', {
      requestId: r.requestId,
      draftVersion: r.draftVersion,
      jsErrors: r.errors,
      failedQueries: r.failedQueries,
      deniedQueries: [],
      emptyResults: r.emptyResults,
      queryShapes: r.queryShapes,
      loaded: r.loaded,
    })
  }, [send])

  const renderDraft = useCallback(
    (html, js, version, requestId) => {
      setDraft({ html, js, version })
      setShowing('draft')
      setRenderKey((k) => k + 1)
      if (reportRef.current) flushPreviewReport()
      reportRef.current = {
        requestId,
        draftVersion: version,
        errors: [],
        sdkReady: false,
        failedQueries: [],
        emptyResults: [],
        queryShapes: [],
        loaded: false,
        timer: setTimeout(() => flushPreviewReport(), PREVIEW_TIMEOUT_MS),
      }
    },
    [flushPreviewReport],
  )

  const handleMessage = useCallback(
    (msg) => {
      const type = messageType(msg)
      const requestId = msg.requestId
      const tokenInfo = () => {
        const credits = pick(msg, 'creditsLeft', 'credits')
        const input = pick(msg, 'inputTokensThisSession')
        const output = pick(msg, 'outputTokensThisSession')
        setTokens((t) => ({
          input: input ?? t.input,
          output: output ?? t.output,
          credits: credits ?? t.credits,
        }))
      }

      switch (type) {
        case 'VibeCodingProgress':
          addChat('progress', String(pick(msg, 'text', 'step', 'message', 'progress') ?? '…'))
          break
        case 'VibeCodingDraftUpdated': {
          const html = pick(msg, 'html', '.html', 'draftHtml', 'stateOfHtml') ?? ''
          const js = pick(msg, 'js', '.js', 'draftJs', 'stateOfJs') ?? ''
          renderDraft(html, js, msg.draftVersion, requestId)
          addChat('progress', `Draft v${msg.draftVersion ?? '?'} received, rendering`)
          break
        }
        case 'VibeCodingRequestEnded': {
          const err = pick(msg, 'error', 'problem')
          if (err) addChat('error', String(err))
          const text = pick(msg, 'message', 'text', 'finalMessage', 'reply')
          if (text) addChat('ai', String(text))
          if (msg.draftVersion !== undefined) setDraft((d) => (d ? { ...d, version: msg.draftVersion } : d))
          tokenInfo()
          setRunning(null)
          break
        }
        case 'VibeCodingPublishResult': {
          const ok = msg.ok ?? msg.success ?? !msg.errors
          addChat(ok ? 'info' : 'error', ok ? 'Published.' : `Publish failed: ${JSON.stringify(msg.errors ?? msg.problem)}`)
          if (ok && draft) setPublished({ html: draft.html, js: draft.js })
          break
        }
        case 'VibeCodingSessionClosed':
          setClosedReason(String(msg.reason ?? 'closed'))
          addChat('info', `Session closed: ${msg.reason ?? 'unknown reason'}`)
          setRunning(null)
          break
        case 'VibeCodingSessionState': {
          // Reply to VibeCodeResume: show the session as the server has it (after a reconnect).
          const html = pick(msg, 'html', 'stateOfHtml', 'draftHtml')
          const js = pick(msg, 'js', 'stateOfJs', 'draftJs')
          if (msg.hasDraft !== false && (html !== undefined || js !== undefined)) renderDraft(html ?? '', js ?? '', msg.draftVersion, requestId)
          if (Array.isArray(msg.conversation)) {
            const items = msg.conversation.map((c) => ({ id: Math.random(), role: c.who === 'user' ? 'user' : 'ai', text: String(c.text ?? '') }))
            if (msg.runningRequestId && msg.runningRequestText) items.push({ id: Math.random(), role: 'user', text: msg.runningRequestText })
            setChat(items)
          }
          setRunning(msg.runningRequestId || null)
          if (msg.runningRequestId) addChat('progress', 'The AI is still working on this\u2026')
          tokenInfo()
          break
        }
        case 'OutgoingError': {
          // Server could not handle a message we sent; msg names the message class.
          const what = String(msg.msg ?? '').split('.').pop() || 'a message'
          addChat('error', `Server could not handle ${what}${msg.error ? `: ${msg.error}` : ''}`)
          if (/VibeCodeRequest$/.test(String(msg.msg ?? '')) || !msg.msg) setRunning(null)
          break
        }
        case 'Ping':
          break // keep-alive from the server; shown in the log only
        case 'Connection':
          addLog('info', 'WS', `Server says: ${msg.msg ?? 'connected'}`)
          break
        default:
          if (msg.problem && requestId) addChat('error', String(msg.problem))
      }
    },
    [addChat, addLog, renderDraft, draft],
  )
  const handleMessageRef = useRef(handleMessage)
  handleMessageRef.current = handleMessage

  const openSocket = useCallback(() => {
    const url = buildSocketUrl(settingsRef.current)
    addLog('info', 'WS', `Connecting to ${url}`)
    setWsState('connecting')
    const ws = new WebSocket(url)
    wsRef.current = ws
    ws.onopen = () => {
      setWsState('open')
      addLog('info', 'WS', 'Connected')
      // Ask for the session's state, so a reconnect shows the current draft, chat and running request.
      const s = sessionRef.current
      if (s?.vibeCodeSessionId) {
        const frame = encodeMessage('VibeCodeResume', { vibeCodeSessionId: s.vibeCodeSessionId })
        ws.send(frame)
        addLog('out', 'WS', `VibeCodeResume ${JSON.stringify({ vibeCodeSessionId: s.vibeCodeSessionId }, null, 2)}`)
      }
    }
    ws.onclose = (e) => {
      if (wsRef.current === ws) wsRef.current = null
      setWsState('closed')
      addLog('info', 'WS', `Closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`)
    }
    ws.onerror = () => addLog('error', 'WS', 'Socket error (see browser console / terminal for details)')
    ws.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        addLog('in', 'WS', e.data)
        return
      }
      addLog('in', 'WS', msg)
      handleMessageRef.current(msg)
    }
  }, [addLog])

  // Heartbeat while the editor is open
  useEffect(() => {
    if (phase !== 'editor' || wsState !== 'open' || closedReason) return
    const id = setInterval(() => send('VibeCodeHeartbeat'), HEARTBEAT_MS)
    return () => clearInterval(id)
  }, [phase, wsState, closedReason, send])

  /**
   * Runs one xps.query() from the widget against the XPS server (POST xpsweb/vw/query) and
   * resolves to the rows. A draft is identified by the vibeCodeSessionId, the published widget by widgetId.
   */
  const runQuery = useCallback(
    async (name, params, timeZoneName) => {
      const st = settingsRef.current
      const s = sessionRef.current
      // timeZoneName comes from the SDK; fall back to the page's own zone for an older xps.js.
      const body = { name, params: params ?? {}, timeZoneName: timeZoneName || Intl.DateTimeFormat().resolvedOptions().timeZone }
      if (showingRef.current === 'draft' && s?.vibeCodeSessionId) body.vibeCodeSessionId = s.vibeCodeSessionId
      else body.widgetId = st.widgetId.trim()
      const req = buildQueryRequest(st, body)
      addLog('out', 'Query', { url: req.url, body })
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...req.headers },
        body: JSON.stringify(body),
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text.replace(/^\uFEFF/, '').trim())
      } catch {
        addLog('in', 'Query', `HTTP ${res.status}: ${text.slice(0, 2000)}`)
        throw new Error(`HTTP ${res.status} from ${name}`)
      }
      addLog('in', 'Query', json)
      if (json?.proxyError) throw new Error(`Proxy: ${json.proxyError}`)
      if (json?.error) throw new Error(String(json.error))
      if (!res.ok || !json || !Array.isArray(json.result)) throw new Error(`Unexpected reply (HTTP ${res.status}) from ${name}`)
      if (Array.isArray(json.denied) && json.denied.length) addLog('info', 'Query', `${name}: no access to ${json.denied.join(', ')}`)
      // Everything except result and error goes to the widget too (denied, missingTestTemplateIds, ...).
      const { result, error: _error, ...extras } = json
      for (const [k, v] of Object.entries(extras))
        if (k !== 'denied' && Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) addLog('info', 'Query', `${name}: ${k} ${v.join(', ')}`)
      return { rows: result, extras }
    },
    [addLog],
  )

  // Messages from the preview iframe
  useEffect(() => {
    const onMsg = (e) => {
      const d = e.data
      if (!d || !iframeRef.current || e.source !== iframeRef.current.contentWindow) return

      // Messages from the SDK (/vibe-coding-sdk/1/xps.js). This is the part real XPS will do.
      if (d.__xpsWidget === 1) {
        const reply = (msg) => e.source.postMessage({ __xpsHost: 1, ...msg }, '*')
        if (d.kind === 'ready') {
          addLog('info', 'Widget', 'SDK ready')
          if (reportRef.current) reportRef.current.sdkReady = true
        } else if (d.kind === 'error' || d.kind === 'console') {
          // Reported by the SDK; the editor's preview passes them on to the AI.
          const text = d.kind === 'console' ? `console.error: ${d.message}` : `${d.message}${d.line ? ` (line ${d.line}:${d.col})` : ''}`
          addLog('error', 'Preview', text)
          if (reportRef.current) reportRef.current.errors.push({ kind: d.kind, message: d.message, line: d.line, col: d.col, stack: d.stack })
        } else if (d.kind === 'loaded') {
          if (reportRef.current) {
            reportRef.current.loaded = true
            clearTimeout(reportRef.current.timer)
            reportRef.current.timer = setTimeout(() => flushPreviewReport(), PREVIEW_SETTLE_MS)
          }
        } else if (d.kind === 'query') {
          const report = reportRef.current // the draft this query belongs to
          const call = `xps.query(${JSON.stringify(d.name)}, ${JSON.stringify(d.params ?? {})})`
          runQuery(d.name, d.params, d.timeZoneName).then(
            ({ rows, extras }) => {
              addLog('info', 'Widget', `${call} → ${rows.length} row(s)`)
              if (!rows.length && report) report.emptyResults.push({ name: d.name, params: d.params ?? null })
              // Shape only, once per query + params (widgets often query again when the selection changes).
              if (rows.length && report) {
                const key = d.name + JSON.stringify(d.params ?? {})
                if (!report.queryShapes.some((q) => q.name + JSON.stringify(q.params ?? {}) === key))
                  report.queryShapes.push(shapeOf(d.name, d.params, rows, extras))
              }
              reply({ kind: 'queryResult', id: d.id, rows, extras })
            },
            (err) => {
              addLog('error', 'Widget', `${call} failed: ${err.message}`)
              if (report) report.failedQueries.push({ name: d.name, params: d.params ?? null, error: err.message })
              reply({ kind: 'queryResult', id: d.id, error: err.message })
            },
          )
        } else if (d.kind === 'resize') {
          if (Number.isFinite(d.height)) setFrameHeight(Math.min(Math.max(d.height, 0), 5000))
        }
        return
      }

    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [addLog, flushPreviewReport, runQuery])

  // ---------- Actions ----------

  const connect = async () => {
    setProblem('')
    setPhase('connecting')
    const req = buildEditRequest(settings)
    addLog('out', 'REST', { url: req.url, ...(settings.useProxy ? { target: req.headers['X-Xps-Target'] } : {}), body: req.body })
    try {
      const res = await fetch(req.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...req.headers },
        body: JSON.stringify(req.body),
      })
      const text = await res.text()
      let json
      try {
        json = JSON.parse(text.replace(/^\uFEFF/, '').trim())
        // Some servers send the JSON double-encoded as a string.
        if (typeof json === 'string') json = JSON.parse(json)
      } catch {
        addLog('in', 'REST', `HTTP ${res.status}: ${text.slice(0, 2000)}`)
        throw new Error(`HTTP ${res.status}, reply was not JSON: ${text.slice(0, 300)}`)
      }
      addLog('in', 'REST', json)
      if (!json || typeof json !== 'object') throw new Error(`Unexpected reply (HTTP ${res.status}): ${String(json).slice(0, 300)}`)
      if (json.proxyError) throw new Error(`Proxy: ${json.proxyError}`)
      const problemKey = Object.keys(json).find((k) => k.toLowerCase() === 'problem')
      if (problemKey && json[problemKey] != null && json[problemKey] !== '') {
        const p = json[problemKey]
        throw new Error(typeof p === 'string' ? p : p.message ?? p.text ?? JSON.stringify(p))
      }
      if (!json.success) throw new Error(`Unexpected reply (HTTP ${res.status}): ${JSON.stringify(json).slice(0, 300)}`)

      const s = json.success
      setSession(s)
      sessionRef.current = s
      setPublished({ html: s.publishedHtml ?? '', js: s.publishedJs ?? '' })
      const draftHtml = pick(s, 'stateOfHtml', 'draftHtml')
      const draftJs = pick(s, 'stateOfJs', 'draftJs')
      setDraft(draftHtml || draftJs ? { html: draftHtml ?? '', js: draftJs ?? '', version: s.draftVersion } : null)
      setShowing(draftHtml || draftJs ? 'draft' : 'published')
      setTokens({ input: s.inputTokensThisSession ?? 0, output: s.outputTokensThisSession ?? 0, credits: pick(s, 'creditsLeft', 'credits') ?? null })
      setChat(Array.isArray(s.messages) ? s.messages.map((m) => ({ id: Math.random(), role: m.role === 'user' ? 'user' : 'ai', text: m.text ?? m.content ?? JSON.stringify(m) })) : [])
      setClosedReason('')
      setRunning(null)
      setRenderKey((k) => k + 1)
      setPhase('editor')
      openSocket()
    } catch (err) {
      setProblem(err.message || String(err))
      addLog('error', 'REST', err.message || String(err))
      setPhase('form')
    }
  }

  const disconnect = () => {
    wsRef.current?.close()
    wsRef.current = null
    setPhase('form')
    setSession(null)
    setRunning(null)
  }

  // Selection fields of VibeCodeRequest, as specified in XT2-5697.
  const requestContext = (ctx) => {
    const ms = (day, endOfDay) => (day ? Date.parse(`${day}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`) : null)
    const athleteIds = (ctx?.athleteIds ?? []).map(String)
    return {
      focusedAthlete: athleteIds[0] ?? null,
      athleteIds,
      teamIds: (ctx?.teamIds ?? []).map(String),
      from: ms(ctx?.period?.from, false),
      to: ms(ctx?.period?.to, true),
      timeZoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }
  }

  const askAi = (text) => {
    const requestId = newRequestId()
    const ok = send('VibeCodeRequest', {
      requestId,
      text,
      ...requestContext(previewContextRef.current),
    })
    if (ok) {
      addChat('user', text)
      setRunning(requestId)
    }
  }

  // Don't wait for the server to confirm: unlock the chat right away.
  const cancelRequest = () => {
    send('VibeCodeCancel', { requestId: running })
    addChat('info', 'Cancelled.')
    setRunning(null)
  }

  const simple = (type) => send(type, { requestId: newRequestId() })

  // ---------- Render ----------

  const current = showing === 'draft' && draft ? draft : published

  // Store the widget files on the dev server and point the iframe at them,
  // with the selection in the URL fragment, the way XPS will host it.
  useEffect(() => {
    if (phase !== 'editor') return
    let cancelled = false
    const { html, notes, info } = preparePreviewHtml(current.html, { localSdk: settingsRef.current.localSdk })
    notes.forEach((n) => addLog('error', 'Template', n))
    info.forEach((n) => addLog('info', 'Template', n))
    setFrameHeight(0)
    fetch('/__preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, js: current.js || '' }),
    })
      .then((r) => r.json())
      .then(({ id, error }) => {
        if (cancelled) return
        if (error || !id) throw new Error(error || 'no id')
        setPreviewSrc(widgetUrl(id, previewContextRef.current))
      })
      .catch((err) => !cancelled && addLog('error', 'Preview', `Could not store preview: ${err.message}`))
    return () => {
      cancelled = true
    }
  }, [phase, current.html, current.js, renderKey, addLog])

  const applyContext = (ctx) => {
    setPreviewContext(ctx)
    previewContextRef.current = ctx
    iframeRef.current?.contentWindow?.postMessage({ __xpsHost: 1, kind: 'context', context: ctx }, '*')
    addLog('out', 'Widget', { kind: 'context', context: ctx })
  }

  return (
    <div className="app">
      <header>
        <h1>Custom Widget Demo</h1>
        <span className="sub">Vibe coding test client · FocusedAthlete mode</span>
        {phase === 'editor' && (
          <div className="status">
            <span className={`dot ${wsState}`} /> socket {wsState}
            {closedReason && <span className="badge warn">session {closedReason}</span>}
            <button className="ghost" onClick={disconnect}>Disconnect</button>
          </div>
        )}
      </header>

      {phase !== 'editor' ? (
        <ConnectForm settings={settings} setSettings={setSettings} onConnect={connect} busy={phase === 'connecting'} problem={problem} />
      ) : (
        <main className="editor">
          <section className="left">
            <SessionInfo session={session} draft={draft} tokens={tokens} />
            <Chat chat={chat} running={running} disabled={wsState !== 'open' || !!closedReason} disabledText={closedReason ? `Session ${closedReason}. Disconnect and connect again to keep editing.` : 'Socket not connected'} onSend={askAi} onCancel={cancelRequest} />
            <div className="actions">
              <button disabled={wsState !== 'open' || !!closedReason || !!running} onClick={() => simple('VibeCodeSaveChanges')}>Save</button>
              <button className="primary" disabled={wsState !== 'open' || !!closedReason || !!running} onClick={() => simple('VibeCodePublishChanges')}>Publish</button>
              <button className="danger" disabled={wsState !== 'open' || !!closedReason || !!running} onClick={() => simple('VibeCodeDiscardChanges')}>Discard</button>
              {wsState === 'closed' && !closedReason && <button className="ghost" onClick={openSocket}>Reconnect socket</button>}
            </div>
          </section>
          <section className="right">
            <Preview src={previewSrc} height={frameHeight} context={previewContext} onApplyContext={applyContext} renderKey={renderKey} iframeRef={iframeRef} showing={showing} setShowing={setShowing} hasDraft={!!draft} current={current} onReload={() => setRenderKey((k) => k + 1)} />
          </section>
        </main>
      )}

      <Log log={log} onClear={() => setLog([])} onSendRaw={sendRaw} canSend={wsState === 'open'} />
    </div>
  )
}

function ConnectForm({ settings, setSettings, onConnect, busy, problem }) {
  const set = (k) => (e) => setSettings((s) => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const ready = settings.serverPrefix.trim() && settings.sessionId.trim() && settings.widgetId.trim()
  return (
    <form
      className="connect"
      onSubmit={(e) => {
        e.preventDefault()
        if (ready && !busy) onConnect()
      }}
    >
      <label>
        Server prefix
        <input value={settings.serverPrefix} onChange={set('serverPrefix')} placeholder="https://testsrvr.sidelinesports.com/" />
      </label>
      <label>
        _sessionId <small>authorisation token</small>
        <input value={settings.sessionId} onChange={set('sessionId')} placeholder="1858879978350727931" />
      </label>
      <label>
        widgetId <small>report widget that contains the custom widget</small>
        <input value={settings.widgetId} onChange={set('widgetId')} placeholder="111111111111" />
      </label>

      <details>
        <summary>Advanced</summary>
        <label className="check">
          <input type="checkbox" checked={settings.useProxy} onChange={set('useProxy')} />
          Go through the local dev proxy (avoids CORS; turn off only if the server allows this origin)
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.localSdk} onChange={set('localSdk')} />
          Use the demo's SDK in the preview instead of the one the template points to
        </label>
        <p className="hint">
          Socket messages out look like <code>{'VibeCodeHeartbeat{"vibeCodeSessionId":"…"}'}</code>; messages in look like{' '}
          <code>{'{"msgType":"VibeCodingProgress", …}'}</code> (XT2-5697).
        </p>
      </details>

      {problem && <div className="problem">{problem}</div>}
      <button className="primary" type="submit" disabled={!ready || busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
    </form>
  )
}

function SessionInfo({ session, draft, tokens }) {
  if (!session) return null
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString() : '–')
  return (
    <div className="info">
      <div><b>vibeCodeSessionId</b> {session.vibeCodeSessionId}</div>
      <div><b>widgetId</b> {String(session.widgetId)} · <b>libVersion</b> {session.libVersion ?? '–'}</div>
      <div><b>created</b> {fmt(session.created)} · <b>lastSaved</b> {fmt(session.lastSaved)}</div>
      <div>
        <b>draft</b> {draft ? `v${draft.version ?? '?'}` : 'none (editing the published version)'} · <b>tokens</b> in {tokens.input} / out {tokens.output}
        {tokens.credits !== null && <> · <b>credits</b> {String(tokens.credits)}</>}
      </div>
    </div>
  )
}

function Chat({ chat, running, disabled, disabledText, onSend, onCancel }) {
  const [text, setText] = useState('')
  const endRef = useRef(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [chat])
  const submit = (e) => {
    e.preventDefault()
    const t = text.trim()
    if (!t || running || disabled) return
    onSend(t)
    setText('')
  }
  return (
    <div className="chat">
      <div className="messages">
        {chat.length === 0 && <div className="empty">Ask for a widget, e.g. “Show the text Hello athlete in a big blue box”.</div>}
        {chat.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>{m.text}</div>
        ))}
        {running && <div className="msg progress">Working…</div>}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit}>
        <textarea
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) submit(e)
          }}
          placeholder={disabled ? disabledText : 'Describe the widget… (Enter to send, Shift+Enter for new line)'}
          disabled={disabled}
        />
        {running ? (
          <button type="button" className="danger" onClick={onCancel}>Cancel</button>
        ) : (
          <button className="primary" type="submit" disabled={disabled || !text.trim()}>Send</button>
        )}
      </form>
    </div>
  )
}

function Preview({ src, height, context, onApplyContext, renderKey, iframeRef, showing, setShowing, hasDraft, current, onReload }) {
  const [showCode, setShowCode] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [ctxText, setCtxText] = useState('')
  const [ctxError, setCtxError] = useState('')
  const toggleContext = (on) => {
    setShowContext(on)
    if (on) {
      setCtxText(JSON.stringify(context, null, 2))
      setCtxError('')
    }
  }
  const apply = () => {
    try {
      onApplyContext(JSON.parse(ctxText))
      setCtxError('')
    } catch (e) {
      setCtxError(e.message)
    }
  }
  return (
    <div className="preview">
      <div className="toolbar">
        <div className="seg">
          <button className={showing === 'published' ? 'on' : ''} onClick={() => setShowing('published')}>Published</button>
          <button className={showing === 'draft' ? 'on' : ''} disabled={!hasDraft} onClick={() => setShowing('draft')}>Draft</button>
        </div>
        <button className="ghost" onClick={onReload}>Reload</button>
        <label className="check"><input type="checkbox" checked={showCode} onChange={(e) => setShowCode(e.target.checked)} /> Show code</label>
        <label className="check"><input type="checkbox" checked={showContext} onChange={(e) => toggleContext(e.target.checked)} /> Context</label>
      </div>
      {showContext && (
        <div className="context-editor">
          <textarea rows={8} value={ctxText} onChange={(e) => setCtxText(e.target.value)} spellCheck={false} />
          <div>
            <button onClick={apply}>Send context change</button>
            <span className="hint"> Calls the widget's onContextChange listeners. Reload starts the widget with this context.</span>
            {ctxError && <span className="problem small"> {ctxError}</span>}
          </div>
        </div>
      )}
      {src ? (
        <iframe key={src} ref={iframeRef} title="Widget preview" sandbox="allow-scripts" src={src} style={height ? { height: Math.max(height, 360) + 'px', flex: 'none' } : undefined} />
      ) : (
        <div className="hint">Preparing preview…</div>
      )}
      {showCode && (
        <div className="code">
          <h4>HTML</h4>
          <pre>{current.html || '(empty)'}</pre>
          <h4>JS</h4>
          <pre>{current.js || '(empty)'}</pre>
        </div>
      )}
    </div>
  )
}

function Log({ log, onClear, onSendRaw, canSend }) {
  const [hideHeartbeats, setHideHeartbeats] = useState(true)
  const [raw, setRaw] = useState('')
  const [rawError, setRawError] = useState('')
  const endRef = useRef(null)
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [log])
  const isHeartbeat = (r) => /Heartbeat|"Ping"/.test(typeof r.data === 'string' ? r.data.slice(0, 80) : JSON.stringify(r.data).slice(0, 200))
  const rows = hideHeartbeats ? log.filter((r) => !isHeartbeat(r)) : log
  const sendRaw = () => {
    try {
      if (!decodeOutgoing(raw)) throw new Error('Expected MessageName{...json...}')
      setRawError('')
      onSendRaw(raw.trim())
    } catch (e) {
      setRawError(e.message)
    }
  }
  return (
    <section className="log">
      <div className="toolbar">
        <h3>Message log</h3>
        <label className="check"><input type="checkbox" checked={hideHeartbeats} onChange={(e) => setHideHeartbeats(e.target.checked)} /> Hide heartbeats and pings</label>
        <button className="ghost" onClick={onClear}>Clear</button>
      </div>
      <div className="rows">
        {rows.map((r) => (
          <div key={r.id} className={`row ${r.dir}`}>
            <span className="t">{r.t}</span>
            <span className="ch">{r.channel}</span>
            <span className="dir">{{ out: '→', in: '←', info: '·', error: '!' }[r.dir]}</span>
            <pre>{typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)}</pre>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="raw">
        <textarea rows={2} value={raw} onChange={(e) => setRaw(e.target.value)} placeholder='Send a raw frame over the socket, e.g. VibeCodeResume{"vibeCodeSessionId":"…"}' />
        <button disabled={!canSend || !raw.trim()} onClick={sendRaw}>Send raw</button>
        {rawError && <span className="problem small">{rawError}</span>}
      </div>
    </section>
  )
}
