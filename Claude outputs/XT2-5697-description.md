**Purpose**

A small, standalone test app for the vibe coding flow in XT2-5691. A developer can edit a custom widget with AI, through the XPS server and Bedrock, and see it run, before the real XPS editor exists. The goal is to test the round trip (connect → lock → chat → draft → preview → save/publish), not the widgets themselves.

It only uses `FocusedAthlete` mode, and widgets get no real data (`xps.query` returns no rows).

**Status**

Working against a local XPS server. Connect, chat, drafts in the preview, preview reports back to the AI and the AI's final reply have been tested end to end. Save, Publish and Discard are sent, but their server-side handling isn't finished.

**Code and running it**

* React + Vite dev tool, no build or deploy. Repo: `custom-widget-demo` (README explains everything below).
* Needs Node.js 18+. Run `npm install` once, then `npm run dev`. Opens at `http://localhost:5173`.
* `npm run mock` starts a fake XPS server at `http://localhost:8099/` for trying the app without a real server.

**1. Connection form**

Three fields, remembered in the browser:

* **Server prefix**, e.g. `https://testsrvr.sidelinesports.com/` or `http://localhost:8080/`
* `_sessionId`: the authorisation token
* `widgetId`: the report widget that contains the custom widget

Under **Advanced**:

* **Use the local dev proxy** (default on): the browser only talks to the demo, which forwards REST and socket calls to the server prefix, so the XPS server needs no CORS setup.
* **Use the demo's SDK in the preview** (default on): the preview loads the demo's copy of `xps.js` instead of the S3 file the template points to.

**2. Connect (REST)**

POST to `[server prefix]xpsweb/?json=is.sideline.apps.xps.server.web.json.messages.JsonCustomWidgetEditRequest&_languageCode=en`

```
{ "widgetId": "7960668361177249928", "mode": "FocusedAthlete", "_sessionId": "…" }
```

Legal modes on the server: `FocusedAthlete`, `Athletes`, `Teams`. The demo only sends `FocusedAthlete`.

The reply is one of:

* `{ "problem": "This widget is already locked by John" }`: shown on the form.
* `{ "success": { … } }`: opens the editor. Fields used: `vibeCodeSessionId`, `widgetId`, `draftHtml`, `draftJs`, `draftVersion`, `publishedHtml`, `publishedJs`, `libVersion`, `created`, `lastSaved`, `lockedBy`, `inputTokensThisSession`, `outputTokensThisSession`. All IDs are strings.

**3. Web socket**

Opened after connecting: `[server prefix, http→ws / https→wss]websockets/events/?sessionId=[_sessionId]`

**Sent** messages are the message name directly followed by the JSON body. All include `vibeCodeSessionId`; requests also include a `requestId`.

```
VibeCodeRequest{"vibeCodeSessionId":"…","requestId":"…","text":"Make everything red",
  "focusedAthlete":"123","athleteIds":["123"],"teamIds":[],
  "from":1789257600000,"to":1791849599999,"timeZoneName":"Atlantic/Reykjavik"}
```

| Message | When | Extra fields |
|---|---|---|
| `VibeCodeRequest` | User sends a chat message | `text`, `focusedAthlete`, `athleteIds`, `teamIds`, `from`/`to` (UTC ms, start and end of day), `timeZoneName` |
| `VibeCodeCancel` | Cancel while the AI works | `requestId` of the running request |
| `VibeCodePreviewReport` | After each draft has rendered | `draftVersion`, `loaded`, `jsErrors[]` (`kind`, `message`, `line`, `col`, `stack`), `failedQueries[]`, `deniedQueries[]`, `emptyResults[]` (`name`, `params`) |
| `VibeCodeSaveChanges` / `VibeCodePublishChanges` / `VibeCodeDiscardChanges` | Buttons | — |
| `VibeCodeHeartbeat` | Every 30 s | — |

**Received** messages are JSON with `msgType`:

| Message | Fields used | Shown as |
|---|---|---|
| `Connection` | `msg` | Log |
| `VibeCodingProgress` | `text` | Chat line |
| `VibeCodingDraftUpdated` | `html`, `js`, `draftVersion` | Rendered in the preview, then a preview report is sent |
| `VibeCodingRequestEnded` | `text`, `error`, `draftVersion`, token counts | AI's reply or error in the chat; chat unlocks |
| `VibeCodingPublishResult` | `ok`, `errors` | Chat; draft becomes the published version |
| `VibeCodingSessionClosed` | `reason` | Chat; editing disabled |
| `OutgoingError` | `msg` (class that failed) | Error in the chat; unlocks the chat for a failed `VibeCodeRequest` |
| `Ping` | — | Log only (hidden with heartbeats) |

**4. Editor screen**

* **Preview**: shows the published version or the draft. Each version is served by the dev server as real files (`/__preview/<id>/index.html` + `widget.js`) in an iframe sandboxed with `allow-scripts` only. The selection goes in the URL fragment (`#ctx=…`), the way XPS will host widgets.
* **SDK (`public/vibe-coding-sdk/1/xps.js`)**: the same file that goes on S3. It gives the widget `xps.context`, `xps.query()`, `xps.onContextChange()` and `xps.resize()`, talking to the host page through postMessage. In the demo, queries return no rows and resize sets the frame height.
* **Template checks**: if the HTML doesn't load the SDK, loads `widget.js` as a classic script or loads it twice, the preview patches it and logs a "Template" warning.
* **Preview report**: JS errors (incl. `console.error`) and queries are collected and sent as `VibeCodePreviewReport` 1.5 s after the page loads, or after 8 s if it never loads.
* **Context**: edit the selection (athletes, teams, period, theme) as JSON and send it to the widget as a context change; it is also used for the selection fields of the next `VibeCodeRequest`.
* **Chat**: sends `VibeCodeRequest`, shows progress and the final reply, **Cancel** button.
* **Buttons**: Save, Publish, Discard. **Show code** shows the current HTML and JS.
* **Status**: session ID, draft version, tokens, socket state.
* **Message log**: every REST and socket message with timestamps (heartbeats and pings can be hidden). Raw socket messages can be sent from there, e.g. `VibeCodeResume{"vibeCodeSessionId":"…"}`.

**Out of scope for now**

* Real data (`xps.query`), and modes other than `FocusedAthlete`
* Manual code editing (`VibeCodeCodeEdited`) and resume after reload (`VibeCodeResume`)
* Polish, mobile layout, translations

**Done when**

* A developer can connect, ask the AI for a widget with some static text, see it render in the preview, and save and publish it. *(Works up to the preview; save and publish wait for the server.)*
* Lock errors (`problem`), server errors and socket disconnects are shown clearly. *(Done)*
* Everything is visible in the message log. *(Done)*

**Open points on the server side**

* Discard: `discard()` clears `publishedJs` instead of the draft, and the session closes; consider keeping it open with the published version as the new draft.
* Publish closes the session with reason `discarded`; it should be `published`. `VibeCodingPublishResult` should include `publishedDraftVersion`, and ideally `VibeCodePublishChanges` should carry the `draftVersion` the user saw.
* `draftVersion` is missing when an existing widget is reopened, and Save shouldn't change it (it is one counter per widget, raised only when the draft changes).
* Save, Cancel and Heartbeat get no reply; an acknowledgement or `OutgoingError` would help.
* Nothing releases the lock when the user leaves; it only times out.
* The edit request should return `publishedHtml`/`publishedJs` (and later a stable `publishedUrl`) once something is published.
