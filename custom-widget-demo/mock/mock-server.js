// Tiny fake XPS server for trying the demo without a real backend.
//   node mock/mock-server.js        → http://localhost:8099/
// Then use http://localhost:8099/ as the server prefix in the app.
// Use widgetId "locked" to see the "problem" reply.
import http from 'node:http'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8099)

// Widget data queries (XT2-5705). Same reply shape for every query: { result, denied? } or { error }.
const MOCK_TEAMS = [
  { id: '1001', name: 'First team' },
  { id: '1002', name: 'U19' },
  { id: '1003', name: 'U17' },
]
// Only teams.get returns the parent team. "Youth" (1000) is a team the viewer is not in, so teams.get on it gives no rows.
const MOCK_PARENTS = { '1002': { id: '1000', name: 'Youth' }, '1003': { id: '1000', name: 'Youth' } }
// A coloured circle with initials, as a data: URL, so the mock needs no image files.
const avatar = (initials, color, size) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
      `<circle cx="50" cy="50" r="50" fill="${color}"/>` +
      `<text x="50" y="62" font-family="sans-serif" font-size="36" fill="#fff" text-anchor="middle">${initials}</text></svg>`,
  )
// teamIds: teams where the athlete is required; optionalTeamIds: teams where the athlete is optional.
const athlete = (id, firstName, lastName, teamIds, color, { hidden = false, optionalTeamIds = [] } = {}) => ({
  id, firstName, lastName, teamIds, optionalTeamIds, hidden,
  profileImgUrl: color ? avatar(firstName[0] + lastName[0], color, 400) : null,
  profileImgUrlThumb: color ? avatar(firstName[0] + lastName[0], color, 64) : null,
})
// hidden: the viewer may not see this athlete, so it shows up in "denied" instead of "result".
const MOCK_ATHLETES = [
  athlete('2001', 'Anna', 'Jónsdóttir', ['1001'], '#2563eb'),
  athlete('2002', 'Bjarki', 'Pálsson', ['1001'], '#16a34a'),
  athlete('2003', 'Elín', 'Sigurðardóttir', ['1001'], null, { optionalTeamIds: ['1002'] }), // no picture
  athlete('2004', 'Gunnar', 'Ólafsson', ['1002'], '#dc2626'),
  athlete('2005', 'Hekla', 'Einarsdóttir', ['1002'], '#9333ea'),
  athlete('2006', 'Kári', 'Magnússon', ['1003'], '#ea580c', { optionalTeamIds: ['1002'] }),
  athlete('2007', 'Sara', 'Björnsdóttir', ['1003'], '#0891b2', { hidden: true }),
]

const unknownParam = (params, known, name) => {
  const bad = Object.keys(params || {}).find((k) => !known.includes(k))
  if (!bad) return null
  return known.length
    ? `Unknown parameter '${bad}' for ${name}. Known: ${known.join(', ')}`
    : `Unknown parameter '${bad}' for ${name}. It takes no parameters`
}

// club.info: the club that owns the widget. The logo is drawn like the athletes' avatars.
const clubLogo = (size) =>
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">` +
      `<path d="M50 4 L92 20 V52 C92 76 72 92 50 98 C28 92 8 76 8 52 V20 Z" fill="#1e3a8a"/>` +
      `<text x="50" y="64" font-family="sans-serif" font-size="34" font-weight="bold" fill="#facc15" text-anchor="middle">SC</text></svg>`,
  )
const MOCK_CLUB = {
  id: '900',
  name: 'Sideline Sports Club',
  logoUrl: clubLogo(400),
  logoUrlThumb: clubLogo(64),
  usesSoccerReports: true,
  genericMatchReportSports: [{ id: '31', name: 'Handball' }],
}

// tests.templates: a few made-up test templates, incl. a combined one. Color ranges always have both ends.
const range = (from, to, hexColor) => ({ from, to, hexColor })
const test = (id, name, unitName, type, colorRanges = [], subTestIds = []) => ({ id, name, unitName, type, subTestIds, colorRanges })
const SLEEP_QUALITY = test('3004', 'Sleep quality', '1-10', 'Simple', [range(1, 5, '#DC2626'), range(5, 7, '#F59E0B'), range(7, 11, '#16A34A')])
const SLEEP_DURATION = test('3005', 'Sleep duration', 'h', 'Simple', [range(0, 6, '#DC2626'), range(6, 8, '#F59E0B'), range(8, 24, '#16A34A')])
const MOCK_TEST_TEMPLATES = [
  test('3001', 'Countermovement jump', 'cm', 'Simple', [range(0, 30, '#DC2626'), range(30, 40, '#F59E0B'), range(40, 100, '#16A34A')]),
  test('3002', '30 m sprint', 's', 'Simple', [range(3, 4.2, '#16A34A'), range(4.2, 4.6, '#F59E0B'), range(4.6, 8, '#DC2626')]),
  test('3003', 'Body weight', 'kg', 'Simple'),
  SLEEP_QUALITY,
  SLEEP_DURATION,
  test('3006', 'Sleep score', '%', 'Combined', [range(0, 60, '#DC2626'), range(60, 80, '#F59E0B'), range(80, 101, '#16A34A')], ['3004', '3005']),
  test('3007', 'BMI', null, 'Calculated', [range(18.5, 25, '#16A34A')]),
]

// tests.get: made-up results for every athlete and simple/calculated test, every 14 days for the last year,
// with the same numbers every time (a small hash instead of Math.random). The combined Sleep score is an error here.
const DAY = 86400000
const MAX_TEST_RESULT_ROWS = 50000 // same as TestResultsReply.MAX_ROWS on the server
const RESULT_BASE = { '3001': [35, 8], '3002': [4.4, 0.3], '3003': [75, 6], '3004': [7, 2], '3005': [7.5, 1.2], '3007': [23, 2] }
// FNV-1a plus a final mix, so neighbouring strings like "…0" and "…1" give very different numbers in [0, 1)
const hash = (s) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
// txtValue: Sleep quality gets words, Sleep duration gets h:mm; the rest are plain numbers (null).
function mockTxtValue(templateId, value) {
  if (templateId === '3004') return value < 5 ? 'Bad' : value < 7 ? 'Alright' : 'Good'
  if (templateId === '3005') {
    const minutes = Math.round(value * 60)
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
  }
  return null
}

function mockTestResults() {
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const rows = []
  for (const a of MOCK_ATHLETES)
    for (const [templateId, [mid, spread]] of Object.entries(RESULT_BASE))
      for (let i = 0; i < 26; i++) {
        const time = today.getTime() - (i * 14 + Math.floor(hash(a.id + templateId) * 14)) * DAY
        const value = Math.round((mid + (hash(a.id + templateId + i) - 0.5) * 2 * spread) * 100) / 100
        rows.push({ id: `r${a.id}-${templateId}-${i}`, athleteId: a.id, testTemplateId: templateId, value, txtValue: mockTxtValue(templateId, value), time })
      }
  return rows.sort((x, y) => x.time - y.time)
}

function answerQuery(q) {
  if (!q.widgetId && !q.vibeCodeSessionId) return { error: 'Missing widgetId or vibeCodeSessionId' }
  const params = q.params || {}
  if (q.name === 'club.info') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: [MOCK_CLUB] }
  }
  if (q.name === 'tests.templates') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: MOCK_TEST_TEMPLATES }
  }
  if (q.name === 'tests.get') {
    const err = unknownParam(params, ['athleteIds', 'testTemplateIds', 'from', 'to'], q.name)
    if (err) return { error: err }
    const { athleteIds, testTemplateIds, from, to } = params
    const { timeZoneName } = q // added by the SDK, next to name and params
    for (const [key, ids] of [['athleteIds', athleteIds], ['testTemplateIds', testTemplateIds]]) {
      if (!Array.isArray(ids) || !ids.length) return { error: `Missing parameter '${key}' for tests.get: give at least one id` }
      if (ids.some((id) => typeof id !== 'string' || !id)) return { error: `${key} for tests.get must be an array of non-empty strings` }
    }
    for (const [key, v] of [['from', from], ['to', to]])
      if (v != null && !Number.isInteger(v)) return { error: `Parameter '${key}' for tests.get must be a number (epoch milliseconds)` }
    if (from != null && to != null && from > to) return { error: "Parameter 'from' for tests.get is after 'to'" }
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const combined = testTemplateIds.find((id) => MOCK_TEST_TEMPLATES.find((t) => t.id === id)?.type === 'Combined')
    if (combined)
      return { error: `Test template ${combined} is a Combined test. tests.get only returns Simple and Calculated tests; Combined test scores aren't available yet.` }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const known = new Set(MOCK_TEST_TEMPLATES.map((t) => t.id))
    const denied = athleteIds.filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id))
    const missingTestTemplateIds = testTemplateIds.filter((id) => !known.has(id))
    const result = mockTestResults().filter(
      (r) =>
        athleteIds.includes(r.athleteId) && !hidden.has(r.athleteId) && testTemplateIds.includes(r.testTemplateId) &&
        (from == null || r.time >= from) && (to == null || r.time <= to),
    )
    if (result.length > MAX_TEST_RESULT_ROWS)
      return { error: `More than ${MAX_TEST_RESULT_ROWS} results. Ask for fewer athletes, fewer tests or a shorter period.` }
    return { result, denied, missingTestTemplateIds }
  }
  if (q.name === 'teams.list') {
    const err = unknownParam(params, [], q.name)
    return err
      ? { error: err }
      : { result: MOCK_TEAMS.map((t) => ({ ...t, parentTeamId: MOCK_PARENTS[t.id]?.id ?? null, parentTeamName: MOCK_PARENTS[t.id]?.name ?? null })) }
  }
  if (q.name === 'athletes.list') {
    const err = unknownParam(params, ['athleteId', 'teamIds'], q.name)
    if (err) return { error: err }
    const { athleteId, teamIds } = params
    if (athleteId != null && typeof athleteId !== 'string' && typeof athleteId !== 'number')
      return { error: 'Bad parameters for athletes.list: athleteId must be a string and teamIds an array of strings' }
    if (teamIds != null && (!Array.isArray(teamIds) || teamIds.some((t) => typeof t !== 'string' && typeof t !== 'number')))
      return { error: 'Bad parameters for athletes.list: athleteId must be a string and teamIds an array of strings' }
    const matches = MOCK_ATHLETES.filter(
      (a) =>
        (athleteId == null || a.id === String(athleteId)) &&
        (teamIds == null || [...a.teamIds, ...a.optionalTeamIds].some((t) => teamIds.map(String).includes(t))),
    )
    const result = matches
      .filter((a) => !a.hidden)
      .map(({ id, firstName, lastName, profileImgUrl, profileImgUrlThumb }) => ({ id, firstName, lastName, profileImgUrl, profileImgUrlThumb }))
    const denied = matches.filter((a) => a.hidden).map((a) => a.id)
    return denied.length ? { result, denied } : { result }
  }
  if (q.name === 'teams.get') {
    const err = unknownParam(params, ['teamId'], q.name)
    if (err) return { error: err }
    if (params.teamId == null) return { error: "Missing parameter 'teamId' for teams.get" }
    if (typeof params.teamId !== 'string' && typeof params.teamId !== 'number')
      return { error: "Parameter 'teamId' for teams.get must be a string" }
    const teamId = String(params.teamId)
    const team = MOCK_TEAMS.find((t) => t.id === teamId)
    if (!team) return { result: [], denied: [teamId] }
    const visible = MOCK_ATHLETES.filter((a) => !a.hidden)
    const denied = MOCK_ATHLETES.filter((a) => a.hidden && (a.teamIds.includes(teamId) || a.optionalTeamIds.includes(teamId))).map((a) => a.id)
    const row = {
      ...team,
      parentTeamId: MOCK_PARENTS[teamId]?.id ?? null,
      parentTeamName: MOCK_PARENTS[teamId]?.name ?? null,
      requiredAthleteIds: visible.filter((a) => a.teamIds.includes(teamId)).map((a) => a.id),
      optionalAthleteIds: visible.filter((a) => a.optionalTeamIds.includes(teamId)).map((a) => a.id),
    }
    return denied.length ? { result: [row], denied } : { result: [row] }
  }
  return { error: `Unknown query '${q.name}'. Known: club.info, teams.list, teams.get, athletes.list, tests.templates, tests.get` }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/xpsweb/vw/query')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      let q
      try {
        q = JSON.parse(body || '{}')
      } catch (e) {
        return res.end(JSON.stringify({ error: e.message }))
      }
      res.end(JSON.stringify(answerQuery(q)))
    })
    return
  }
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
            createdBy: '1', lastSavedBy: '1', widgetId: String(b.widgetId), lockedBy: String(b._sessionId), draftVersion: 0,
            publishedHtml: '<!doctype html><html><head><meta charset="utf-8"></head><body>'
              + '<main id="app" style="font-family:sans-serif">Published version</main>'
              + '<script src="/vibe-coding-sdk/1/xps.js"></script><script type="module" src="./widget.js"></script></body></html>',
            publishedJs: 'xps.resize()',
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

// Per vibe coding session, so a reconnect (a new socket) can get it back with VibeCodeResume.
const SESSIONS = new Map()
const sessionState = (id) => {
  if (!SESSIONS.has(id)) SESSIONS.set(id, { version: 0, tokens: 0, html: null, js: null, conversation: [], running: null })
  return SESSIONS.get(id)
}

wss.on('connection', (ws) => {
  // Wire format as in XT2-5697: in = Name{json}, out = {"msgType": Name, ...}
  const out = (msgType, payload) => ws.send(JSON.stringify({ msgType, ...payload }))
  out('Connection', { msg: 'connected' })
  ws.on('message', (data) => {
    const frame = String(data)
    const i = frame.indexOf('{')
    if (i <= 0) return out('OutgoingError', { msg: 'No class name or JSON found in message' })
    let m
    try {
      m = JSON.parse(frame.slice(i))
    } catch (e) {
      return out('OutgoingError', { msg: e.message })
    }
    const t = frame.slice(0, i).trim().split('.').pop()
    const { requestId, vibeCodeSessionId } = m
    const st = sessionState(vibeCodeSessionId)
    if (t === 'VibeCodeRequest') {
      st.running = { requestId, text: String(m.text ?? '') }
      out('VibeCodingProgress', { requestId, vibeCodeSessionId, text: 'Thinking about your widget…' })
      setTimeout(() => {
        const version = ++st.version
        const broken = /error|broken/i.test(m.text)
        const draft = {
          requestId, vibeCodeSessionId, draftVersion: version,
          html: `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0">
<main id="app" style="font-family:sans-serif;padding:16px;background:#dbeafe;border-radius:8px"><h2>${m.text.replace(/</g, '&lt;')}</h2><p id="x"></p></main>
<script src="/vibe-coding-sdk/1/xps.js"></script>
<script type="module" src="./widget.js"></script>
</body></html>`,
          js: broken
            ? 'thisFunctionDoesNotExist()'
            : `document.getElementById('x').textContent = 'Draft v${version} · ' + (xps.context.athleteIds || []).length + ' athlete(s) selected'\nxps.resize()`,
        }
        st.html = draft.html
        st.js = draft.js
        out('VibeCodingDraftUpdated', draft)
      }, 600)
      ws.pending = { requestId, vibeCodeSessionId }
    } else if (t === 'VibeCodePreviewReport') {
      out('VibeCodingProgress', { requestId, vibeCodeSessionId, text: `Preview report: ${m.jsErrors.length} error(s)` })
      st.tokens += 1234
      const text = m.jsErrors.length ? 'The draft had errors (a real agent would fix them now).' : 'Done! Your widget is in the preview.'
      if (st.running) st.conversation.push({ who: 'user', text: st.running.text, when: Date.now() }, { who: 'ai', text, when: Date.now() })
      st.running = null
      out('VibeCodingRequestEnded', {
        requestId, vibeCodeSessionId, draftVersion: st.version, text,
        inputTokensThisSession: st.tokens, outputTokensThisSession: Math.round(st.tokens / 4),
      })
    } else if (t === 'VibeCodeCancel') {
      st.running = null
      out('VibeCodingRequestEnded', { requestId, vibeCodeSessionId, cancelled: true })
    } else if (t === 'VibeCodePublishChanges') {
      out('VibeCodingPublishResult', { requestId, vibeCodeSessionId, ok: true, publishedDraftVersion: st.version })
      out('VibeCodingSessionClosed', { vibeCodeSessionId, reason: 'published' })
    } else if (t === 'VibeCodeDiscardChanges') {
      out('VibeCodingSessionClosed', { vibeCodeSessionId, reason: 'discarded' })
    } else if (t === 'VibeCodeResume') {
      // Same fields as VibeCodingSessionState on the server.
      out('VibeCodingSessionState', {
        requestId, vibeCodeSessionId,
        hasDraft: st.html !== null, html: st.html, js: st.js, draftVersion: st.version,
        conversation: st.conversation,
        runningRequestId: st.running?.requestId ?? null, runningRequestText: st.running?.text ?? null,
        inputTokensThisSession: st.tokens, outputTokensThisSession: Math.round(st.tokens / 4),
      })
    } else if (t === 'VibeCodeHeartbeat' || t === 'VibeCodeSaveChanges') {
      // nothing to answer
    } else {
      out('OutgoingError', { msg: t })
    }
  })
})

server.listen(PORT, () => console.log(`Mock XPS server on http://localhost:${PORT}/`))
