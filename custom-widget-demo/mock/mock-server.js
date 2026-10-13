// Tiny fake XPS server for trying the demo without a real backend.
//   node mock/mock-server.js        → http://localhost:8099/
// Then use http://localhost:8099/ as the server prefix in the app.
// Use widgetId "locked" to see the "problem" reply.
import http from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8099)

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/xpsweb/')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const b = JSON.parse(body || '{}')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (b.widgetId === 'locked') return res.end(JSON.stringify({ problem: 'This widget is already locked by John' }))
      res.end(
        JSON.stringify({
          success: {
            vibeCodeSessionId: String(Math.floor(Math.random() * 1e9)),
            createdBy: 0, lastSavedBy: 0, widgetId: b.widgetId, lockedBy: 0,
            publishedHtml: '<p style="font-family:sans-serif">Published version</p>',
            publishedJs: '',
            created: Date.now(), lastSaved: Date.now(), libVersion: '1',
            inputTokensThisSession: 0, outputTokensThisSession: 0,
          },
        }),
      )
    })
    return
  }
  res.writeHead(404).end()
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/websockets/events/')) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

wss.on('connection', (ws) => {
  let version = 0
  let tokens = 0
  const out = (type, payload) => ws.send(JSON.stringify({ type, ...payload }))
  ws.on('message', (data) => {
    const m = JSON.parse(data)
    const t = String(m.type || '').split('.').pop()
    const { requestId, vibeCodeSessionId } = m
    if (t === 'VibeCodeRequest') {
      out('VibeCodingProgress', { requestId, vibeCodeSessionId, text: 'Thinking about your widget…' })
      setTimeout(() => {
        version++
        const broken = /error|broken/i.test(m.text)
        out('VibeCodingDraftUpdated', {
          requestId, vibeCodeSessionId, draftVersion: version,
          html: `<div style="font-family:sans-serif;padding:16px;background:#dbeafe;border-radius:8px"><h2>${m.text.replace(/</g, '&lt;')}</h2><p id="x"></p></div>`,
          js: broken ? 'thisFunctionDoesNotExist()' : `document.getElementById('x').textContent = 'Draft v${version} rendered at ' + new Date().toLocaleTimeString()`,
        })
      }, 600)
      ws.pending = { requestId, vibeCodeSessionId }
    } else if (t === 'VibeCodePreviewReport') {
      out('VibeCodingProgress', { requestId, vibeCodeSessionId, text: `Preview report: ${m.jsErrors.length} error(s)` })
      tokens += 1234
      out('VibeCodingRequestEnded', {
        requestId, vibeCodeSessionId, draftVersion: version,
        message: m.jsErrors.length ? 'The draft had errors (a real agent would fix them now).' : 'Done! Your widget is in the preview.',
        inputTokensThisSession: tokens, outputTokensThisSession: Math.round(tokens / 4),
      })
    } else if (t === 'VibeCodeCancel') {
      out('VibeCodingRequestEnded', { requestId, vibeCodeSessionId, error: 'Cancelled' })
    } else if (t === 'VibeCodePublishChanges') {
      out('VibeCodingPublishResult', { requestId, vibeCodeSessionId, ok: true })
      out('VibeCodingSessionClosed', { vibeCodeSessionId, reason: 'published' })
    } else if (t === 'VibeCodeDiscardChanges') {
      out('VibeCodingSessionClosed', { vibeCodeSessionId, reason: 'discarded' })
    } else if (t === 'VibeCodeSaveChanges') {
      out('VibeCodeAck', { requestId, vibeCodeSessionId, ok: true })
    }
  })
})

server.listen(PORT, () => console.log(`Mock XPS server on http://localhost:${PORT}/`))
