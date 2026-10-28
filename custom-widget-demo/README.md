# Custom Widget Demo (XT2-5697)

A small test app for vibe coding XPS custom widgets: you chat with the AI, it writes the widget,
and you see it running in a preview. It talks to an XPS server (which calls Claude through Bedrock),
so you can test the whole round trip before the real XPS editor exists.

For now it only supports `FocusedAthlete` mode. Widgets get real data from the XPS server through
`xps.query()`; so far the queries are `club.info`, `teams.list`, `teams.get`, `athletes.list`, `tests.templates`, `tests.get`, `combinedtests.get`, `externalstatistics.datasources`, `externalstatistics.datasources.templates`, `load.templates`, `load.get`, `information.templates`, `information.get`, `games.list`, `sessiontags.get`, `soccerreports.templates`, `soccerreports.formations`, `soccerreports.get`, `genericmatchreports.templates`, `genericmatchreports.get`, `attendance.getsummary`, `attendance.getdetails`, `drills.templates`, `drills.get`, `exercises.templates` and `exercises.get` (XT2-5705, XT2-5734).

## Run it

You need **Node.js 18 or newer**. Check with `node -v`; if it's missing or older, install the LTS version from https://nodejs.org.

```bash
npm install     # first time only (and after pulling changes to package.json)
npm run dev
```

The app opens at http://localhost:5173. Fill in:

| Field | What to enter |
|---|---|
| Server prefix | The XPS server, e.g. `http://localhost:8080/` or `https://testsrvr.sidelinesports.com/` |
| `_sessionId` | Your XPS session ID (your login token). Treat it like a password. |
| `widgetId` | The ID of the report widget that holds the custom widget |

Click **Connect**. The fields are remembered in your browser, not saved in any file.

If `npm run dev` says `vite: Permission denied`, delete the `node_modules` folder and run `npm install` again.

### No XPS server? Use the mock

In a second terminal:

```bash
npm run mock
```

This starts a fake XPS server at `http://localhost:8099/`. Use that as the server prefix, with any `_sessionId`.

- widgetId `locked` gets a "widget is locked" reply.
- A chat message containing "broken" or "error" makes a draft that crashes, so you can see the error report.
- `club.info` returns a made-up club with a drawn logo, `usesSoccerReports: true` and two
  sports with generic match reports (Handball and Volleyball).
- `teams.list` returns three made-up teams (ids `1001`–`1003`). `1002` and `1003` are groups in "Youth" (`1000`),
  a team the viewer isn't in, so they have `parentTeamId`/`parentTeamName`.
- `teams.get` with `{ "teamId": "1002" }` returns that team with `parentTeamId`, `parentTeamName`, `requiredAthleteIds` and `optionalAthleteIds`.
  Team `1002` has optional athletes (`2003`, `2006`); an unknown team id gives no rows and the id in `denied`.
- `athletes.list` returns made-up athletes (ids `2001`–`2007`) and supports the `athleteId` and `teamIds` params.
  Put e.g. `2001` in the athletes or `1002` in the teams under **Context** to try the filters.
  Athlete `2003` has no picture, and `2007` (team `1003`) is one the viewer may not see, so it comes back in `denied`.
- `tests.templates` returns seven made-up test templates: simple ones with color ranges,
  one without colors, a combined "Sleep score" whose `subTestIds` point to the two sleep tests, and a calculated BMI with no unit.
- `tests.get` returns made-up results every two weeks for the last year, for every athlete and every simple or
  calculated test, with the same numbers each time. Sleep quality has a `txtValue` like "Good" and Sleep duration
  one like "7:30"; the others have `txtValue: null`. Asking for the combined Sleep score (`3006`) is an error. Athlete `2007` comes back in `denied`, unknown test ids in `missingTestTemplateIds`.
  The mock ignores `timeZoneName` apart from checking it's a real time zone.
- `combinedtests.get` returns the combined Sleep score (`3006`) for every pair of Sleep quality and Sleep duration
  results: each sub-test scores 0–10, `absoluteScore` is their sum (0–20) and `score` is that on 0–100. Colors come
  from the templates' color ranges. A Simple or Calculated test id is an error.
- `externalstatistics.datasources` returns two made-up external systems, Polar (`901`) and Catapult (`902`), and
  `externalstatistics.datasources.templates` (`{ dataSourceId }`) their statistics (heart rate, calories, distance,
  speed…). An unknown `dataSourceId` is an error. Like on the server, the statistic ids aren't in `tests.templates`,
  but `tests.get` returns made-up values for them.
- `load.templates` returns three made-up training load templates (ids `4001`–`4003`) and, as `rows.rpeSettings`,
  an RPE scale the club calls "Intensity" (`rpeName`), with `max: null` (meaning 0–10) and labels for 0, 1, 3, 5, 7 and 10 only.
- `load.get` returns made-up training load for the last year: a "Team practice" (`sessionType` `Practice`) most weekdays (`4001`), a match
  (`Game`) on Saturdays (`4002`) and gym (`4003`) on Thursdays as a "Strength workout" (`Workout`) and on
  Tuesdays outside any session (`sessionName` and `sessionType` both null). Some entries have no
  minutes (so `load` is null) or a decimal RPE. Leaving out `trainingLoadTemplateIds` gives all three; athlete `2007`
  comes back in `denied`, unknown template ids in `missingTrainingLoadTemplateIds`.
- `information.templates` returns five made-up information templates (ids `5001`–`5005`): "Injury status" and
  "Position" with `regMode: "Options"` and their `options` in a non-alphabetical order, "Preferred training" with
  `MultipleOptions`, and two `Plain` ones with empty `options`.
- `information.get` returns made-up registrations for the last year: "Injury status" every second week, including
  the old option "Doubtful" (no longer in `options`) in rows older than about five months; "Position" once;
  "Preferred training" (`MultipleOptions`) with one to three `texts`; and "Coach notes" now and then, some with
  line breaks. Rows are registered by "Jón Coach" (`3101`) or "Katrín Physio" (`3102`), and some injury statuses by the
  athlete (`registeredById` equals `athleteId`). "Diet" has none. Athlete `2007` comes back in `denied`, unknown template ids in `missingInformationTemplateIds`.
  `pick` works: `AllEntriesInPeriod` (default) and `LatestInPeriod` (without `from`/`to`: the latest ever).
- `games.list` returns made-up games from a year ago to two months ahead: the first team (`1001`) plays soccer on
  Saturdays (`soccer: true`), U19 (`1002`) handball on Sundays (`genericSport` `31` Handball, as in `club.info`), and
  U17 (`1003`) has a judo tournament on the 15th (neither, so no match report). `athleteIds` keeps games where the athletes
  are in the members list (optional athletes are members of about half of their team's games). Team `1000` and athlete `2007` come back in `denied`.
  Games have `sessionTagIds`: first-team games are "League game" (`7003`) or every fifth "Friendly game" (`7004`), plus
  "Played on grass" (`7001`) in May–September and "Played on artificial grass" (`7002`) otherwise; U19 games are league or
  friendly; the judo tournaments have no tags. `sessionTagIds` as a param keeps games with at least one of them.
- `sessiontags.get` returns five made-up tags sorted by name, with colors: those four and "Recovery" (`7005`), which is only
  for practices and workouts, so `{ includeGameTags: true }` leaves it out. All `false` is an error.
- `soccerreports.templates` returns one row `{ gameFields, participationFields, goalTypes }` with made-up fields of all four types: game fields "Number of spectators"
  (Numerical), "Weather" (TextOptions), "Pitch condition" (NumericalOptions 1–4) and "Match summary" (Text);
  participation fields "Player grade" (NumericalOptions 1–5), "Distance covered (km)", "Position played" and
  "Coach comment"; and five goal types ("Open play", "Penalty", "Free kick", "Corner", "Own goal").
- `soccerreports.formations` returns three made-up formations (`101` 4-4-2, `102` 4-3-3, `103` 3-5-2), each with 11
  positions (`id` and `name` both the position's code like "GK" or "LCB", `x`, `y` from 0 to 1, own goal at the top). `{ formationId }` gives one;
  an unknown id gives no rows.
- `soccerreports.get` returns made-up match reports for the first team's past soccer games (`gameIds` from
  `games.list`): 4-4-2 for us, 4-3-3 for the opponent, 14 players each (11 starters, two substitutions at 60–85
  minutes, one unused sub), 0–3 goals per team (sometimes an own goal, assists, goal types), a few cards, grades,
  a "Distance covered" extra field, weather and pitch condition. Some games had "Fog", a weather option the club has
  since removed (`valueName` still shows it). Future games, games of other teams and every tenth game come back in
  `denied` (game ids). The first team now has 14 athletes (`2101`–`2111` added, without pictures).
- `genericmatchreports.templates` with `{ sportId }` returns the settings of the club's two generic sports:
  handball (`31`: timed, can end in a tie, fields like Goals, Shots, Position, Effort 1–5 and a TrueFalse "Captain") and
  volleyball (`1`: sets, at most 5, score = sets won, no ties). Both have `derivedFields` (games won, result, …;
  handball also a shooting %, volleyball no ties). Any other sportId is an error. The mock club's
  `genericMatchReportSports` now lists both.
- `genericmatchreports.get` returns made-up handball reports for U19's (`1002`) past games (`gameIds` from `games.list`):
  scores, outcome, result text, two halves, a "Competition" and "Spectators" game field, our athletes' fields (goals,
  shots, position, effort, grade, a captain checkbox, sometimes a comment; some unused substitutes) with derived
  statistics, and opponent players with only fields. `rows.totals` adds the derived statistics up over all returned games
  as `{ id, sum, average }`, like XPS's statistics (shooting % average = all goals / all shots). Soccer games, future games and every eighth game come back in `denied`.
- `attendance.getdetails` returns made-up attendance rows: team practices on weekdays, the games from `games.list` and a
  Thursday workout for the first team. Past sessions are mostly `Attended`, else `Missed` with a reason (Sick, Injured,
  Other), future ones `Unknown`; a few rows have a trainer or athlete comment. Filters: `sessionTypes`, `sessionTagIds`.
- `attendance.getsummary` counts the same rows per athlete (with `athleteIds`; `teamIds` then narrow the sessions) or
  per team (only `teamIds`), per period (`None`, `Day`, `Week`,
  `Month`, `Year`), with the same field names as XPS (`practicesAttendedPerc`, `gamesMissedSick`, `totalRestDays`, …).
  In team rows each session counts as the share of its athletes, so the counts are averages per athlete with
  decimals (e.g. `practicesMissedSick: 0.1`), as in XPS. Rest days are only given for athletes; team events and
  individual games are empty in the mock.
- `drills.templates` returns seven made-up drills in a small folder tree: "Offense drills" (`Half-court offense` with
  "Pick and roll"/"Motion offense", `Full-court offense` with "Fast break") and "Defense drills" (`Man-to-man` with
  "Closeout drill", `Zone defense` with "2-3 zone rotation"), each with a `folderPath` of `{ id, name }` root first,
  plus two top-level drills with no folder ("Suicides", "Ladder drill", `folderPath: []`).
- `drills.get` (exactly one of `athleteIds` / `teamIds`, `from` and `to` required) returns made-up drills: 3–5 per
  past weekday practice of each team, and for first-team athletes an individual Tuesday workout (`teamId: null`) with
  Suicides and Ladder drill. Athletes get the drills of the practices they attended (same rule as
  `attendance.getdetails`), now and then minus one. Some practices have "Old shooting drill" (`6999`)
  or "Rondo" (`8001`), which aren't in `drills.templates`, to try the "Other" group. `drillTemplateIds` keeps only
  those drills (`6999` and `8001` work too). `summarize: true` adds the rows up per performer and drill. Athlete `2007` and team ids other than `1001`–`1003` come back in `denied`; more than
  100,000 detail rows is an error.
- `exercises.templates` returns five made-up exercises in a small folder tree ("Strength" > `Lower body` with
  "Back squat"/"Deadlift", `Upper body` with "Bench press"/"Pull-ups"; "Running" with "Interval run").
  `exerciseTemplateIds` keeps only those; `withAttributes: true` adds each one's attributes: Reps (`#`), Weight (`kg`),
  Rest (`s`), Time (`min`) and Shoe type (an `Option` attribute: Spikes, Soft shoes, Firm shoes).
- `exercises.get` (`athleteIds`, `from`, `to` and `exerciseTemplateIds` required; no `teamIds`) returns one row per
  exercise per athlete and workout, with its sets (exercises are only ever in workouts): first-team athletes do a
  Thursday gym workout (squat 10/5/1 reps with weights slowly going up, bench press, pull-ups, and sometimes "Walking
  lunge" (`5199`), which isn't in `exercises.templates`); most Mondays every athlete does a running workout, a 4-set
  interval run. Rest isn't always registered. `attributeTemplateIds` keeps only those attributes, and `rows.attributes` describes
  the ones in the rows. Athlete `2007` comes back in `denied`.
- Any other query name, or an unknown parameter, returns an error.

## Using it

- **Chat:** describe the widget. Progress shows in the chat, and each new draft appears in the preview.
  **Cancel** stops the AI.
- **Save / Publish / Discard:** save the draft, make it live, or throw it away.
- **Published / Draft:** switch the preview between the live version and the draft. **Show code** shows the HTML and JS.
- **Context:** edit the selection (athletes, teams, dates, theme) the widget sees, and send it as a context change.
- **Message log** (bottom): everything sent and received, with times. This is the main debugging tool.
  You can also send a raw socket message from there, e.g. `VibeCodeResume{"vibeCodeSessionId":"…"}`.

### Advanced settings (on the connect screen)

- **Go through the local dev proxy:** on by default. The browser only talks to this app, which forwards
  calls to the server prefix, so the XPS server needs no CORS setup.
- **Use the demo's SDK in the preview:** on by default. The preview uses this app's copy of `xps.js`
  instead of the one the widget points to on S3. Turn it off to test the real file.

## How it works

1. **Connect** sends a POST to
   `[prefix]xpsweb/?json=is.sideline.apps.xps.server.web.json.messages.JsonCustomWidgetEditRequest&_languageCode=en`
   with `{ "widgetId", "mode": "FocusedAthlete", "_sessionId" }`. The reply is either `{ "problem": "…" }`
   (shown on the form) or `{ "success": { "vibeCodeSessionId", "draftHtml", "draftJs", "draftVersion", … } }`.
2. It then opens the web socket `[prefix as ws/wss]websockets/events/?sessionId=[_sessionId]`.
   - **Sent** messages are the message name followed by JSON:
     `VibeCodeRequest{"vibeCodeSessionId":"…","requestId":"…","text":"…","focusedAthlete":…,"athleteIds":[…],"teamIds":[…],"from":…,"to":…,"timeZoneName":"…"}`
   - **Received** messages are JSON with `msgType`: `VibeCodingProgress`, `VibeCodingDraftUpdated`,
     `VibeCodingRequestEnded`, `VibeCodingPublishResult`, `VibeCodingSessionClosed`, `OutgoingError`, `Ping`, …
   - `VibeCodeHeartbeat` is sent every 30 seconds.
3. **Preview:** each draft is stored on the dev server and loaded in a sandboxed iframe from
   `/__preview/<id>/index.html` (+ `widget.js`), with the selection in the URL fragment (`#ctx=…`), the way XPS will host it.
   The page loads the SDK (`xps.js`), which gives the widget `xps.context`, `xps.query()`, `xps.onContextChange()`
   and `xps.resize()`.
   Each `xps.query(name, params)` is sent to `[prefix]xpsweb/vw/query?_languageCode=en` (through the proxy if it's on)
   with the session ID in the `sessionId` header and the body `{ "name", "params", "timeZoneName", "widgetId" }` for the
   published version or `{ "name", "params", "timeZoneName", "vibeCodeSessionId" }` for the draft. The SDK adds the
   viewer's `timeZoneName` to every query; widget code never sets it. The reply is `{ "result": [...] }` or
   `{ "error": "…" }`; the rows go back to the widget and errors make the widget's promise reject. The reply's other
   fields (`denied`, `missingTestTemplateIds`, …) go along too, and the SDK puts them on the array: `rows.denied`.
   Queries show in the message log under **Query**.
4. After a draft loads (or after 8 seconds if it never does), JS errors, failed queries, empty results and the shape of
   each query result (row count, field names and types, min/max of numbers, never other values) are sent back as
   `VibeCodePreviewReport`, so the AI can fix its own mistakes.

## Files

| File | What it is |
|---|---|
| `src/App.jsx` | The whole UI and session logic |
| `src/protocol.js` | URLs, socket message format, preview preparation |
| `public/vibe-coding-sdk/1/xps.js` | The widget SDK (the same file that goes on S3) |
| `vite.config.js` | Dev-only proxy to the XPS server, and the preview file host |
| `mock/mock-server.js` | Fake XPS server for local testing |

The proxy and preview host only exist while `npm run dev` is running; this is a dev tool, not something to deploy.
