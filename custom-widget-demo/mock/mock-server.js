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
  // More first-team players, so soccer reports have full lineups. No pictures.
  ...[['Dagur', 'Árnason'], ['Freyr', 'Gíslason'], ['Ísak', 'Halldórsson'], ['Jóhann', 'Kristjánsson'],
    ['Logi', 'Már'], ['Ómar', 'Níelsson'], ['Pétur', 'Ragnarsson'], ['Rúnar', 'Steinsson'],
    ['Sindri', 'Tómasson'], ['Tryggvi', 'Unnarsson'], ['Viktor', 'Þórsson']].map(([f, l], i) => athlete(String(2101 + i), f, l, ['1001'], null)),
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

// information.templates: made-up information templates. Options templates list their texts in XPS's order
// (not alphabetical); MultipleOptions allow several of them; Plain ones take any text and have no options.
const MOCK_INFORMATION_TEMPLATES = [
  { id: '5001', name: 'Injury status', regMode: 'Options', options: ['Fit', 'Limited training', 'Injured', 'Ill'] },
  { id: '5002', name: 'Position', regMode: 'Options', options: ['Goalkeeper', 'Defender', 'Midfielder', 'Forward'] },
  { id: '5003', name: 'Coach notes', regMode: 'Plain', options: [] },
  { id: '5005', name: 'Preferred training', regMode: 'MultipleOptions', options: ['Speed', 'Strength', 'Endurance', 'Technique'] },
  { id: '5004', name: 'Diet', regMode: 'Plain', options: [] },
]

// load.templates: made-up training load templates, and the club's RPE scale (rpeSettings, next to result).
// max: null means 10. Labels only for some values, like a club that named a few of them.
const MOCK_LOAD_TEMPLATES = [
  { id: '4001', name: 'Training session RPE' },
  { id: '4002', name: 'Match load' },
  { id: '4003', name: 'Gym session' },
]
const MOCK_RPE_SETTINGS = {
  rpeName: 'Intensity', // what this club calls RPE; null means "RPE"
  max: null,
  labels: [
    { value: 0, name: 'Rest' },
    { value: 1, name: 'Very easy' },
    { value: 3, name: 'Moderate' },
    { value: 5, name: 'Hard' },
    { value: 7, name: 'Very hard' },
    { value: 10, name: 'Extremely hard' },
  ],
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
const MAX_TEST_RESULT_ROWS = 50000 // same as TestResultsReply.MAX_ROWS and TrainingLoadReply.MAX_ROWS on the server
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

// load.get: made-up training load for the last year. Each athlete has a practice most weekdays, a match on
// Saturdays and gym on Tuesdays and Thursdays: Thursday's is a "Strength workout" session, Tuesday's isn't part of a session. A few entries lack minutes
// or have a decimal RPE, like real data can.
function mockTrainingLoad() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const rows = []
  for (const a of MOCK_ATHLETES)
    for (let d = 0; d < 365; d++) {
      const day = new Date(today.getTime() - d * DAY)
      const wd = day.getDay()
      const add = (templateId, hour, minutes, rpe, sessionName, sessionType) => {
        const h = hash(a.id + templateId + d)
        if (h < 0.1) return // missed it
        rows.push({
          id: `l${a.id}-${templateId}-${d}`, athleteId: a.id, trainingLoadTemplateId: templateId,
          minutes: h > 0.97 ? null : minutes,
          rpe: h < 0.15 ? rpe + 0.5 : rpe,
          load: null, // filled in below
          time: day.getTime() + hour * 3600000,
          sessionName,
          sessionType,
        })
      }
      if (wd >= 1 && wd <= 5) add('4001', 17, 60 + Math.round(hash(a.id + d) * 6) * 5, 3 + Math.floor(hash(d + a.id) * 5), 'Team practice', 'Practice')
      if (wd === 6) add('4002', 14, 90, 7 + Math.floor(hash(a.id + 'm' + d) * 3), 'Match vs Northside FC', 'Game')
      if (wd === 2 || wd === 4) add('4003', 8, 45, 4 + Math.floor(hash(a.id + 'g' + d) * 3), ...(wd === 4 ? ['Strength workout', 'Workout'] : [null, null]))
    }
  for (const r of rows) r.load = r.minutes == null || r.rpe == null ? null : r.minutes * r.rpe
  return rows.sort((x, y) => x.time - y.time)
}

// information.get: made-up registrations for the last year. Injury status every second week (before ~5 months ago
// the club had the option "Doubtful", since removed: old rows keep it), Position once, Preferred training
// (MultipleOptions) every two months with one to three choices, and Coach notes now and then. Diet has none.
// Registered by one of two coaches, or (for some injury statuses) by the athlete: registeredById === athleteId.
const MOCK_COACHES = [{ id: '3101', name: 'Jón Coach' }, { id: '3102', name: 'Katrín Physio' }]
const by = (who) => ({ registeredById: who.id, registeredByName: who.name })
const NOTES = ['Good session, sharp in duels.', 'Tired after travel.\nRest tomorrow.', 'Working on left foot.', 'Back to full training next week.']
function mockInformation() {
  const today = new Date()
  today.setHours(10, 0, 0, 0)
  const rows = []
  const injury = MOCK_INFORMATION_TEMPLATES.find((t) => t.id === '5001').options
  const training = MOCK_INFORMATION_TEMPLATES.find((t) => t.id === '5005').options
  const positions = MOCK_INFORMATION_TEMPLATES.find((t) => t.id === '5002').options
  for (const a of MOCK_ATHLETES) {
    rows.push({ id: `i${a.id}-5002`, athleteId: a.id, informationTemplateId: '5002', texts: [positions[Math.floor(hash(a.id + 'p') * 4)]], time: today.getTime() - 300 * DAY, ...by(MOCK_COACHES[0]) })
    for (let w = 0; w < 26; w++) {
      const d = w * 14 + Math.floor(hash(a.id + 'i' + w) * 7)
      const h = hash(a.id + 'inj' + w)
      const text = d > 150 && h > 0.85 ? 'Doubtful' : injury[h < 0.75 ? 0 : h < 0.85 ? 1 : h < 0.95 ? 2 : 3]
      rows.push({ id: `i${a.id}-5001-${w}`, athleteId: a.id, informationTemplateId: '5001', texts: [text], time: today.getTime() - d * DAY,
        ...(h < 0.4 ? by({ id: a.id, name: `${a.firstName} ${a.lastName}` }) : by(MOCK_COACHES[1])) })
      if (w % 4 === 0) {
        const chosen = training.filter((_, k) => hash(a.id + 't' + w + k) < 0.45)
        rows.push({ id: `i${a.id}-5005-${w}`, athleteId: a.id, informationTemplateId: '5005', texts: chosen.length ? chosen : [training[0]], time: today.getTime() - (d + 1) * DAY, ...by(MOCK_COACHES[0]) })
      }
      if (hash(a.id + 'n' + w) < 0.3)
        rows.push({ id: `i${a.id}-5003-${w}`, athleteId: a.id, informationTemplateId: '5003', texts: [NOTES[Math.floor(hash(a.id + 'nn' + w) * NOTES.length)]], time: today.getTime() - (d + 2) * DAY, ...by(MOCK_COACHES[hash(a.id + 'c' + w) < 0.5 ? 0 : 1]) })
    }
  }
  return rows.sort((x, y) => x.time - y.time)
}

// games.list: made-up games for the last year and the next two months. First team (1001) plays soccer on Saturdays,
// U19 (1002) handball (a generic match report sport, as in club.info) on Sundays, and U17 (1003) has a monthly judo
// tournament: neither soccer nor a generic sport, so no match report. athleteIds filters on the game's members list
// (expected to take part, maybe only on the bench): athletes are members of their own teams' games, optional
// athletes (e.g. 2003 and 2006 in 1002) of about half of them.
// sessiontags.get: made-up session tags. "Recovery" is for practices and workouts only, so includeGameTags leaves it out.
const tag = (id, name, hexColorBg, hexColorFg, kinds) => ({
  id, name, hexColorBg, hexColorFg,
  game: kinds.includes('g'), practice: kinds.includes('p'), event: kinds.includes('e'), workout: kinds.includes('w'),
})
const MOCK_SESSION_TAGS = [
  tag('7004', 'Friendly game', '#0ea5e9', '#FFFFFF', 'g'),
  tag('7003', 'League game', '#1e3a8a', '#FFFFFF', 'g'),
  tag('7002', 'Played on artificial grass', '#a3e635', '#1a2e05', 'gp'),
  tag('7001', 'Played on grass', '#15803d', '#FFFFFF', 'gp'),
  tag('7005', 'Recovery', '#f59e0b', '#222222', 'pw'),
].sort((a, b) => a.name.localeCompare(b.name))

// soccerreports.templates: made-up soccer match report fields of all four types, and goal types.
// NumericalOptions options have a value; TextOptions ones don't (data refers to them by id).
const opts = (pairs) => pairs.map(([id, name, value = null]) => ({ id, name, value }))
const MOCK_SOCCER_TEMPLATES = {
  gameFields: [
    { id: '8001', name: 'Number of spectators', type: 'Numerical', options: [] },
    { id: '8002', name: 'Weather', type: 'TextOptions', options: opts([['8101', 'Sunny'], ['8102', 'Cloudy'], ['8103', 'Rain'], ['8104', 'Snow']]) },
    { id: '8003', name: 'Pitch condition', type: 'NumericalOptions', options: opts([['8111', 'Poor', 1], ['8112', 'OK', 2], ['8113', 'Good', 3], ['8114', 'Excellent', 4]]) },
    { id: '8004', name: 'Match summary', type: 'Text', options: [] },
  ],
  participationFields: [
    { id: '8011', name: 'Player grade', type: 'NumericalOptions', options: opts([['8121', 'Weak', 1], ['8122', 'Below par', 2], ['8123', 'Average', 3], ['8124', 'Good', 4], ['8125', 'Outstanding', 5]]) },
    { id: '8012', name: 'Distance covered (km)', type: 'Numerical', options: [] },
    { id: '8013', name: 'Position played', type: 'TextOptions', options: opts([['8131', 'Goalkeeper'], ['8132', 'Defender'], ['8133', 'Midfielder'], ['8134', 'Forward']]) },
    { id: '8014', name: 'Coach comment', type: 'Text', options: [] },
  ],
  goalTypes: { id: '8020', name: 'Goal type', type: 'TextOptions', options: opts([['8141', 'Open play'], ['8142', 'Penalty'], ['8143', 'Free kick'], ['8144', 'Corner'], ['8145', 'Own goal']]) },
}

// soccerreports.formations: made-up formations. Own goal at the top: y 0 = own goal line, 1 = opponent's;
// goalkeeper about 0.1, strikers about 0.8. x 0..1 across the drawing.
// Position id = its code ("GK", "LCB", ...), unique within the formation; name is the same text.
const line = (y, codes) => codes.map((code, i) => ({ id: code, name: code, x: Math.round(((i + 1) / (codes.length + 1)) * 100) / 100, y }))
const formation = (id, name, rows) => ({
  id, name,
  positions: [{ id: 'GK', name: 'GK', x: 0.5, y: 0.1 }, ...rows.flatMap(([y, codes]) => line(y, codes))],
})
const MOCK_FORMATIONS = [
  formation('101', '4-4-2', [[0.3, ['LB', 'LCB', 'RCB', 'RB']], [0.55, ['LM', 'LCM', 'RCM', 'RM']], [0.8, ['LS', 'RS']]]),
  formation('102', '4-3-3', [[0.3, ['LB', 'LCB', 'RCB', 'RB']], [0.52, ['LCM', 'CM', 'RCM']], [0.78, ['LW', 'ST', 'RW']]]),
  formation('103', '3-5-2', [[0.3, ['LCB', 'CB', 'RCB']], [0.55, ['LWB', 'LCM', 'CDM', 'RCM', 'RWB']], [0.8, ['LS', 'RS']]]),
]

const OPPONENTS = ['Northside FC', 'Harbour United', 'Valley Rovers', 'Eastfield', 'Lakeside']
function mockGames() {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const games = []
  for (let d = -365; d <= 60; d++) {
    const day = new Date(start.getTime() + d * DAY)
    const wd = day.getDay()
    const opp = OPPONENTS[(d + 400) % OPPONENTS.length]
    if (wd === 6)
      games.push({ id: `g1001-${d + 365}`, time: day.getTime() + 15 * 3600000, label: `SC - ${opp}`, teamId: '1001', soccer: true, genericSport: null,
        // Mostly league games, every fifth a friendly; on grass in summer (May-Sep), else artificial grass.
        sessionTagIds: [(d + 400) % 5 === 0 ? '7004' : '7003', day.getMonth() >= 4 && day.getMonth() <= 8 ? '7001' : '7002'] })
    if (wd === 0)
      games.push({ id: `g1002-${d + 365}`, time: day.getTime() + 13 * 3600000, label: `SC U19 - ${opp}`, teamId: '1002', soccer: false, genericSport: { id: '31', name: 'Handball' },
        sessionTagIds: [(d + 400) % 3 === 0 ? '7004' : '7003'] })
    if (day.getDate() === 15)
      games.push({ id: `g1003-${d + 365}`, time: day.getTime() + 10 * 3600000, label: 'Judo tournament', teamId: '1003', soccer: false, genericSport: null, sessionTagIds: [] })
  }
  return games
}
const tookPart = (athlete, game) =>
  athlete.teamIds.includes(game.teamId) || (athlete.optionalTeamIds.includes(game.teamId) && hash(athlete.id + game.id) < 0.5)

// soccerreports.get: made-up reports for the first team's past soccer games (every tenth has no report: denied).
// Uses formation 101 (4-4-2) for us, 102 (4-3-3) for the opponent, the mock soccer templates' ids, and one removed
// weather option ("Fog", id 8199) that soccerreports.templates no longer lists, to show valueName.
const OPP_NAMES = ['Ben', 'Carl', 'Dan', 'Eric', 'Finn', 'Glen', 'Hugo', 'Ivan', 'Jon', 'Kai', 'Leo', 'Max', 'Noel', 'Otto']
function mockSoccerReport(game, n) {
  const r = (k) => hash(game.id + k)
  const pick = (arr, k) => arr[Math.floor(r(k) * arr.length) % arr.length]
  const minutes = 90
  const team = (players, formationId, prefix) => {
    const positions = MOCK_FORMATIONS.find((f) => f.id === formationId).positions.map((p) => p.id)
    const starters = players.slice(0, 11), subs = players.slice(11, 14)
    const participations = []
    // Two substitutions: the sub takes the starter's position at minute 60-85.
    const subbedAt = {}
    subs.slice(0, 2).forEach((s, i) => (subbedAt[starters[10 - i].id] = { sub: s, minute: 60 + Math.floor(r(prefix + 'sub' + i) * 25) }))
    starters.forEach((p, i) => {
      const off = subbedAt[p.id]
      participations.push({ ...p, shirtNr: i + 1, lines: [{ minuteIn: 0, minuteOut: off ? off.minute : null, position: positions[i],
        grade: 4 + Math.floor(r(prefix + 'g' + i) * 6), comment: r(prefix + 'c' + i) < 0.1 ? 'Strong in the air.' : null,
        participationExtraFields: [{ templateId: '8012', valueId: null, valueName: null, number: Math.round((6 + r(prefix + 'd' + i) * 6) * 10) / 10 }] }] })
      if (off) participations.push({ ...off.sub, shirtNr: 12 + (10 - i), lines: [{ minuteIn: off.minute, minuteOut: null, position: positions[i],
        grade: 5 + Math.floor(r(prefix + 'sg' + i) * 4), comment: null, participationExtraFields: [] }] })
    })
    subs.slice(2).forEach((s, i) => participations.push({ ...s, shirtNr: 14 + i, lines: [{ minuteIn: null, minuteOut: null, position: null, grade: null, comment: null, participationExtraFields: [] }] }))
    // Sorted by shirt number, then name, as on the server.
    participations.sort((a, b) => (a.shirtNr ?? -1) - (b.shirtNr ?? -1) || a.name.localeCompare(b.name))
    // Computed fields, as the server's Participation constructor does it.
    for (const p of participations) {
      p.minutesPlayed = p.lines.reduce((m, l) => m + (l.minuteIn == null ? 0 : Math.max(0, (l.minuteOut ?? minutes) - l.minuteIn)), 0)
      p.started = p.lines.some((l) => l.minuteIn === 0)
      const g = p.lines.filter((l) => l.grade != null)
      p.grade = g.length ? g.reduce((s, l) => s + l.grade, 0) / g.length : null
    }
    return { participations, formationId }
  }
  const ours = MOCK_ATHLETES.filter((a) => a.teamIds.includes('1001')).slice(0, 14).map((a) => ({ id: a.id, isXps: true, name: `${a.firstName} ${a.lastName}` }))
  const theirs = OPP_NAMES.map((f, i) => ({ id: `o${n}-${i}`, isXps: false, name: `${f} ${game.label.split(' - ')[1].split(' ')[0]}` }))
  const us = team(ours, '101', 'u'), them = team(theirs, '102', 't')
  const onPitch = (t) => t.participations.filter((p) => p.minutesPlayed > 0)
  const goalTypes = MOCK_SOCCER_TEMPLATES.goalTypes.options
  const goals = (t, other, k) => Array.from({ length: Math.floor(r(k + 'n') * 4) }, (_, i) => {
    const own = r(k + 'own' + i) < 0.06
    const scorer = pick(onPitch(own ? other : t), k + 's' + i)
    const assist = !own && r(k + 'a' + i) < 0.6 ? pick(onPitch(t).filter((p) => p.id !== scorer.id), k + 'as' + i) : null
    const type = own ? goalTypes.find((o) => o.name === 'Own goal') : pick(goalTypes.filter((o) => o.name !== 'Own goal'), k + 'ty' + i)
    return { playerId: scorer.id, minute: 1 + Math.floor(r(k + 'm' + i) * 89), assistedBy: assist ? assist.id : null,
      secondAssistBy: assist && r(k + 'a2' + i) < 0.3 ? pick(onPitch(t).filter((p) => p.id !== scorer.id && p.id !== assist.id), k + 'a2p' + i).id : null,
      howWasItScored: type.id, howWasItScoredName: type.name, comment: r(k + 'gc' + i) < 0.2 ? 'Great finish.' : null }
  }).sort((a, b) => a.minute - b.minute)
  const cards = (t, k) => Array.from({ length: Math.floor(r(k + 'cn') * 3) }, (_, i) => ({
    playerId: pick(onPitch(t), k + 'cp' + i).id, color: r(k + 'cr' + i) < 0.1 ? 'Red' : 'Yellow',
    minute: 5 + Math.floor(r(k + 'cm' + i) * 85), comment: null })).sort((a, b) => a.minute - b.minute)
  const weather = n % 7 === 3 ? { id: '8199', name: 'Fog' } : pick(MOCK_SOCCER_TEMPLATES.gameFields[1].options, 'wo')
  const pitch = pick(MOCK_SOCCER_TEMPLATES.gameFields[2].options, 'pc')
  return {
    id: game.id, time: game.time, label: game.label, home: r('h') < 0.5, ourTeamId: game.teamId,
    opponent: { id: `t-${game.label.split(' - ')[1]}`, name: game.label.split(' - ')[1] },
    gameFields: [{ templateId: '8002', valueId: weather.id, valueName: weather.name, number: null },
      { templateId: '8003', valueId: pitch.id, valueName: pitch.name, number: pitch.value }],
    ourData: { staff: [{ id: '3101', name: 'Jón Coach', job: 'Coach' }, { id: '3102', name: 'Katrín Physio', job: 'Physio' }],
      ...us, cards: cards(us, 'uc'), goals: goals(us, them, 'ug') },
    opponentData: { staff: [{ id: `os${n}`, name: 'Alex Manager', job: 'Coach' }], ...them, cards: cards(them, 'tc'), goals: goals(them, us, 'tg') },
    eachHalfMinutes: 45, overtimeMinutes: 0, numberOfParts: 2, playersOnEachTeam: 11,
    referees: [{ id: `r${n % 4}`, name: ['Sam Whistle', 'Pat Line', 'Lee Card', 'Robin Flag'][n % 4] }],
    spectators: r('sp') < 0.2 ? null : 100 + Math.floor(r('spn') * 900),
  }
}

function answerQuery(q) {
  if (!q.widgetId && !q.vibeCodeSessionId) return { error: 'Missing widgetId or vibeCodeSessionId' }
  const params = q.params || {}
  if (q.name === 'club.info') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: [MOCK_CLUB] }
  }
  if (q.name === 'soccerreports.get') {
    const err = unknownParam(params, ['gameIds'], q.name)
    if (err) return { error: err }
    const { gameIds } = params
    if (!Array.isArray(gameIds) || !gameIds.length) return { error: "Missing parameter 'gameIds' for soccerreports.get: give at least one game id (from games.list)" }
    if (gameIds.some((id) => typeof id !== 'string' || !id)) return { error: 'gameIds for soccerreports.get must be an array of non-empty strings' }
    if (gameIds.length > 500) return { error: 'Too many gameIds for soccerreports.get: at most 500 per call' }
    const now = Date.now()
    const games = mockGames()
    const result = [], denied = []
    for (const id of gameIds) {
      const i = games.findIndex((g) => g.id === id)
      const g = games[i]
      // Not found, not soccer, in the future or (every tenth) no report yet: denied, like the server does it.
      if (!g || !g.soccer || g.time > now || i % 10 === 0) denied.push(id)
      else result.push(mockSoccerReport(g, i))
    }
    return { result: result.sort((a, b) => a.time - b.time), denied }
  }
  if (q.name === 'soccerreports.formations') {
    const err = unknownParam(params, ['formationId'], q.name)
    if (err) return { error: err }
    const { formationId } = params
    if (formationId == null) return { result: MOCK_FORMATIONS }
    if (typeof formationId !== 'string' && typeof formationId !== 'number') return { error: "Parameter 'formationId' for soccerreports.formations must be a string" }
    if (formationId === '') return { error: "Parameter 'formationId' for soccerreports.formations must not be empty: leave it out for all formations" }
    return { result: MOCK_FORMATIONS.filter((f) => f.id === String(formationId)) }
  }
  if (q.name === 'soccerreports.templates') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: [MOCK_SOCCER_TEMPLATES] } // always one row, like club.info
  }
  if (q.name === 'sessiontags.get') {
    const KINDS = ['includeGameTags', 'includePracticeTags', 'includeEventTags', 'includeWorkoutTags']
    const err = unknownParam(params, KINDS, q.name)
    if (err) return { error: err }
    const given = KINDS.filter((k) => k in params)
    const bad = given.find((k) => typeof params[k] !== 'boolean')
    if (bad) return { error: `Parameter '${bad}' for sessiontags.get must be true or false` }
    if (!given.length) return { result: MOCK_SESSION_TAGS }
    const want = given.filter((k) => params[k])
    if (!want.length)
      return { error: `No kind of tag asked for in sessiontags.get: set at least one of ${KINDS.join(', ')} to true, or leave them all out for all tags` }
    const field = { includeGameTags: 'game', includePracticeTags: 'practice', includeEventTags: 'event', includeWorkoutTags: 'workout' }
    return { result: MOCK_SESSION_TAGS.filter((t) => want.some((k) => t[field[k]])) }
  }
  if (q.name === 'games.list') {
    const err = unknownParam(params, ['teamIds', 'athleteIds', 'sessionTagIds', 'from', 'to'], q.name)
    if (err) return { error: err }
    const { teamIds, athleteIds, sessionTagIds, from, to } = params
    const { timeZoneName } = q
    for (const [key, ids] of [['teamIds', teamIds], ['athleteIds', athleteIds], ['sessionTagIds', sessionTagIds]]) {
      if (ids == null) continue
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) return { error: `${key} for games.list must be an array of non-empty strings` }
      if (!ids.length) return { error: `Parameter '${key}' for games.list is empty: leave it out instead` }
    }
    for (const [key, v] of [['from', from], ['to', to]])
      if (v != null && !Number.isInteger(v)) return { error: `Parameter '${key}' for games.list must be a number (epoch milliseconds)` }
    if (from != null && to != null && from > to) return { error: "Parameter 'from' for games.list is after 'to'" }
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const visibleTeams = MOCK_TEAMS.map((t) => t.id)
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const deniedTeams = (teamIds || []).filter((id) => !visibleTeams.includes(id))
    const deniedAthletes = (athleteIds || []).filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id))
    const teams = (teamIds || visibleTeams).filter((id) => visibleTeams.includes(id))
    const athletes = athleteIds && MOCK_ATHLETES.filter((a) => athleteIds.includes(a.id) && !hidden.has(a.id))
    const result = mockGames().filter(
      (g) =>
        teams.includes(g.teamId) &&
        (!athletes || athletes.some((a) => tookPart(a, g))) &&
        (!sessionTagIds || g.sessionTagIds.some((t) => sessionTagIds.includes(t))) &&
        (from == null || g.time >= from) && (to == null || g.time <= to),
    )
    return { result, denied: [...deniedTeams, ...deniedAthletes] }
  }
  if (q.name === 'information.get') {
    const err = unknownParam(params, ['athleteIds', 'informationTemplateIds', 'from', 'to', 'pick'], q.name)
    if (err) return { error: err }
    const { athleteIds, informationTemplateIds, from, to, pick = 'AllEntriesInPeriod' } = params
    const PICKS = ['AllEntriesInPeriod', 'LatestInPeriod']
    if (!PICKS.includes(pick)) return { error: `Unknown value '${pick}' for parameter 'pick' of information.get. Known: ${PICKS.join(', ')}` }
    const { timeZoneName } = q
    for (const [key, ids] of [['athleteIds', athleteIds], ['informationTemplateIds', informationTemplateIds]]) {
      if (!Array.isArray(ids) || !ids.length) return { error: `Missing parameter '${key}' for information.get: give at least one id` }
      if (ids.some((id) => typeof id !== 'string' || !id)) return { error: `${key} for information.get must be an array of non-empty strings` }
    }
    for (const [key, v] of [['from', from], ['to', to]])
      if (v != null && !Number.isInteger(v)) return { error: `Parameter '${key}' for information.get must be a number (epoch milliseconds)` }
    if (from != null && to != null && from > to) return { error: "Parameter 'from' for information.get is after 'to'" }
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const known = new Set(MOCK_INFORMATION_TEMPLATES.map((t) => t.id))
    const denied = athleteIds.filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id))
    const missingInformationTemplateIds = informationTemplateIds.filter((id) => !known.has(id))
    let result = mockInformation().filter(
      (r) =>
        athleteIds.includes(r.athleteId) && !hidden.has(r.athleteId) && informationTemplateIds.includes(r.informationTemplateId) &&
        (from == null || r.time >= from) && (to == null || r.time <= to),
    )
    if (pick !== 'AllEntriesInPeriod') {
      // Only the latest per athlete and template; rows are sorted by time, so the last one wins.
      const latest = new Map()
      for (const r of result) latest.set(r.athleteId + '|' + r.informationTemplateId, r)
      result = [...latest.values()].sort((x, y) => x.time - y.time)
    }
    if (result.length > MAX_TEST_RESULT_ROWS)
      return { error: `More than ${MAX_TEST_RESULT_ROWS} information registrations. Ask for fewer athletes, fewer templates or a shorter period.` }
    return { result, denied, missingInformationTemplateIds }
  }
  if (q.name === 'information.templates') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: MOCK_INFORMATION_TEMPLATES }
  }
  if (q.name === 'load.templates') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: MOCK_LOAD_TEMPLATES, rpeSettings: MOCK_RPE_SETTINGS }
  }
  if (q.name === 'load.get') {
    const err = unknownParam(params, ['athleteIds', 'trainingLoadTemplateIds', 'from', 'to'], q.name)
    if (err) return { error: err }
    const { athleteIds, trainingLoadTemplateIds, from, to } = params
    const { timeZoneName } = q
    if (!Array.isArray(athleteIds) || !athleteIds.length) return { error: "Missing parameter 'athleteIds' for load.get: give at least one id" }
    if (athleteIds.some((id) => typeof id !== 'string' || !id)) return { error: 'athleteIds for load.get must be an array of non-empty strings' }
    if (trainingLoadTemplateIds != null) {
      if (!Array.isArray(trainingLoadTemplateIds) || trainingLoadTemplateIds.some((id) => typeof id !== 'string' || !id))
        return { error: 'trainingLoadTemplateIds for load.get must be an array of non-empty strings' }
      if (!trainingLoadTemplateIds.length)
        return { error: "Parameter 'trainingLoadTemplateIds' for load.get is empty: leave it out to get all training load templates" }
    }
    for (const [key, v] of [['from', from], ['to', to]])
      if (v != null && !Number.isInteger(v)) return { error: `Parameter '${key}' for load.get must be a number (epoch milliseconds)` }
    if (from != null && to != null && from > to) return { error: "Parameter 'from' for load.get is after 'to'" }
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const known = new Set(MOCK_LOAD_TEMPLATES.map((t) => t.id))
    const denied = athleteIds.filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id))
    const missingTrainingLoadTemplateIds = (trainingLoadTemplateIds || []).filter((id) => !known.has(id))
    const result = mockTrainingLoad().filter(
      (r) =>
        athleteIds.includes(r.athleteId) && !hidden.has(r.athleteId) &&
        (!trainingLoadTemplateIds || trainingLoadTemplateIds.includes(r.trainingLoadTemplateId)) &&
        (from == null || r.time >= from) && (to == null || r.time <= to),
    )
    if (result.length > MAX_TEST_RESULT_ROWS)
      return { error: `More than ${MAX_TEST_RESULT_ROWS} training load entries. Ask for fewer athletes, fewer templates or a shorter period.` }
    return { result, denied, missingTrainingLoadTemplateIds }
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
  return { error: `Unknown query '${q.name}'. Known: club.info, teams.list, teams.get, athletes.list, tests.templates, tests.get, load.templates, load.get, information.templates, information.get, games.list, sessiontags.get, soccerreports.templates, soccerreports.formations, soccerreports.get` }
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
