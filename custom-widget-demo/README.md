# Custom Widget Demo (XT2-5697)

A small test client for vibe coding XPS custom widgets through the XPS server and Bedrock.
For now it only supports `FocusedAthlete` mode and uses no real data.

## Run it (Mac or Windows)

You need Node.js 18 or newer (https://nodejs.org, LTS installer).

```
npm install
npm run dev
```

The app opens at http://localhost:5173. Fill in the server prefix, `_sessionId` and `widgetId`, then click **Connect**.
The fields are remembered in the browser.

### No server handy? Use the mock

```
npm run mock
```

This runs a fake XPS server on http://localhost:8099/. Use that as the server prefix.

- widgetId `locked` returns a `problem` reply
- A chat message containing "broken" makes a draft that throws a JS error, so you can see the preview report

## How it works

1. **Connect** sends a POST to
   `[prefix]xpsweb/?json=is.sideline.apps.xps.server.web.json.messages.JsonCustomWidgetEditRequest&_languageCode=en`
   with `{ widgetId, mode: "FocusedAthlete", _sessionId }`.
2. On `success` it opens the web socket at `[prefix as ws]websockets/events/?sessionId=[_sessionId]`.
3. Chat messages are sent as `VibeCodeRequest`. `VibeCodingDraftUpdated` is rendered in a sandboxed iframe.
   JS errors are collected and sent back as `VibeCodePreviewReport`
   (after the page loads + 1.5 s, or after 8 s if it never loads).
4. Save / Publish / Discard / Cancel send the matching messages. `VibeCodeHeartbeat` goes out every 30 s.
5. The **message log** at the bottom shows everything sent and received. You can also send raw JSON over the socket from there.

## Dev proxy (CORS)

By default the browser talks only to the Vite dev server, and Vite forwards the calls to the server prefix you typed:

- REST: `/__xps/...` with header `X-Xps-Target`
- Socket: `/__xpsws/...?xpsTarget=...`

So the XPS server doesn't need any CORS setup. If the server does allow `http://localhost:5173`, you can turn the proxy off under **Advanced**.
The proxy lives in `vite.config.js` and only exists in `npm run dev`.

## Assumptions to check against the server

All wire format details are in `src/protocol.js`.

- **Socket message type.** Messages are sent as `{ "type": "VibeCodeRequest", "vibeCodeSessionId": ..., ... }`.
  If the server uses another field or full class names, change the type field or type prefix under **Advanced**
  (e.g. field `json`, prefix `is.sideline.apps.xps.server.web.json.messages.Json`). Incoming types are read the same way.
  A `Json` prefix and Java package are stripped.
- **Field names** for incoming messages are read loosely, e.g. draft HTML from `html`, `.html`, `draftHtml` or `stateOfHtml`.
- **`VibeCodeRequest`** sends `text` and `previewContext: { mode, athleteIds: [], teamIds: [], period: null }`.
- The preview doesn't load any XPS widget library yet (`libVersion` is only shown).

## Files

- `src/App.jsx`: UI and session logic
- `src/protocol.js`: URLs, message envelope, preview document
- `vite.config.js`: dev proxy
- `mock/mock-server.js`: fake server for local testing
