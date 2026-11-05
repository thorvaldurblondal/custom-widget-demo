// The video analyzer ("Analyzer", SVA in the data) for the mock server: sva.teams.list, sva.athletes.list,
// sva.games.list, sva.formulas.list and sva.events.list (XT2-5744). Same validation and error texts as the server.
//
// A made-up world: the club's own team "Reykjavík FC" (8101) and three opponents (8102–8104), SVA athletes 8001–8037,
// four games in the last two months (one scouting game between two opponents) plus one not set up yet (no date or
// teams), and two formulas: "Attack" (7301) and the archived "Defense (old)" (7302), used only in the oldest game.
// Linked to XPS athletes: 8001 → 2001, 8002 and 8003 → 2002 (one XPS athlete, two SVA athletes), 8010 → 2007.

const DAY = 86400000

// FNV-1a plus a final mix, like mock-server.js's hash.
const hash = (s) => {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13; h = Math.imul(h, 3266489909); h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
const pick = (arr, h) => arr[Math.floor(h * arr.length)]

const SVA_TEAMS = [
  { id: '8101', name: 'Reykjavík FC', color: '#1d4ed8' },
  { id: '8102', name: 'KR', color: '#111827' },
  { id: '8103', name: 'Breiðablik', color: '#16a34a' },
  { id: '8104', name: 'Valur', color: null },
]

const svaAthlete = (id, fullName, nickName = null, athleteId = null) => ({ id, fullName, nickName, athleteId })
const SVA_ATHLETES = [
  svaAthlete('8001', 'Anna Jónsdóttir', 'Anna', '2001'),
  svaAthlete('8002', 'Bjarki Pálsson', null, '2002'),
  svaAthlete('8003', 'Bjarki Pálsson', 'Bjarki P.', '2002'), // the same person, made again in another season
  svaAthlete('8004', 'Dagur Árnason'), // also an XPS athlete (2101), but not linked
  svaAthlete('8005', 'Freyr Gíslason'),
  svaAthlete('8006', 'Ísak Halldórsson'),
  svaAthlete('8007', 'Jóhann Kristjánsson', 'Jói'),
  svaAthlete('8008', 'Logi Már'),
  svaAthlete('8009', 'Elín Sigurðardóttir'),
  svaAthlete('8010', 'Sara Björnsdóttir', null, '2007'),
  ...['Atli', 'Birkir', 'Daníel', 'Egill', 'Fannar', 'Gísli', 'Hörður'].map((f, i) => svaAthlete(String(8011 + i), `${f} (KR)`)),
  ...['Arnar', 'Bjartur', 'Davíð', 'Einar', 'Finnur', 'Guðni', 'Hannes'].map((f, i) => svaAthlete(String(8021 + i), `${f} (Breiðablik)`)),
  ...['Aron', 'Baldur', 'Darri', 'Emil', 'Friðrik', 'Grétar', 'Haukur'].map((f, i) => svaAthlete(String(8031 + i), `${f} (Valur)`)),
]
const range = (from, n) => Array.from({ length: n }, (_, i) => String(from + i))
// Current members; 8003 is a former one (only in the oldest game).
const CURRENT = { '8101': ['8001', '8002', '8004', '8005', '8006', '8007', '8008', '8009', '8010'], '8102': range(8011, 7), '8103': range(8021, 7), '8104': range(8031, 7) }

const OWN_PLAYED = ['8001', '8002', '8004', '8005', '8006', '8007', '8009']
const localDate = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const VIDEO = (name) => `https://f003.backblazeb2.com/file/xps-demo/analyzer/${name}.mp4` // made up: these don't load
// In the order of the club's game tree, not by date (widgets sort by date themselves): our games, then the scouting
// folder (9204 is older than 9203), then the one not set up yet.
function svaGames() {
  const now = Date.now()
  return [
    { id: '9201', name: 'Reykjavík FC - KR', date: localDate(now - 60 * DAY), homeSvaTeamId: '8101', awaySvaTeamId: '8102',
      homeSvaAthleteIds: ['8001', '8003', '8004', '8005', '8006', '8007', '8008'], awaySvaAthleteIds: range(8011, 7),
      onlineVideo: VIDEO('rfc-kr'), staticLists: [{ formulaId: '7302', attributeTemplateId: '7412', svaTeamId: '8101' }] },
    { id: '9202', name: 'Breiðablik - Reykjavík FC', date: localDate(now - 32 * DAY), homeSvaTeamId: '8103', awaySvaTeamId: '8101',
      homeSvaAthleteIds: range(8021, 7), awaySvaAthleteIds: OWN_PLAYED,
      onlineVideo: 'https://www.youtube.com/watch?v=demo9202', staticLists: [] }, // not on Backblaze: becomes null
    { id: '9203', name: 'Reykjavík FC - Valur', date: localDate(now - 11 * DAY), homeSvaTeamId: '8101', awaySvaTeamId: '8104',
      homeSvaAthleteIds: OWN_PLAYED, awaySvaAthleteIds: range(8031, 7), onlineVideo: null, staticLists: [] },
    { id: '9204', name: 'KR - Breiðablik', date: localDate(now - 20 * DAY), homeSvaTeamId: '8102', awaySvaTeamId: '8103',
      homeSvaAthleteIds: range(8011, 7), awaySvaAthleteIds: range(8021, 7), onlineVideo: VIDEO('kr-breidablik'), staticLists: [] }, // scouting
    // Not set up yet: no date, no teams, no events (users needn't fill these in).
    { id: '9205', name: 'Next game', date: null, homeSvaTeamId: null, awaySvaTeamId: null,
      homeSvaAthleteIds: [], awaySvaAthleteIds: [], onlineVideo: null, staticLists: [] },
  ].map((g) => ({ ...g, onlineVideo: isPlayable(g.onlineVideo) ? g.onlineVideo : null })) // like Item.setOnlineVideo
}
const isPlayable = (url) => {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname.toLowerCase().endsWith('.backblazeb2.com')
  } catch {
    return false
  }
}

const node = (id, name, children = []) => ({ id, name, children })
const attr = (id, name, type, more = {}) => ({ id, name, type, treeSubType: null, multiSelectable: false, tree: null, ...more })
const SVA_FORMULAS = [
  { id: '7301', name: 'Attack', archived: false, attributeTemplates: [
    attr('7401', 'Outcome', 'Tree', { treeSubType: 'Conventional', tree: { root: node('7500', 'Outcome', [
      node('7501', 'Goal'),
      node('7502', 'Shot', [node('7503', 'On target'), node('7504', 'Off target'), node('7505', 'Blocked')]),
      node('7506', 'Lost ball'),
    ]) } }),
    attr('7402', 'Assist', 'Teammate'),
    attr('7403', 'Closest defender', 'Opponent'),
    attr('7404', 'Counterattack', 'TrueFalse'),
    attr('7405', 'Distance (m)', 'Numerical'),
    attr('7406', 'Notes', 'FreeText'),
    attr('7407', 'Involved', 'Tree', { treeSubType: 'OneForEachTeammate', multiSelectable: true, tree: { root: node('7510', 'Involved', [
      node('7511', 'Pass'), node('7512', 'Dribble'), node('7513', 'Cross'),
    ]) } }),
  ] },
  { id: '7302', name: 'Defense (old)', archived: true, attributeTemplates: [
    attr('7411', 'Duel', 'Tree', { treeSubType: 'Conventional', tree: { root: node('7520', 'Duel', [node('7521', 'Won'), node('7522', 'Lost')]) } }),
    attr('7412', 'Rating', 'Tree', { treeSubType: 'OneForEachAthleteOnStaticList', tree: { root: node('7530', 'Rating', [
      node('7531', 'Good'), node('7532', 'Average'), node('7533', 'Poor'),
    ]) } }),
  ] },
]

const COMMENTS = ['Watch the pressing here.', 'Good movement off the ball.', 'Show this one in the team meeting.\nCompare with game 2.']
const NOTES = ['Left foot', 'After a corner', 'Header']
const value = (attributeTemplateId, v) => ({ attributeTemplateId, text: null, svaAthleteId: null, trueFalse: null, number: null, treeSelections: null, ...v })

// About 30 events per game, the same on every call.
function svaEvents(game) {
  const events = []
  if (!game.homeSvaTeamId || !game.awaySvaTeamId) return events // not set up yet
  for (let i = 0; i < 30; i++) {
    const h = (k) => hash(`${game.id}-${i}-${k}`)
    const home = h('side') < 0.55
    const svaTeamId = home ? game.homeSvaTeamId : game.awaySvaTeamId
    const mates = home ? game.homeSvaAthleteIds : game.awaySvaAthleteIds
    const opponents = home ? game.awaySvaAthleteIds : game.homeSvaAthleteIds
    const athlete = h('a') < 0.1 ? null : pick(mates, h('who'))
    const start = i * 170000 + Math.floor(h('t') * 60000)
    const e = { id: `${game.id}-e${i}`, svaGameId: game.id, formulaId: '7301', start, end: start + 8000 + Math.floor(h('len') * 12000),
      svaTeamId, svaAthleteId: athlete, personalComment: h('c') < 0.1 ? pick(COMMENTS, h('cc')) : null, attributeValues: [] }
    if (game.id === '9201' && h('f') < 0.35) {
      e.formulaId = '7302'
      e.attributeValues.push(value('7411', { treeSelections: [{ nodeId: h('duel') < 0.55 ? '7521' : '7522', svaAthleteId: null }] }))
      if (svaTeamId === '8101') {
        const rated = mates.filter((id) => CURRENT['8101'].includes(id)).filter((_, k) => h('r' + k) < 0.3)
        if (rated.length) e.attributeValues.push(value('7412', { treeSelections: rated.map((id, k) => ({ nodeId: pick(['7531', '7532', '7533'], h('rr' + k)), svaAthleteId: id })) }))
      }
    } else {
      const outcome = pick(['7501', '7503', '7503', '7504', '7504', '7505', '7506', '7506'], h('o'))
      e.attributeValues.push(value('7401', { treeSelections: [{ nodeId: outcome, svaAthleteId: null }] }))
      const others = mates.filter((id) => id !== athlete)
      if (h('as') < 0.5 && others.length) e.attributeValues.push(value('7402', { svaAthleteId: pick(others, h('as2')) }))
      if (h('d') < 0.6) e.attributeValues.push(value('7403', { svaAthleteId: pick(opponents, h('d2')) }))
      if (h('ca') < 0.7) e.attributeValues.push(value('7404', { trueFalse: h('ca2') < 0.3 }))
      if (outcome !== '7506') e.attributeValues.push(value('7405', { number: Math.round(5 + h('dist') * 25) }))
      if (h('n') < 0.15) e.attributeValues.push(value('7406', { text: pick(NOTES, h('n2')) }))
      const involved = others.filter((_, k) => h('inv' + k) < 0.2).slice(0, 3)
      if (involved.length) e.attributeValues.push(value('7407', { treeSelections: involved.flatMap((id, k) =>
        ['7511', '7512', '7513'].filter((_, j) => h(`ij${k}${j}`) < 0.45).map((nodeId) => ({ nodeId, svaAthleteId: id }))) }))
    }
    events.push(e)
  }
  return events
}
// Everyone taking part: the event's athlete, Teammate/Opponent values and athletes in tree selections.
const involved = (e) => new Set([e.svaAthleteId, ...e.attributeValues.flatMap((v) => [v.svaAthleteId, ...(v.treeSelections || []).map((s) => s.svaAthleteId)])].filter(Boolean))

// The same messages as AttendanceParams.checkIds and SvaParams.checkDates.
function checkIds(name, key, ids, max) {
  if (ids == null) return null
  if (!ids.length) return `Parameter '${key}' for ${name} is empty: leave it out instead`
  if (ids.length > max) return `Too many ${key} for ${name}: at most ${max} per call`
  if (ids.some((id) => !id.trim())) return `${key} for ${name} must not contain empty values`
  return null
}
const isStrings = (v) => v == null || (Array.isArray(v) && v.every((id) => typeof id === 'string'))
function checkDates(params, name) {
  for (const key of ['from', 'to']) {
    const v = params[key]
    if (v == null) continue
    const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z')) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v
    if (!ok) return `Parameter '${key}' for ${name} must be a date as "yyyy-MM-dd" (e.g. "2026-09-30"), not epoch milliseconds`
  }
  if (params.from != null && params.to != null && params.from > params.to) return `Parameter 'from' for ${name} is after 'to'`
  return null
}

// XPS athletes the viewer may not see (or unknown ones) are denied; the others give their linked SVA athletes.
function linkedSvaAthletes(athleteIds, xpsAthletes) {
  const denied = athleteIds.filter((id) => { const a = xpsAthletes.find((x) => x.id === id); return !a || a.hidden })
  const ok = athleteIds.filter((id) => !denied.includes(id))
  return { denied, svaIds: SVA_ATHLETES.filter((a) => ok.includes(a.athleteId)).map((a) => a.id) }
}

const SVA_GAMES_MAX_ROWS = 10000 // SvaGamesReply.MAX_ROWS
const SVA_EVENTS_MAX_ROWS = 200000 // SvaEventsReply.MAX_ROWS

/** The reply to an sva.* query, or null for other queries. xpsAthletes: the mock's XPS athletes (for athleteIds). */
export function answerSvaQuery(q, unknownParam, xpsAthletes) {
  const name = q.name
  const params = q.params || {}
  if (name === 'sva.teams.list') {
    const err = unknownParam(params, ['svaTeamIds'], name)
    if (err) return { error: err }
    if (!isStrings(params.svaTeamIds)) return { error: `Bad parameters for ${name}: svaTeamIds must be an array of strings` }
    const idErr = checkIds(name, 'svaTeamIds', params.svaTeamIds, 500)
    if (idErr) return { error: idErr }
    const result = SVA_TEAMS.filter((t) => !params.svaTeamIds || params.svaTeamIds.includes(t.id))
      .map((t) => ({ ...t, currentSvaAthleteIds: CURRENT[t.id] })) // in tree order: own team first
    return { result, denied: [] }
  }
  if (name === 'sva.athletes.list') {
    if ('athleteIds' in params) return { error: `${name} takes svaAthleteIds, not athleteIds: get an XPS athlete's svaAthleteIds from athletes.list` }
    const err = unknownParam(params, ['svaAthleteIds'], name)
    if (err) return { error: err }
    if (!isStrings(params.svaAthleteIds)) return { error: `Bad parameters for ${name}: svaAthleteIds must be an array of strings` }
    const idErr = checkIds(name, 'svaAthleteIds', params.svaAthleteIds, 1000)
    if (idErr) return { error: idErr }
    return {
      result: SVA_ATHLETES.filter((a) => !params.svaAthleteIds || params.svaAthleteIds.includes(a.id))
        .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      denied: [],
    }
  }
  if (name === 'sva.games.list') {
    if ('teamIds' in params) return { error: `${name} takes svaTeamIds (from sva.teams.list), not teamIds: XPS teams have no SVA games` }
    const err = unknownParam(params, ['svaGameIds', 'from', 'to', 'svaTeamIds', 'svaAthleteIds', 'athleteIds'], name)
    if (err) return { error: err }
    const { svaGameIds, from, to, svaTeamIds, svaAthleteIds, athleteIds } = params
    if (![svaGameIds, svaTeamIds, svaAthleteIds, athleteIds].every(isStrings))
      return { error: `Bad parameters for ${name}: svaGameIds, svaTeamIds, svaAthleteIds and athleteIds must be arrays of strings, from and to dates as "yyyy-MM-dd"` }
    const idErr = checkIds(name, 'svaGameIds', svaGameIds, 500) || checkIds(name, 'svaTeamIds', svaTeamIds, 500) ||
      checkIds(name, 'svaAthleteIds', svaAthleteIds, 1000) || checkIds(name, 'athleteIds', athleteIds, 500) || checkDates(params, name)
    if (idErr) return { error: idErr }
    const linked = athleteIds ? linkedSvaAthletes(athleteIds, xpsAthletes) : { denied: [], svaIds: [] }
    const people = svaAthleteIds || athleteIds ? new Set([...(svaAthleteIds || []), ...linked.svaIds]) : null
    const result = svaGames().filter((g) =>
      (!svaGameIds || svaGameIds.includes(g.id)) && (from == null || g.date >= from) && (to == null || g.date <= to) &&
      (!svaTeamIds || svaTeamIds.includes(g.homeSvaTeamId) || svaTeamIds.includes(g.awaySvaTeamId)) &&
      (!people || [...g.homeSvaAthleteIds, ...g.awaySvaAthleteIds].some((id) => people.has(id))))
    if (result.length > SVA_GAMES_MAX_ROWS) return { error: `More than ${SVA_GAMES_MAX_ROWS} games. Ask for a shorter period or fewer teams or athletes.` }
    return { result, denied: linked.denied }
  }
  if (name === 'sva.formulas.list') {
    const err = unknownParam(params, ['formulaIds'], name)
    if (err) return { error: err }
    if (!isStrings(params.formulaIds)) return { error: `Bad parameters for ${name}: formulaIds must be an array of strings` }
    const idErr = checkIds(name, 'formulaIds', params.formulaIds, 500)
    if (idErr) return { error: idErr }
    return { result: SVA_FORMULAS.filter((f) => !params.formulaIds || params.formulaIds.includes(f.id)), denied: [] }
  }
  if (name === 'sva.events.list') {
    if (!q.params) return { error: `Missing parameters for ${name}. Required: svaGameIds (ids from sva.games.list)` }
    if ('gameIds' in params) return { error: `${name} takes svaGameIds (from sva.games.list), not gameIds: games.list games have no SVA events` }
    const err = unknownParam(params, ['svaGameIds', 'svaAthleteIds', 'athleteIds'], name)
    if (err) return { error: err }
    const { svaGameIds, svaAthleteIds, athleteIds } = params
    if (![svaGameIds, svaAthleteIds, athleteIds].every(isStrings))
      return { error: `Bad parameters for ${name}: svaGameIds, svaAthleteIds and athleteIds must be arrays of strings` }
    if (svaGameIds == null) return { error: `Missing parameter 'svaGameIds' for ${name}: ids from sva.games.list` }
    const idErr = checkIds(name, 'svaGameIds', svaGameIds, 100) || checkIds(name, 'svaAthleteIds', svaAthleteIds, 1000) ||
      checkIds(name, 'athleteIds', athleteIds, 500)
    if (idErr) return { error: idErr }
    const linked = athleteIds ? linkedSvaAthletes(athleteIds, xpsAthletes) : { denied: [], svaIds: [] }
    const people = svaAthleteIds || athleteIds ? new Set([...(svaAthleteIds || []), ...linked.svaIds]) : null
    const games = svaGames()
    const result = svaGameIds.flatMap((id) => {
      const g = games.find((x) => x.id === id)
      return g ? svaEvents(g) : []
    }).filter((e) => !people || [...involved(e)].some((id) => people.has(id)))
    if (result.length > SVA_EVENTS_MAX_ROWS) return { error: `More than ${SVA_EVENTS_MAX_ROWS} events. Ask for fewer games or athletes.` }
    const formulas = {}
    for (const e of result) formulas[e.formulaId] ??= SVA_FORMULAS.find((f) => f.id === e.formulaId)
    return { result, denied: linked.denied, formulas }
  }
  return null
}
