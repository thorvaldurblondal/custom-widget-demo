// XPS widget SDK, version 1.
// Served at /vibe-coding-sdk/1/xps.js. Never change a published version in a way
// that breaks widgets; ship /2/xps.js instead.
//
// Bridge between a widget running in a sandboxed iframe and the XPS page around it.
//
// Widget  -> host:  { __xpsWidget: 1, kind: "ready" }
//                   { __xpsWidget: 1, kind: "query", id, name, params, timeZoneName }
//                   { __xpsWidget: 1, kind: "resize", height }
//                   { __xpsWidget: 1, kind: "error", message, line, col, stack }   uncaught errors, failed script/image
//                                                                                    loads, unhandled promise rejections
//                   { __xpsWidget: 1, kind: "console", message }                    console.error(...)
//                   { __xpsWidget: 1, kind: "loaded" }                              the page's load event
//                   The editor's preview sends these to the AI; elsewhere the page may ignore them.
// Host -> widget:   { __xpsHost: 1, kind: "context", context }
//                   { __xpsHost: 1, kind: "queryResult", id, rows, extras }   or  { ..., id, error }
//                   extras: the reply's other fields (denied, missingTestTemplateIds, ...). The SDK puts them on
//                   the rows array, so rows.denied is always there (an empty array when nothing was denied).
//
// The starting selection comes in the URL fragment: index.html#ctx=<url-encoded JSON>,
// so xps.context is ready the moment widget code runs, and the files stay cacheable.
(function () {
  "use strict";

  // ---- Error reporting (first, so errors in the widget's own code are caught too)
  var reported = 0;
  var MAX_REPORTS = 50; // a widget stuck in an error loop shouldn't flood the page
  function clip(s, n) {
    try { s = String(s == null ? "" : s); } catch (e) { s = "?"; }
    return s.length > n ? s.slice(0, n) + "\u2026" : s;
  }
  function report(kind, d) {
    if (reported++ >= MAX_REPORTS) return;
    d.kind = kind;
    try { post(d); } catch (e) { /* nothing we can do */ }
  }
  window.addEventListener("error", function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      report("error", { message: "Could not load " + clip(t.src || t.href, 300) });
      return;
    }
    report("error", {
      message: clip(e.message, 1000),
      line: e.lineno || null,
      col: e.colno || null,
      stack: e.error && e.error.stack ? clip(e.error.stack, 2000) : null
    });
  }, true);
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    report("error", { message: "Unhandled promise rejection: " + clip(r && r.message ? r.message : r, 1000) });
  });
  var consoleError = console.error;
  console.error = function () {
    report("console", { message: clip(Array.prototype.map.call(arguments, function (a) { return clip(a, 1000); }).join(" "), 1000) });
    return consoleError.apply(console, arguments);
  };
  window.addEventListener("load", function () { post({ kind: "loaded" }); });

  function readContext() {
    var m = /[#&]ctx=([^&]*)/.exec(location.hash);
    if (!m) return {};
    try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return {}; }
  }

  // rows.denied etc.: copy the reply's extra fields onto the array without touching array built-ins.
  function withExtras(rows, extras) {
    rows = Array.isArray(rows) ? rows : [];
    rows.denied = [];
    if (extras && typeof extras === "object") {
      Object.keys(extras).forEach(function (k) {
        if (k === "result" || k === "error" || k in Array.prototype || k === "length") return;
        rows[k] = extras[k];
      });
    }
    if (!Array.isArray(rows.denied)) rows.denied = [];
    return rows;
  }

  var listeners = [];
  var pending = {};
  var nextId = 1;
  // A query the page never answers (e.g. the connection dropped) fails instead of waiting forever.
  var QUERY_TIMEOUT_MS = 60000;

  // The viewer's time zone goes with every query, so the server can work in local time.
  // Widget code never needs to know about it.
  function timeZoneName() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch (e) { return "UTC"; }
  }

  function post(msg) {
    msg.__xpsWidget = 1;
    parent.postMessage(msg, "*");
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return; // only the XPS page may talk to the widget
    var d = e.data;
    if (!d || d.__xpsHost !== 1) return;
    if (d.kind === "context") {
      xps.context = d.context || {};
      listeners.slice().forEach(function (fn) {
        try { fn(xps.context); } catch (err) { setTimeout(function () { throw err; }); }
      });
    } else if (d.kind === "queryResult" && pending[d.id]) {
      var p = pending[d.id];
      delete pending[d.id];
      clearTimeout(p.timer);
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(withExtras(d.rows, d.extras));
    }
  });

  var xps = {
    version: "1",
    context: readContext(),

    /** Calls fn(context) whenever the tab's selection changes. Returns an unsubscribe function. */
    onContextChange: function (fn) {
      listeners.push(fn);
      return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    },

    /**
     * Runs a named XPS query with the viewer's permissions. Resolves to the rows; the array also has rows.denied
     * (ids left out because the viewer may not see them) and any other lists the query sends.
     */
    query: function (name, params) {
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          if (!pending[id]) return;
          delete pending[id];
          reject(new Error("XPS did not answer the query " + String(name) + " in time"));
        }, QUERY_TIMEOUT_MS);
        pending[id] = { resolve: resolve, reject: reject, timer: timer };
        post({ kind: "query", id: id, name: String(name), params: params || {}, timeZoneName: timeZoneName() });
      });
    },

    /** Tells XPS how tall the widget content is. Call after rendering. */
    resize: function () {
      post({ kind: "resize", height: Math.ceil(document.documentElement.scrollHeight) });
    }
  };

  window.xps = xps;
  post({ kind: "ready" });
})();
