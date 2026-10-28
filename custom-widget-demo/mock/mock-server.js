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
  genericMatchReportSports: [{ id: '31', name: 'Handball' }, { id: '1', name: 'Volleyball' }],
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

// drills.templates: a small made-up drill folder tree (XT2-5734). Folders themselves aren't rows; each drill
// carries its own folderPath (root first), built here from the folders' parentId chain.
const MOCK_DRILL_FOLDERS = [
  { id: '7001', name: 'Offense drills', parentId: null },
  { id: '7002', name: 'Half-court offense', parentId: '7001' },
  { id: '7003', name: 'Full-court offense', parentId: '7001' },
  { id: '7004', name: 'Defense drills', parentId: null },
  { id: '7005', name: 'Man-to-man', parentId: '7004' },
  { id: '7006', name: 'Zone defense', parentId: '7004' },
]
const folderPathFor = (folderId, folders = MOCK_DRILL_FOLDERS) => {
  const path = []
  for (let f = folders.find((x) => x.id === folderId); f; f = folders.find((x) => x.id === f.parentId))
    path.unshift({ id: f.id, name: f.name })
  return path
}
const MOCK_DRILLS = [
  { id: '6001', name: 'Pick and roll', color: '#2563eb', folderId: '7002' },
  { id: '6002', name: 'Motion offense', color: '#2563eb', folderId: '7002' },
  { id: '6003', name: 'Fast break', color: '#2563eb', folderId: '7003' },
  { id: '6004', name: 'Closeout drill', color: '#dc2626', folderId: '7005' },
  { id: '6005', name: '2-3 zone rotation', color: '#dc2626', folderId: '7006' },
  { id: '6006', name: 'Suicides', color: null, folderId: null }, // top level: conditioning, no folder
  { id: '6007', name: 'Ladder drill', color: null, folderId: null },
]
const MOCK_DRILL_TEMPLATES = MOCK_DRILLS.map(({ id, name, color, folderId }) => ({ id, name, color, folderPath: folderPathFor(folderId) }))

// exercises.templates: a small exercise folder tree like the drills', and the attributes that can be registered per
// exercise (XT2-5734). unitName is the viewer's unit; this mock viewer uses kg.
const MOCK_EXERCISE_FOLDERS = [
  { id: '7101', name: 'Strength', parentId: null },
  { id: '7102', name: 'Lower body', parentId: '7101' },
  { id: '7103', name: 'Upper body', parentId: '7101' },
  { id: '7104', name: 'Running', parentId: null },
]
const ATTR = {
  reps: { id: '9001', name: 'Reps', type: 'Number', unitName: '#', options: null },
  weight: { id: '9002', name: 'Weight', type: 'Number', unitName: 'kg', options: null },
  rest: { id: '9003', name: 'Rest', type: 'Number', unitName: 's', options: null },
  time: { id: '9004', name: 'Time', type: 'Number', unitName: 'min', options: null },
  shoe: { id: '9005', name: 'Shoe type', type: 'Option', unitName: null,
    options: [{ id: '9101', name: 'Spikes' }, { id: '9102', name: 'Soft shoes' }, { id: '9103', name: 'Firm shoes' }] },
}
const MOCK_EXERCISES = [
  { id: '5101', name: 'Back squat', color: '#7c3aed', folderId: '7102', attributes: [ATTR.reps, ATTR.weight, ATTR.rest], kg: 80 },
  { id: '5102', name: 'Deadlift', color: '#7c3aed', folderId: '7102', attributes: [ATTR.reps, ATTR.weight], kg: 100 },
  { id: '5103', name: 'Bench press', color: '#0891b2', folderId: '7103', attributes: [ATTR.reps, ATTR.weight, ATTR.rest], kg: 60 },
  { id: '5104', name: 'Pull-ups', color: '#0891b2', folderId: '7103', attributes: [ATTR.reps] },
  { id: '5105', name: 'Interval run', color: '#16a34a', folderId: '7104', attributes: [ATTR.time, ATTR.shoe] },
]
// In exercises.get rows now and then, but not in exercises.templates (deleted).
const OUTSIDE_EXERCISE = { id: '5199', name: 'Walking lunge', attributes: [ATTR.reps, ATTR.weight], kg: 20 }
const exerciseTemplate = ({ id, name, color, folderId, attributes }, withAttributes) =>
  ({ id, name, color, folderPath: folderPathFor(folderId, MOCK_EXERCISE_FOLDERS), attributes: withAttributes ? attributes : null })

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
// with the same numbers every time (a small hash instead of Math.random). The combined Sleep score comes from combinedtests.get.
const DAY = 86400000
const MAX_TEST_RESULT_ROWS = 50000 // same as TestResultsReply.MAX_ROWS and TrainingLoadReply.MAX_ROWS on the server
const RESULT_BASE = { '3001': [35, 8], '3002': [4.4, 0.3], '3003': [75, 6], '3004': [7, 2], '3005': [7.5, 1.2], '3007': [23, 2] }
// External statistics (ids from externalstatistics.datasources.templates) get results the same way.
Object.assign(RESULT_BASE, {
  '3101': [152, 12], '3102': [188, 8], '3103': [720, 180], '3104': [6, 5],
  '3201': [8200, 1800], '3202': [650, 250], '3203': [29, 3], '3204': [780, 160], '3205': [14, 6],
})
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

// externalstatistics.datasources / .templates: two made-up external systems and their statistics. Like on the
// server, the statistic ids are test template ids that aren't in tests.templates, and tests.get gives their values.
const MOCK_EXTERNAL_SOURCES = [{ id: '901', name: 'Polar' }, { id: '902', name: 'Catapult' }]
const MOCK_EXTERNAL_TEMPLATES = {
  '901': [
    { id: '3101', name: 'Average heart rate', unitName: 'bpm' },
    { id: '3102', name: 'Max heart rate', unitName: 'bpm' },
    { id: '3103', name: 'Calories', unitName: 'kcal' },
    { id: '3104', name: 'Time in HR zone 5', unitName: 'min' },
  ],
  '902': [
    { id: '3201', name: 'Total distance', unitName: 'm' },
    { id: '3202', name: 'High speed running', unitName: 'm' },
    { id: '3203', name: 'Max speed', unitName: 'km/h' },
    { id: '3204', name: 'Player load', unitName: null },
    { id: '3205', name: 'Sprints', unitName: '#' },
  ],
}
const MOCK_EXTERNAL_IDS = new Set(Object.values(MOCK_EXTERNAL_TEMPLATES).flat().map((t) => t.id))

// combinedtests.get: the Sleep score (3006) from the mock Sleep quality (3004) and Sleep duration (3005) results.
// Each sub-test gives a score from 0 to 10, the absolute score is their sum (0-20) and score is that on 0-100.
const colorFor = (templateId, v) =>
  MOCK_TEST_TEMPLATES.find((t) => t.id === templateId)?.colorRanges.find((r) => r.from <= v && v < r.to)?.hexColor ?? null
function mockCombinedTestResults() {
  const byKey = new Map(mockTestResults().map((r) => [r.id, r]))
  const rows = []
  for (const a of MOCK_ATHLETES)
    for (let i = 0; i < 26; i++) {
      const q = byKey.get(`r${a.id}-3004-${i}`), d = byKey.get(`r${a.id}-3005-${i}`)
      if (!q || !d) continue
      const sub = (r, score) => ({
        testTemplateId: r.testTemplateId, resultId: r.id, time: r.time, score, min: 0, max: 10,
        value: r.value, txtValue: r.txtValue, hexColor: colorFor(r.testTemplateId, r.value),
      })
      const qScore = Math.max(0, Math.min(10, Math.round(q.value * 10) / 10))
      const dScore = Math.max(0, Math.min(10, Math.round((d.value / 8) * 100) / 10))
      const absoluteScore = Math.round((qScore + dScore) * 10) / 10
      const score = Math.round((absoluteScore / 20) * 1000) / 10
      rows.push({
        combinedTestId: '3006', athleteId: a.id, time: Math.max(q.time, d.time), score, scoreMin: 0, scoreMax: 100,
        absoluteScore, absoluteMin: 0, absoluteMax: 20, xpsShowsAbsolute: false, hexColor: colorFor('3006', score),
        subResults: [sub(q, qScore), sub(d, dScore)],
      })
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

// genericmatchreports.templates: made-up settings for the club's two generic sports. Handball is timed and can end
// in a tie; volleyball is played in sets (score = sets won) and can't. Option fields of every type.
const gopts = (pairs, numeric) => pairs.map(([id, name]) => ({ id, name, value: numeric ? Number(name) : null }))
const MOCK_GENERIC_TEMPLATES = {
  31: {
    sport: { id: '31', name: 'Handball' }, canEndInTie: true, sets: null, scoreIsSetsWon: false, timed: true, canEndInShootOut: false,
    gameFields: [
      { id: '9101', name: 'Competition', type: 'TextOptions', teamCalculation: 'Sum', options: gopts([['9201', 'League'], ['9202', 'Cup'], ['9203', 'Friendly']]) },
      { id: '9102', name: 'Spectators', type: 'Numerical', teamCalculation: 'Sum', options: [] },
    ],
    participationFields: [
      { id: 'shirt', name: 'Nr', type: 'Numerical', teamCalculation: 'Average', options: [] },
      { id: 'minutes', name: 'Minutes', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9111', name: 'Goals', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9112', name: 'Shots', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9113', name: '2-minute suspensions', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9114', name: 'Position', type: 'TextOptions', teamCalculation: 'Sum', options: gopts([['9211', 'Goalkeeper'], ['9212', 'Left wing'], ['9213', 'Left back'], ['9214', 'Centre back'], ['9215', 'Right back'], ['9216', 'Right wing'], ['9217', 'Pivot']]) },
      { id: '9115', name: 'Effort', type: 'NumericalOptions', teamCalculation: 'Average', options: gopts([['9221', '1'], ['9222', '2'], ['9223', '3'], ['9224', '4'], ['9225', '5']], true) },
      { id: '9116', name: 'Captain', type: 'TrueFalse', teamCalculation: 'Sum', options: [] },
      { id: 'grade', name: 'Grade', type: 'Numerical', teamCalculation: 'Average', options: [] },
      { id: 'comment', name: 'Comment', type: 'Text', teamCalculation: 'Sum', options: [] },
    ],
    derivedFields: [
      { id: 'gamesPlayed', name: 'Games played', forTeam: true, isNumber: true },
      { id: 'wins', name: 'Games won', forTeam: true, isNumber: true },
      { id: 'ties', name: 'Games tied', forTeam: true, isNumber: true },
      { id: 'losses', name: 'Games lost', forTeam: true, isNumber: true },
      { id: 'resultsText', name: 'Result', forTeam: true, isNumber: false },
      { id: 'handballShotPct', name: 'Shooting %', forTeam: true, isNumber: true },
      { id: 'athleteUnusedSub', name: 'Unused substitute', forTeam: false, isNumber: true },
    ],
  },
  1: {
    sport: { id: '1', name: 'Volleyball' }, canEndInTie: false, sets: { maxNumberOfSets: 5, initialNumberOfSets: 3 }, scoreIsSetsWon: true, timed: false, canEndInShootOut: false,
    gameFields: [{ id: '9131', name: 'Competition', type: 'TextOptions', teamCalculation: 'Sum', options: gopts([['9231', 'League'], ['9232', 'Cup']]) }],
    participationFields: [
      { id: 'shirt', name: 'Nr', type: 'Numerical', teamCalculation: 'Average', options: [] },
      { id: '9141', name: 'Kills', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9142', name: 'Aces', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: '9143', name: 'Blocks', type: 'Numerical', teamCalculation: 'Sum', options: [] },
      { id: 'grade', name: 'Grade', type: 'Numerical', teamCalculation: 'Average', options: [] },
      { id: 'comment', name: 'Comment', type: 'Text', teamCalculation: 'Sum', options: [] },
    ],
    derivedFields: [
      { id: 'gamesPlayed', name: 'Games played', forTeam: true, isNumber: true },
      { id: 'wins', name: 'Games won', forTeam: true, isNumber: true },
      { id: 'losses', name: 'Games lost', forTeam: true, isNumber: true },
      { id: 'resultsText', name: 'Result', forTeam: true, isNumber: false },
      { id: 'athleteUnusedSub', name: 'Unused substitute', forTeam: false, isNumber: true },
    ],
  },
}

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

// genericmatchreports.get: made-up handball reports for U19's (1002) past games. Our athletes have fields and the
// derived statistics the server calculates (games played, won/tied/lost, result, shooting %, unused substitute);
// rows.totals adds them up over all returned games the way the server does (shooting % = all goals / all shots).
function mockGenericReport(game, n) {
  const r = (k) => hash(game.id + k)
  const tpl = MOCK_GENERIC_TEMPLATES[31]
  const positions = tpl.participationFields.find((f) => f.id === '9114').options
  const opponentName = game.label.split(' - ')[1]
  const ours = MOCK_ATHLETES.filter((a) => (a.teamIds.includes('1002') || a.optionalTeamIds.includes('1002')) && !a.hidden)
  const ourScore = 18 + Math.floor(r('os') * 15), opponentScore = 18 + Math.floor(r('ts') * 15)
  const outcome = ourScore > opponentScore ? 'Win' : ourScore < opponentScore ? 'Loss' : 'Tie'
  const resultText = `SC U19 ${ourScore} - ${opponentScore} ${opponentName}`
  const players = ours.map((a, i) => {
    const unused = r('u' + a.id) < 0.15
    const goals = unused ? 0 : Math.floor(r('g' + a.id) * 8)
    const shots = unused ? 0 : goals + Math.floor(r('s' + a.id) * 5)
    const pos = positions[(i + n) % positions.length]
    const effort = tpl.participationFields.find((f) => f.id === '9115').options[Math.floor(r('e' + a.id) * 5)]
    const fields = [{ templateId: 'shirt', valueId: null, valueName: null, number: 2 + i, text: null, bool: null }]
    if (!unused) fields.push(
      { templateId: 'minutes', valueId: null, valueName: null, number: 20 + Math.floor(r('m' + a.id) * 41), text: null, bool: null },
      { templateId: '9111', valueId: null, valueName: null, number: goals, text: null, bool: null },
      { templateId: '9112', valueId: null, valueName: null, number: shots, text: null, bool: null },
      { templateId: '9114', valueId: pos.id, valueName: pos.name, number: null, text: null, bool: null },
      { templateId: '9115', valueId: effort.id, valueName: effort.name, number: effort.value, text: null, bool: null },
      { templateId: 'grade', valueId: null, valueName: null, number: 4 + Math.floor(r('gr' + a.id) * 6), text: null, bool: null })
    if (i === 0) fields.push({ templateId: '9116', valueId: null, valueName: null, number: null, text: null, bool: true })
    if (r('c' + a.id) < 0.15) fields.push({ templateId: 'comment', valueId: null, valueName: null, number: null, text: 'Good defence.', bool: null })
    const derived = [
      { id: 'gamesPlayed', number: unused ? 0 : 1, text: null },
      { id: 'athleteUnusedSub', number: unused ? 1 : 0, text: null },
    ]
    if (!unused) derived.push(
      { id: 'wins', number: outcome === 'Win' ? 1 : 0, text: null },
      { id: 'ties', number: outcome === 'Tie' ? 1 : 0, text: null },
      { id: 'losses', number: outcome === 'Loss' ? 1 : 0, text: null },
      { id: 'resultsText', number: null, text: resultText },
      { id: 'handballShotPct', number: shots ? Math.round((goals * 1000) / shots) / 10 : null, text: null })
    return { id: a.id, isXps: true, name: `${a.firstName} ${a.lastName}`, fields, derived, _goals: goals, _shots: shots, _unused: unused }
  })
  const teamGoals = players.reduce((s, p) => s + p._goals, 0), teamShots = players.reduce((s, p) => s + p._shots, 0)
  const opponentPlayers = ['Ari', 'Bo', 'Cy', 'Dag', 'Eli', 'Fynn', 'Gus'].map((f, i) => ({
    id: `og${n}-${i}`, isXps: false, name: `${f} ${opponentName.split(' ')[0]}`, derived: [],
    fields: [{ templateId: 'shirt', valueId: null, valueName: null, number: 1 + i, text: null, bool: null },
      { templateId: '9111', valueId: null, valueName: null, number: Math.floor(r('og' + i) * 7), text: null, bool: null }],
  }))
  return {
    item: {
      id: game.id, time: game.time, label: game.label, ourTeamId: game.teamId, sport: { id: '31', name: 'Handball' },
      venue: r('v') < 0.5 ? 'Home' : 'Away', opponent: { id: `ot-${opponentName}`, name: opponentName },
      ourScore, opponentScore, outcome, resultText,
      periods: [{ number: 1, ourScore: Math.floor(ourScore / 2), opponentScore: Math.floor(opponentScore / 2) },
        { number: 2, ourScore: ourScore - Math.floor(ourScore / 2), opponentScore: opponentScore - Math.floor(opponentScore / 2) }],
      minutes: 60, endedInShootOut: false,
      gameFields: [{ templateId: '9101', valueId: '9201', valueName: 'League', number: null, text: null, bool: null },
        { templateId: '9102', valueId: null, valueName: null, number: 50 + Math.floor(r('sp') * 300), text: null, bool: null }],
      ourData: {
        participations: players.map(({ _goals, _shots, _unused, ...p }) => p),
        derived: [{ id: 'gamesPlayed', number: 1, text: null }, { id: 'wins', number: outcome === 'Win' ? 1 : 0, text: null },
          { id: 'ties', number: outcome === 'Tie' ? 1 : 0, text: null }, { id: 'losses', number: outcome === 'Loss' ? 1 : 0, text: null },
          { id: 'resultsText', number: null, text: resultText },
          { id: 'handballShotPct', number: teamShots ? Math.round((teamGoals * 1000) / teamShots) / 10 : null, text: null }],
      },
      opponentData: { participations: opponentPlayers, derived: [] },
    },
    players, teamGoals, teamShots, outcome,
  }
}

// drills.get: each team's past weekday practices (17:00) get 3-5 drills, picked by hash. Now and then a drill that isn't
// in drills.templates: "Old shooting drill" (6999, deleted) or "Rondo" (8001, from a content-providing account).
// Athletes get the drills of the practices they attended (same rule as attendance.getdetails), minus a drill now and
// then (excluded), and first-team athletes an individual Tuesday workout (teamId null) with two conditioning drills.
const MAX_DRILL_ROWS = 100000 // same as DrillsReply.MAX_ROWS on the server
const OUTSIDE_DRILLS = [{ id: '6999', name: 'Old shooting drill' }, { id: '8001', name: 'Rondo' }]
function mockPracticeDrills(teamId, dayIndex) {
  const key = teamId + '-' + dayIndex
  const n = 3 + Math.floor(hash(key + 'n') * 3)
  const pool = [...MOCK_DRILLS, ...(hash(key + 'x') < 0.15 ? OUTSIDE_DRILLS : [])]
  return [...pool].sort((x, y) => hash(key + x.id) - hash(key + y.id)).slice(0, n).map((d, i) => ({
    id: `d${key}-${i}`, templateId: d.id, name: d.name,
    minutes: 5 * (1 + Math.floor(hash(key + d.id + 'm') * 5)),
    intensity: hash(key + d.id + 'i') < 0.2 ? 3 + Math.floor(hash(key + d.id + 'r') * 6) : null,
  }))
}
function mockDrillRows(athleteIds, teamIds, from, to) {
  const now = Date.now(), rows = []
  const start = new Date(from); start.setHours(0, 0, 0, 0)
  for (let t = start.getTime(); t <= to; t += DAY) {
    const wd = new Date(t).getDay(), dayIndex = Math.round(t / DAY)
    if (wd >= 1 && wd <= 5)
      for (const team of MOCK_TEAMS.map((x) => x.id)) {
        const time = t + 17 * 3600000, sessionId = `p${team}-${t / DAY}`
        if (time < from || time > to || time > now) continue
        const drills = mockPracticeDrills(team, dayIndex)
        if (teamIds) {
          if (teamIds.includes(team))
            for (const d of drills) rows.push({ ...d, athleteId: null, teamId: team, time, sessionId, sessionLabel: 'Team practice', sessionType: 'Practice' })
          continue
        }
        for (const a of MOCK_ATHLETES.filter((x) => athleteIds.includes(x.id) && !x.hidden)) {
          const expected = a.teamIds.includes(team) || (a.optionalTeamIds.includes(team) && hash(a.id + sessionId) < 0.5)
          if (!expected || hash(sessionId + a.id + 'att') >= 0.82) continue
          for (const d of drills)
            if (hash(a.id + d.id) >= 0.1) rows.push({ ...d, athleteId: a.id, teamId: team, time, sessionId, sessionLabel: 'Team practice', sessionType: 'Practice' })
        }
      }
    if (wd === 2 && athleteIds) {
      const time = t + 7 * 3600000
      if (time < from || time > to || time > now) continue
      for (const a of MOCK_ATHLETES.filter((x) => athleteIds.includes(x.id) && !x.hidden && x.teamIds.includes('1001'))) {
        const sessionId = `iw${a.id}-${t / DAY}`
        for (const [i, d] of MOCK_DRILLS.filter((x) => x.id === '6006' || x.id === '6007').entries())
          rows.push({ id: `${sessionId}-${i}`, templateId: d.id, name: d.name, minutes: 10, intensity: 6, athleteId: a.id, teamId: null, time, sessionId, sessionLabel: 'Conditioning', sessionType: 'Workout' })
      }
    }
  }
  return rows.sort((x, y) => x.time - y.time)
}
function summarizeDrills(rows) {
  const byKey = new Map()
  for (const r of rows) {
    const key = (r.athleteId != null ? 'a' + r.athleteId : 't' + r.teamId) + '|' + r.templateId
    const s = byKey.get(key) || { athleteId: r.athleteId, teamId: r.athleteId != null ? null : r.teamId, templateId: r.templateId, name: r.name, count: 0, minutes: 0 }
    s.name = r.name
    s.count++
    s.minutes += r.minutes
    byKey.set(key, s)
  }
  const k = (v) => v ?? ''
  return [...byKey.values()].sort((x, y) => k(x.athleteId).localeCompare(k(y.athleteId)) || k(x.teamId).localeCompare(k(y.teamId)) || k(x.templateId).localeCompare(k(y.templateId)))
}

// exercises.get: exercises are only ever in athletes' workouts. First-team athletes do a Thursday gym workout (07:00):
// squat, bench press and pull-ups, sometimes a walking lunge that isn't in exercises.templates; weights go up slowly
// over the weeks. Most Mondays every athlete does a running workout (07:00): a 4-set interval run, shoe type an Option
// attribute. Rest isn't always registered (left out of values).
const MAX_EXERCISE_ROWS = 50000 // same as ExercisesReply.MAX_ROWS on the server
const num = (planned, performed) => ({ performed, planned, performedOptionId: null, plannedOptionId: null })
const opt = (planned, performed) => ({ performed: null, planned: null, performedOptionId: performed, plannedOptionId: planned })
function mockExerciseSets(e, key, week) {
  if (e.id === '5104')
    return [0, 1, 2].map((i) => ({ [ATTR.reps.id]: num(8, 6 + Math.floor(hash(key + i) * 5)) }))
  if (e.id === '5105')
    return [0, 1, 2, 3].map((i) => ({ [ATTR.time.id]: num(4, 4), [ATTR.shoe.id]: opt('9101', hash(key + i) < 0.2 ? '9102' : '9101') }))
  return [[10, 0], [5, 15], [1, 30]].map(([reps, extra], i) => {
    const planned = Math.round((e.kg + week + extra) / 2.5) * 2.5
    const v = { [ATTR.reps.id]: num(reps, hash(key + i + 'r') < 0.15 ? reps - 1 : reps),
      [ATTR.weight.id]: num(planned, hash(key + i + 'w') < 0.15 ? planned - 2.5 : planned) }
    if (e.attributes.includes(ATTR.rest) && hash(key + i + 's') < 0.7) v[ATTR.rest.id] = num(120, 90 + Math.floor(hash(key + i + 't') * 4) * 15)
    return v
  })
}
function mockExerciseRows(athleteIds, from, to) {
  const now = Date.now(), rows = []
  const row = (e, key, week, fields) => ({ ...fields, templateId: e.id, name: e.name,
    sets: mockExerciseSets(e, key, week).map((values, i) => ({ id: `${key}-${i}`, values })) })
  const start = new Date(from); start.setHours(0, 0, 0, 0)
  for (let t = start.getTime(); t <= to; t += DAY) {
    const wd = new Date(t).getDay(), week = Math.floor(t / DAY / 7) % 26
    if (wd === 4) {
      const time = t + 7 * 3600000
      if (time < from || time > to || time > now) continue
      for (const a of MOCK_ATHLETES.filter((x) => athleteIds.includes(x.id) && !x.hidden && x.teamIds.includes('1001'))) {
        const sessionId = `gw${a.id}-${t / DAY}`
        const list = [MOCK_EXERCISES[0], MOCK_EXERCISES[2], MOCK_EXERCISES[3], ...(hash(sessionId + 'l') < 0.25 ? [OUTSIDE_EXERCISE] : [])]
        list.forEach((e, position) => rows.push(row(e, `${sessionId}-${position}`, week,
          { athleteId: a.id, time, sessionId, sessionLabel: 'Gym', position })))
      }
    }
    if (wd === 1) {
      const time = t + 7 * 3600000
      if (time < from || time > to || time > now) continue
      for (const a of MOCK_ATHLETES.filter((x) => athleteIds.includes(x.id) && !x.hidden)) {
        const sessionId = `rw${a.id}-${t / DAY}`
        if (hash(sessionId + 'skip') < 0.8)
          rows.push(row(MOCK_EXERCISES[4], `${sessionId}-0`, week, { athleteId: a.id, time, sessionId, sessionLabel: 'Running', position: 0 }))
      }
    }
  }
  return rows.sort((x, y) => x.time - y.time || x.sessionId.localeCompare(y.sessionId) || x.position - y.position)
}

// attendance.getdetails / attendance.getsummary: made-up attendance for practices (weekdays at 17:00, 90 min, per team),
// the games from games.list (90 min) and a Thursday gym workout for the first team. Athletes are expected at their teams'
// sessions (optional athletes at about half). Past sessions: mostly attended, else missed (sick, injured, other);
// future ones: status Unknown. The summary counts the same rows, and rest days are days without anything attended.
function mockAttendanceRows(athleteIds, teamIds, from, to) {
  const now = Date.now(), rows = []
  const visible = MOCK_ATHLETES.filter((a) => !a.hidden && (!athleteIds || athleteIds.includes(a.id)))
  const start = new Date(from); start.setHours(0, 0, 0, 0)
  const sessions = []
  for (let t = start.getTime(); t <= to; t += DAY) {
    const day = new Date(t), wd = day.getDay()
    for (const team of ['1001', '1002', '1003'])
      if (wd >= 1 && wd <= 5) sessions.push({ id: `p${team}-${t / DAY}`, teamId: team, time: t + 17 * 3600000, minutes: 90, type: 'Practice', label: 'Team practice', tags: ['7001'] })
    if (wd === 4) sessions.push({ id: `w1001-${t / DAY}`, teamId: '1001', time: t + 8 * 3600000, minutes: 45, type: 'Workout', label: 'Strength workout', tags: ['7005'] })
  }
  for (const g of mockGames()) sessions.push({ id: g.id, teamId: g.teamId, time: g.time, minutes: 90, type: 'Game', label: g.label, tags: g.sessionTagIds })
  for (const s of sessions) {
    if (s.time < from || s.time > to || (teamIds && !teamIds.includes(s.teamId))) continue
    for (const a of visible) {
      const expected = a.teamIds.includes(s.teamId) || (a.optionalTeamIds.includes(s.teamId) && hash(a.id + s.id) < 0.5)
      if (!expected) continue
      const h = hash(s.id + a.id + 'att')
      const past = s.time < now
      const status = !past ? 'Unknown' : h < 0.82 ? 'Attended' : 'Missed'
      const missedReason = status !== 'Missed' ? null : h < 0.88 ? 'Sick' : h < 0.93 ? 'Injured' : 'Other'
      rows.push({
        sessionId: s.id, athleteId: a.id, teamId: s.teamId, time: s.time, minutes: s.minutes, type: s.type, label: s.label,
        hexColor: { Game: '#D32F2F', Practice: '#1976D2', Workout: '#388E3C', Event: '#F57C00' }[s.type] || null,
        sessionTagIds: s.tags, status, missedReason,
        trainerComment: status === 'Missed' && h > 0.97 ? 'Talk to parents about this.' : null,
        athleteComment: missedReason === 'Sick' && h < 0.84 ? 'Fever since yesterday.' : null,
      })
    }
  }
  return rows.sort((x, y) => x.time - y.time)
}

function mockPeriods(from, to, periodization) {
  if (!periodization || periodization === 'None') return [[from, to]]
  const out = []
  let s = new Date(from); s.setHours(0, 0, 0, 0)
  if (periodization === 'Week') s.setDate(s.getDate() - ((s.getDay() + 6) % 7))
  if (periodization === 'Month') s.setDate(1)
  if (periodization === 'Year') { s.setMonth(0); s.setDate(1) }
  while (s.getTime() <= to) {
    const e = new Date(s)
    if (periodization === 'Day') e.setDate(e.getDate() + 1)
    if (periodization === 'Week') e.setDate(e.getDate() + 7)
    if (periodization === 'Month') e.setMonth(e.getMonth() + 1)
    if (periodization === 'Year') e.setFullYear(e.getFullYear() + 1)
    out.push([Math.max(s.getTime(), from), Math.min(e.getTime() - 1, to)])
    s = e
  }
  return out
}

function mockAttendanceNumbers(rows, from, to, athleteCount) {
  // athleteCount 0 = a team row: like XPS, each session counts as the share of its athletes, so the counts are
  // averages per athlete with decimals (0.1 sick = a tenth of the athletes on average). *Total = number of sessions.
  const team = athleteCount === 0
  const pc = (a, b) => (b ? Math.round((a * 1000) / b) / 10 : null)
  const r2 = (x) => Math.round(x * 100) / 100
  const known = rows.filter((r) => r.status !== 'Unknown')
  const perSession = new Map()
  for (const r of known) perSession.set(r.sessionId, (perSession.get(r.sessionId) || 0) + 1)
  const wt = (r) => (team ? 1 / perSession.get(r.sessionId) : 1)
  const by = (type) => known.filter((r) => r.type === type)
  const g = by('Game'), p = by('Practice'), w = by('Workout')
  const total = (xs) => new Set(xs.map((r) => r.sessionId)).size
  const cnt = (xs) => r2(xs.reduce((n, r) => n + wt(r), 0))
  const att = (xs) => xs.filter((r) => r.status === 'Attended')
  const miss = (xs, reason) => cnt(xs.filter((r) => r.status === 'Missed' && (!reason || r.missedReason === reason)))
  const mins = (xs) => r2(xs.reduce((m, r) => m + (r.status === 'Attended' ? (r.minutes || 0) * wt(r) : 0), 0))
  const allMins = (xs) => r2(xs.reduce((m, r) => m + (r.minutes || 0) * wt(r), 0))
  const days = Math.floor((to - from) / DAY) + 1
  const activeDays = new Set(att(rows).map((r) => r.athleteId + '|' + new Date(r.time).toDateString())).size
  return {
    from, to,
    gamesTotal: total(g), gamesPlayed: cnt(att(g)), gamesPlayedPerc: pc(cnt(att(g)), total(g)), gamesPlayedMinutes: mins(g),
    gamesMissed: miss(g), gamesMissedSick: miss(g, 'Sick'), gamesMissedInjured: miss(g, 'Injured'), gamesMissedOther: miss(g, 'Other'),
    practicesTotal: total(p), practicesAttended: cnt(att(p)), practicesAttendedPerc: pc(cnt(att(p)), total(p)),
    practicesTotalMinutes: allMins(p), practicesAttendedMinutes: mins(p), practicesMinutesPerc: pc(mins(p), allMins(p)),
    practicesMissed: miss(p), practicesMissedSick: miss(p, 'Sick'), practicesMissedInjured: miss(p, 'Injured'), practicesMissedOther: miss(p, 'Other'),
    workoutsTotal: w.length, workoutsCompleted: att(w).length, workoutsPerc: pc(att(w).length, w.length),
    workoutsCompletedMinutes: att(w).reduce((m, r) => m + (r.minutes || 0), 0),
    teamEventsTotal: 0, teamEventsAttended: 0, teamEventsAttendedPerc: null, teamEventsTotalMinutes: 0, teamEventsAttendedMinutes: 0,
    teamEventsMinutesPerc: null, teamEventsMissed: 0, teamEventsMissedSick: 0, teamEventsMissedInjured: 0, teamEventsMissedOther: 0,
    totalSessionsAttended: cnt(att(known)), totalSessionsAttendedMinutes: mins(known),
    totalRestDays: athleteCount === 1 ? Math.max(0, days - activeDays) : null,
    individualGamesWon: null, individualGamesLost: null, individualGamesWonPerc: null,
    individualGameSetsWon: null, individualGameSetsLost: null, individualGameSetsWonPerc: null,
  }
}

function checkAttendanceParams(q, params, known, name) {
  const err = unknownParam(params, known, name)
  if (err) return err
  const { athleteIds, teamIds, from, to, sessionTagIds } = params
  if (athleteIds == null && teamIds == null) return `Give athleteIds or teamIds (or both) for ${name}`
  for (const [key, ids] of [['athleteIds', athleteIds], ['teamIds', teamIds], ['sessionTagIds', sessionTagIds]]) {
    if (ids == null) continue
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !id)) return `${key} for ${name} must be an array of non-empty strings`
    if (!ids.length) return `Parameter '${key}' for ${name} is empty: leave it out instead`
  }
  for (const [key, v] of [['from', from], ['to', to]]) {
    if (v == null) return `Missing parameter '${key}' for ${name} (epoch milliseconds)`
    if (!Number.isInteger(v)) return `Parameter '${key}' for ${name} must be a number (epoch milliseconds)`
  }
  if (from > to) return `Parameter 'from' for ${name} is after 'to'`
  if (to - from > 400 * DAY) return `The period for ${name} is too long: at most 400 days per call`
  if (!q.timeZoneName) return 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?'
  return null
}

function answerQuery(q) {
  if (!q.widgetId && !q.vibeCodeSessionId) return { error: 'Missing widgetId or vibeCodeSessionId' }
  const params = q.params || {}
  if (q.name === 'club.info') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: [MOCK_CLUB] }
  }
  if (q.name === 'attendance.getdetails') {
    const name = q.name
    const err = checkAttendanceParams(q, params, ['athleteIds', 'teamIds', 'from', 'to', 'sessionTypes', 'sessionTagIds'], name)
    if (err) return { error: err }
    const { athleteIds, teamIds, from, to, sessionTypes, sessionTagIds } = params
    const TYPES = ['Game', 'Practice', 'Workout', 'Event']
    if (sessionTypes != null) {
      if (!Array.isArray(sessionTypes) || !sessionTypes.length) return { error: `sessionTypes for ${name} must be a non-empty array` }
      const bad = sessionTypes.find((t) => !TYPES.includes(t))
      if (bad) return { error: `Unknown session type '${bad}' for ${name}. Known: ${TYPES.join(', ')}` }
    }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const denied = [...(athleteIds || []).filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id)),
      ...(teamIds || []).filter((id) => !MOCK_TEAMS.some((t) => t.id === id))]
    const result = mockAttendanceRows(athleteIds, teamIds, from, to).filter((r) =>
      (!sessionTypes || sessionTypes.includes(r.type)) && (!sessionTagIds || r.sessionTagIds.some((t) => sessionTagIds.includes(t))))
    if (result.length > 50000) return { error: 'More than 50000 attendance rows. Ask for fewer athletes or teams, or a shorter period.' }
    return { result, denied }
  }
  if (q.name === 'attendance.getsummary') {
    const name = q.name
    const err = checkAttendanceParams(q, params, ['athleteIds', 'teamIds', 'from', 'to', 'periodization', 'sessionTagIds'], name)
    if (err) return { error: err }
    const { athleteIds, teamIds, from, to, periodization, sessionTagIds } = params
    if (periodization != null && !['None', 'Day', 'Week', 'Month', 'Year'].includes(periodization))
      return { error: `Unknown periodization '${periodization}' for ${name}. Known: None, Day, Week, Month, Year` }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const denied = [...(athleteIds || []).filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id)),
      ...(teamIds || []).filter((id) => !MOCK_TEAMS.some((t) => t.id === id))]
    const rows = mockAttendanceRows(athleteIds, teamIds, from, to).filter((r) => !sessionTagIds || r.sessionTagIds.some((t) => sessionTagIds.includes(t)))
    const periods = mockPeriods(from, to, periodization)
    // With athleteIds: one row per athlete (teamIds narrow the sessions). Only teamIds: one row per team.
    const result = []
    if (athleteIds)
      for (const id of athleteIds.filter((a) => !denied.includes(a)))
        result.push({ athleteId: id, teamId: null, periods: periods.map(([f, t]) => mockAttendanceNumbers(rows.filter((r) => r.athleteId === id && r.time >= f && r.time <= t), f, t, 1)) })
    else
      for (const id of teamIds.filter((t) => MOCK_TEAMS.some((x) => x.id === t)))
        result.push({ athleteId: null, teamId: id, periods: periods.map(([f, t]) => mockAttendanceNumbers(rows.filter((r) => r.teamId === id && r.time >= f && r.time <= t), f, t, 0)) })
    return { result, denied }
  }
  if (q.name === 'genericmatchreports.get') {
    const err = unknownParam(params, ['gameIds'], q.name)
    if (err) return { error: err }
    const { gameIds } = params
    if (!Array.isArray(gameIds) || !gameIds.length) return { error: "Missing parameter 'gameIds' for genericmatchreports.get: give at least one game id (from games.list)" }
    if (gameIds.some((id) => typeof id !== 'string' || !id)) return { error: 'gameIds for genericmatchreports.get must be an array of non-empty strings' }
    if (gameIds.length > 500) return { error: 'Too many gameIds for genericmatchreports.get: at most 500 per call' }
    const now = Date.now(), games = mockGames(), built = [], denied = []
    for (const id of gameIds) {
      const i = games.findIndex((g) => g.id === id), g = games[i]
      // Not found, soccer or no generic sport, in the future, or (every eighth) no report: denied.
      if (!g || !g.genericSport || g.time > now || i % 8 === 0) denied.push(id)
      else built.push(mockGenericReport(g, i))
    }
    built.sort((a, b) => a.item.time - b.item.time)
    // Totals like the server (XPS's SimpleStatistics): sum = game values added up; average = all numerators / all
    // denominators (shooting % = all goals / all shots) or the plain average of game values (e.g. win rate).
    const pct = (g, s) => (s ? Math.round((g * 1000) / s) / 10 : null)
    const avg = (x, n) => (n ? Math.round((x / n) * 100) / 100 : null)
    const athletes = new Map()
    for (const b of built) for (const p of b.players) {
      const a = athletes.get(p.id) || { id: p.id, isXps: true, name: p.name, games: 0, played: 0, unused: 0, wins: 0, ties: 0, losses: 0, goals: 0, shots: 0 }
      a.games++
      if (p._unused) a.unused++
      else { a.played++; a.goals += p._goals; a.shots += p._shots; a[b.outcome === 'Win' ? 'wins' : b.outcome === 'Tie' ? 'ties' : 'losses']++ }
      athletes.set(p.id, a)
    }
    // n: games with a value (an athlete's games played; unused-sub games have no win/loss value)
    const count = (o, n) => [{ id: 'gamesPlayed', sum: o.played, average: avg(o.played, o.games ?? n) },
      { id: 'wins', sum: o.wins, average: avg(o.wins, n) }, { id: 'ties', sum: o.ties, average: avg(o.ties, n) },
      { id: 'losses', sum: o.losses, average: avg(o.losses, n) },
      { id: 'handballShotPct', sum: null, average: pct(o.goals, o.shots) }]
    const team = built.reduce((t, b) => ({ played: t.played + 1, wins: t.wins + (b.outcome === 'Win'), ties: t.ties + (b.outcome === 'Tie'),
      losses: t.losses + (b.outcome === 'Loss'), goals: t.goals + b.teamGoals, shots: t.shots + b.teamShots }),
      { played: 0, wins: 0, ties: 0, losses: 0, goals: 0, shots: 0 })
    const totals = built.length ? [{
      sport: { id: '31', name: 'Handball' }, games: built.length, team: count(team, built.length),
      athletes: [...athletes.values()].map((a) => ({ id: a.id, isXps: a.isXps, name: a.name, games: a.games,
        derived: [...count(a, a.played), { id: 'athleteUnusedSub', sum: a.unused, average: avg(a.unused, a.games) }] })),
    }] : []
    return { result: built.map((b) => b.item), denied, totals }
  }
  if (q.name === 'genericmatchreports.templates') {
    const err = unknownParam(params, ['sportId'], q.name)
    if (err) return { error: err }
    const { sportId } = params
    if (sportId == null || sportId === '') return { error: "Missing parameter 'sportId' for genericmatchreports.templates: use an id from club.info's genericMatchReportSports" }
    const t = MOCK_GENERIC_TEMPLATES[String(sportId)]
    if (!t) return { error: `The club has no generic match reports for sportId '${sportId}'. Use an id from club.info's genericMatchReportSports.` }
    return { result: [t] }
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
      return { error: `Test template ${combined} is a Combined test. tests.get only returns Simple and Calculated tests; use combinedtests.get for Combined tests.` }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const known = new Set([...MOCK_TEST_TEMPLATES.map((t) => t.id), ...MOCK_EXTERNAL_IDS])
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
  if (q.name === 'externalstatistics.datasources') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: MOCK_EXTERNAL_SOURCES }
  }
  if (q.name === 'externalstatistics.datasources.templates') {
    const err = unknownParam(params, ['dataSourceId'], q.name)
    if (err) return { error: err }
    const { dataSourceId } = params
    if (dataSourceId == null)
      return { error: `Missing parameter 'dataSourceId' for ${q.name}: use an id from externalstatistics.datasources` }
    if (typeof dataSourceId !== 'string' || !dataSourceId.trim()) return { error: `Parameter 'dataSourceId' for ${q.name} must be a non-empty string` }
    const templates = MOCK_EXTERNAL_TEMPLATES[dataSourceId.trim()]
    if (!templates) return { error: `Unknown dataSourceId ${dataSourceId}: use an id from externalstatistics.datasources` }
    return { result: templates }
  }
  if (q.name === 'combinedtests.get') {
    const name = q.name
    const err = unknownParam(params, ['athleteIds', 'combinedTestIds', 'from', 'to'], name)
    if (err) return { error: err }
    const { athleteIds, combinedTestIds, from, to } = params
    for (const [key, ids, max] of [['athleteIds', athleteIds, 500], ['combinedTestIds', combinedTestIds, 20]]) {
      if (!Array.isArray(ids) || !ids.length) return { error: `Missing parameter '${key}' for ${name}: give at least one id` }
      if (ids.some((id) => typeof id !== 'string' || !id)) return { error: `${key} for ${name} must be an array of non-empty strings` }
      if (ids.length > max) return { error: `Too many ${key} for ${name}: at most ${max} per call` }
    }
    for (const [key, v] of [['from', from], ['to', to]])
      if (v != null && !Number.isInteger(v)) return { error: `Parameter '${key}' for ${name} must be a number (epoch milliseconds)` }
    if (from != null && to != null && from > to) return { error: `Parameter 'from' for ${name} is after 'to'` }
    const notCombined = combinedTestIds.find((id) => MOCK_TEST_TEMPLATES.some((t) => t.id === id && t.type !== 'Combined'))
    if (notCombined) return { error: `Test template ${notCombined} is not a Combined test: get its results with tests.get` }
    const hidden = new Set(MOCK_ATHLETES.filter((a) => a.hidden).map((a) => a.id))
    const denied = athleteIds.filter((id) => hidden.has(id) || !MOCK_ATHLETES.some((a) => a.id === id))
    const missingCombinedTestIds = combinedTestIds.filter((id) => !MOCK_TEST_TEMPLATES.some((t) => t.id === id))
    const result = mockCombinedTestResults().filter(
      (r) => athleteIds.includes(r.athleteId) && !hidden.has(r.athleteId) && combinedTestIds.includes(r.combinedTestId) &&
        (from == null || r.time >= from) && (to == null || r.time <= to),
    )
    return { result, denied, missingCombinedTestIds }
  }
  if (q.name === 'drills.templates') {
    const err = unknownParam(params, [], q.name)
    return err ? { error: err } : { result: MOCK_DRILL_TEMPLATES }
  }
  if (q.name === 'drills.get') {
    const name = q.name
    const err = unknownParam(params, ['athleteIds', 'teamIds', 'from', 'to', 'drillTemplateIds', 'summarize'], name)
    if (err) return { error: err }
    const { athleteIds, teamIds, from, to, drillTemplateIds, summarize } = params
    if (athleteIds == null && teamIds == null) return { error: `Give athleteIds or teamIds for ${name}` }
    if (athleteIds != null && teamIds != null)
      return { error: `Give athleteIds or teamIds for ${name}, not both: athletes' drills are what each athlete did (practices and workouts), teams' drills are the teams' practice plans. Make two calls if you need both` }
    for (const [key, ids, max] of [['athleteIds', athleteIds, 500], ['teamIds', teamIds, 200], ['drillTemplateIds', drillTemplateIds, 500]]) {
      if (ids == null) continue
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
        return { error: `Bad parameters for ${name}: athleteIds, teamIds and drillTemplateIds must be arrays of strings, from and to whole numbers (epoch milliseconds), summarize true or false` }
      if (!ids.length) return { error: `Parameter '${key}' for ${name} is empty: leave it out instead` }
      if (ids.length > max) return { error: `Too many ${key} for ${name}: at most ${max} per call` }
      if (ids.some((id) => !id.trim())) return { error: `${key} for ${name} must not contain empty values` }
    }
    for (const [key, v] of [['from', from], ['to', to]]) {
      if (v == null) return { error: `Missing parameter '${key}' for ${name} (epoch milliseconds)` }
      if (!Number.isInteger(v)) return { error: `Parameter '${key}' for ${name} must be a number (epoch milliseconds)` }
    }
    if (from > to) return { error: `Parameter 'from' for ${name} is after 'to'` }
    if (summarize != null && typeof summarize !== 'boolean')
      return { error: `Bad parameters for ${name}: athleteIds, teamIds and drillTemplateIds must be arrays of strings, from and to whole numbers (epoch milliseconds), summarize true or false` }
    const { timeZoneName } = q
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const denied = athleteIds
      ? athleteIds.filter((id) => !MOCK_ATHLETES.some((a) => a.id === id && !a.hidden))
      : teamIds.filter((id) => !MOCK_TEAMS.some((t) => t.id === id))
    const rows = mockDrillRows(athleteIds, teamIds, from, to).filter((r) => !drillTemplateIds || drillTemplateIds.includes(r.templateId))
    if (summarize) return { result: summarizeDrills(rows), denied }
    if (rows.length > MAX_DRILL_ROWS)
      return { error: `More than ${MAX_DRILL_ROWS} drills. Ask for fewer athletes or teams or a shorter period, or use summarize: true.` }
    return { result: rows, denied }
  }
  if (q.name === 'exercises.templates') {
    const name = q.name
    const err = unknownParam(params, ['exerciseTemplateIds', 'withAttributes'], name)
    if (err) return { error: err }
    const { exerciseTemplateIds, withAttributes } = params || {}
    const badParams = `Bad parameters for ${name}: exerciseTemplateIds must be an array of strings, withAttributes true or false`
    if (withAttributes != null && typeof withAttributes !== 'boolean') return { error: badParams }
    if (exerciseTemplateIds != null) {
      if (!Array.isArray(exerciseTemplateIds) || exerciseTemplateIds.some((id) => typeof id !== 'string')) return { error: badParams }
      if (!exerciseTemplateIds.length) return { error: `Parameter 'exerciseTemplateIds' for ${name} is empty: leave it out instead` }
      if (exerciseTemplateIds.length > 500) return { error: `Too many exerciseTemplateIds for ${name}: at most 500 per call` }
      if (exerciseTemplateIds.some((id) => !id.trim())) return { error: `exerciseTemplateIds for ${name} must not contain empty values` }
    }
    const result = MOCK_EXERCISES.filter((e) => !exerciseTemplateIds || exerciseTemplateIds.includes(e.id))
      .map((e) => exerciseTemplate(e, withAttributes === true))
    return { result, denied: [] }
  }
  if (q.name === 'exercises.get') {
    const name = q.name
    if (!params) return { error: `Missing parameters for ${name}. Required: athleteIds, from, to, exerciseTemplateIds` }
    if ('teamIds' in params) return { error: `${name} takes athleteIds, not teamIds: for a team, get its athletes' ids from teams.get` }
    const err = unknownParam(params, ['athleteIds', 'from', 'to', 'exerciseTemplateIds', 'attributeTemplateIds'], name)
    if (err) return { error: err }
    const { athleteIds, from, to, exerciseTemplateIds, attributeTemplateIds } = params
    if (athleteIds == null) return { error: `Missing parameter 'athleteIds' for ${name}` }
    if (exerciseTemplateIds == null) return { error: `Missing parameter 'exerciseTemplateIds' for ${name}: ids from exercises.templates` }
    for (const [key, ids, max] of [['athleteIds', athleteIds, 500], ['exerciseTemplateIds', exerciseTemplateIds, 100], ['attributeTemplateIds', attributeTemplateIds, 100]]) {
      if (ids == null) continue
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
        return { error: `Bad parameters for ${name}: athleteIds, exerciseTemplateIds and attributeTemplateIds must be arrays of strings, from and to whole numbers (epoch milliseconds)` }
      if (!ids.length) return { error: `Parameter '${key}' for ${name} is empty: leave it out instead` }
      if (ids.length > max) return { error: `Too many ${key} for ${name}: at most ${max} per call` }
      if (ids.some((id) => !id.trim())) return { error: `${key} for ${name} must not contain empty values` }
    }
    for (const [key, v] of [['from', from], ['to', to]]) {
      if (v == null) return { error: `Missing parameter '${key}' for ${name} (epoch milliseconds)` }
      if (!Number.isInteger(v)) return { error: `Parameter '${key}' for ${name} must be a number (epoch milliseconds)` }
    }
    if (from > to) return { error: `Parameter 'from' for ${name} is after 'to'` }
    const { timeZoneName } = q
    if (!timeZoneName) return { error: 'The request has no timeZoneName (the XPS SDK should add it). Is the widget using an old or modified xps.js?' }
    try {
      new Intl.DateTimeFormat('en', { timeZone: timeZoneName })
    } catch {
      return { error: `Unknown timeZoneName '${timeZoneName}' in the request (added by the XPS SDK)` }
    }
    const denied = athleteIds.filter((id) => !MOCK_ATHLETES.some((a) => a.id === id && !a.hidden))
    const rows = mockExerciseRows(athleteIds, from, to).filter((r) => exerciseTemplateIds.includes(r.templateId))
    if (rows.length > MAX_EXERCISE_ROWS)
      return { error: `More than ${MAX_EXERCISE_ROWS} exercises. Ask for fewer athletes or exercises or a shorter period.` }
    const attributes = {}
    for (const r of rows)
      for (const s of r.sets) {
        if (attributeTemplateIds)
          s.values = Object.fromEntries(Object.entries(s.values).filter(([id]) => attributeTemplateIds.includes(id)))
        for (const id of Object.keys(s.values)) attributes[id] = Object.values(ATTR).find((a) => a.id === id)
      }
    return { result: rows, denied, attributes }
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
  return { error: `Unknown query '${q.name}'. Known: club.info, teams.list, teams.get, athletes.list, tests.templates, tests.get, load.templates, load.get, information.templates, information.get, games.list, sessiontags.get, soccerreports.templates, soccerreports.formations, soccerreports.get, genericmatchreports.templates, genericmatchreports.get, attendance.getsummary, attendance.getdetails, drills.templates, drills.get, exercises.templates, exercises.get` }
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
