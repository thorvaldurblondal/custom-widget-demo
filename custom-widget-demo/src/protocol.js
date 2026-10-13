// Everything that knows about the XPS wire format lives here,
// so it's one place to change once the server side settles.

export const EDIT_REQUEST_CLASS =
  'is.sideline.apps.xps.server.web.json.messages.JsonCustomWidgetEditRequest'

export const normalizePrefix = (prefix) => {
  const p = (prefix || '').trim()
  return p.endsWith('/') ? p : p + '/'
}

/** REST call that starts a session and takes the edit lock. */
export function buildEditRequest({ serverPrefix, sessionId, widgetId, useProxy, languageCode = 'en' }) {
  const path = `xpsweb/?json=${EDIT_REQUEST_CLASS}&_languageCode=${encodeURIComponent(languageCode)}`
  const prefix = normalizePrefix(serverPrefix)
  const body = { widgetId: widgetId.trim(), mode: 'FocusedAthlete', _sessionId: sessionId.trim() }
  if (useProxy) {
    return { url: `/__xps/${path}`, headers: { 'X-Xps-Target': prefix }, body }
  }
  return { url: prefix + path, headers: {}, body }
}

/** URL of the global XPS web socket. */
export function buildSocketUrl({ serverPrefix, sessionId, useProxy }) {
  const prefix = normalizePrefix(serverPrefix)
  const path = `websockets/events/?sessionId=${encodeURIComponent(sessionId.trim())}`
  if (useProxy) {
    const here = window.location.origin.replace(/^http/, 'ws')
    return `${here}/__xpsws/${path}&xpsTarget=${encodeURIComponent(prefix)}`
  }
  return prefix.replace(/^http/, 'ws') + path
}

/**
 * Outgoing socket frame (XT2-5697): the message name followed directly by the JSON body,
 * e.g. VibeCodeRequest{"vibeCodeSessionId":"…","requestId":"…","text":"…"}
 */
export const encodeMessage = (type, payload) => `${type}${JSON.stringify(payload)}`

/** Splits a raw outgoing frame "Name{...}" into { type, payload }, or null if it isn't one. */
export function decodeOutgoing(frame) {
  const m = /^\s*([A-Za-z_][\w.]*)\s*(\{[\s\S]*\})\s*$/.exec(frame || '')
  if (!m) return null
  return { type: m[1], payload: JSON.parse(m[2]) }
}

/** Type name of an incoming message: {"msgType":"VibeCodingProgress", ...} */
export function messageType(msg) {
  if (!msg || typeof msg !== 'object') return ''
  const raw = msg.msgType ?? msg.type ?? ''
  return String(raw).split('.').pop().replace(/^Json(?=[A-Z])/, '')
}

let counter = 0
export const newRequestId = () => `r${Date.now().toString(36)}${(++counter).toString(36)}`

/** The first non-empty value among several possible field names. */
export const pick = (obj, ...keys) => {
  for (const k of keys) if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k]
  return undefined
}

/** Default selection the preview pretends the XPS tab has. */
export function defaultPreviewContext() {
  const to = new Date()
  const from = new Date(to.getTime() - 29 * 86400000)
  const day = (d) => d.toISOString().slice(0, 10)
  return {
    mode: 'FocusedAthlete',
    athleteIds: [],
    teamIds: [],
    period: { from: day(from), to: day(to), preset: 'last30Days' },
    clubId: null,
    locale: navigator.language || 'en',
    units: 'metric',
    theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    viewer: { canEdit: true, host: 'preview' },
  }
}

/** Where the widget SDK is served. Keep in step with libVersion. */
export const SDK_URL = '/vibe-coding-sdk/1/xps.js'

/** URL of a stored preview, with the starting selection in the fragment (as XPS will do it). */
export const widgetUrl = (id, context) =>
  `/__preview/${id}/index.html#ctx=${encodeURIComponent(JSON.stringify(context))}`

const SCRIPT_TAG = /<script\b([^>]*)>\s*<\/script>/gi
const srcOf = (attrs) => (/\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || ''
const isWidgetJs = (src) => /^(\.\/)?widget\.js$/i.test(src)
// Any versioned SDK location counts, e.g. /vibe-coding-sdk/1/xps.js or
// https://xps-fast.s3.amazonaws.com/vibe-coding-sdk/1/xps.js
const isSdk = (src) => /\/[^/]+\/xps\.js(\?.*)?$/i.test(src)
const isModule = (attrs) => /\btype\s*=\s*["']?module/i.test(attrs)

/**
 * Prepares a widget's index.html for the preview host. The page then loads the
 * real SDK and ./widget.js by URL, exactly like it will inside XPS.
 * Only two preview-only changes are made:
 * - an error catcher is added first in <head> (reports JS errors and console.error),
 * - with localSdk, the template's SDK address is swapped for the demo's copy,
 * - template mistakes are patched so the preview still runs, each listed in `notes`:
 *   no SDK script, widget.js loaded as a classic script, widget.js loaded twice.
 */
export function preparePreviewHtml(html, token, { localSdk = false } = {}) {
  const notes = []
  const info = []
  let body = html && html.trim() ? html : '<!doctype html><html><head><meta charset="utf-8"></head><body><main id="app"></main></body></html>'

  let hasSdk = false
  let widgetTags = 0
  let kept = false
  body = body.replace(SCRIPT_TAG, (tag, attrs) => {
    const src = srcOf(attrs)
    if (isSdk(src)) {
      hasSdk = true
      if (localSdk && src !== SDK_URL) {
        info.push(`Preview uses the demo's own SDK (${SDK_URL}) instead of ${src}. Untick "Use the demo's SDK" in Advanced to test the real one.`)
        return tag.replace(src, SDK_URL)
      }
      return tag
    }
    if (!isWidgetJs(src)) return tag
    widgetTags++
    if (!isModule(attrs)) {
      notes.push(`Template loads ${src} as a classic script; it must be <script type="module" src="./widget.js">. Ignored in the preview.`)
      return ''
    }
    if (kept) {
      notes.push('Template loads widget.js more than once. Extra copies ignored in the preview.')
      return ''
    }
    kept = true
    return tag
  })
  if (!kept) {
    if (!widgetTags) notes.push('Template never loads widget.js. Added <script type="module" src="./widget.js"> for the preview.')
    const tag = '<script type="module" src="./widget.js"></script>'
    body = /<\/body>/i.test(body) ? body.replace(/<\/body>/i, tag + '</body>') : body + tag
  }

  const catcher = `<script>(function(){
  var T=${JSON.stringify(token)};
  function send(kind,d){try{parent.postMessage(Object.assign({__xpsPreview:T,kind:kind},d),'*')}catch(e){}}
  window.addEventListener('error',function(e){if(e.target&&e.target!==window&&e.target.src){send('error',{message:'Could not load '+e.target.src});return}send('error',{message:e.message,line:e.lineno,col:e.colno,stack:e.error&&e.error.stack})},true);
  window.addEventListener('unhandledrejection',function(e){var r=e.reason;send('error',{message:'Unhandled promise rejection: '+(r&&r.message||r)})});
  var oe=console.error;console.error=function(){send('console',{message:Array.prototype.map.call(arguments,String).join(' ')});return oe.apply(console,arguments)};
  window.addEventListener('load',function(){send('loaded',{})});
})();<\/script>`
  const sdkTag = hasSdk ? '' : `<script src="${SDK_URL}"></script>`
  if (!hasSdk) notes.push(`Template never loads the SDK. Added <script src="${SDK_URL}"> for the preview.`)

  const headStuff = catcher + sdkTag
  if (/<head[^>]*>/i.test(body)) body = body.replace(/<head[^>]*>/i, (m) => m + headStuff)
  else if (/<html[^>]*>/i.test(body)) body = body.replace(/<html[^>]*>/i, (m) => m + '<head>' + headStuff + '</head>')
  else body = '<!doctype html><html><head><meta charset="utf-8">' + headStuff + '</head><body>' + body + '</body></html>'

  return { html: body, notes, info }
}
