// XPS widget SDK, version 1.
// Served at /vibe-coding-sdk/1/xps.js. Never change a published version in a way
// that breaks widgets; ship /2/xps.js instead.
//
// Bridge between a widget running in a sandboxed iframe and the XPS page around it.
//
// Widget  -> host:  { __xpsWidget: 1, kind: "ready" }
//                   { __xpsWidget: 1, kind: "query", id, name, params }
//                   { __xpsWidget: 1, kind: "resize", height }
// Host -> widget:   { __xpsHost: 1, kind: "context", context }
//                   { __xpsHost: 1, kind: "queryResult", id, rows }   or  { ..., id, error }
//
// The starting selection comes in the URL fragment: index.html#ctx=<url-encoded JSON>,
// so xps.context is ready the moment widget code runs, and the files stay cacheable.
(function () {
  "use strict";

  function readContext() {
    var m = /[#&]ctx=([^&]*)/.exec(location.hash);
    if (!m) return {};
    try { return JSON.parse(decodeURIComponent(m[1])); } catch (e) { return {}; }
  }

  var listeners = [];
  var pending = {};
  var nextId = 1;

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
      if (d.error) p.reject(new Error(d.error));
      else p.resolve(d.rows);
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

    /** Runs a named XPS query with the viewer's permissions. Resolves to the rows. */
    query: function (name, params) {
      var id = nextId++;
      return new Promise(function (resolve, reject) {
        pending[id] = { resolve: resolve, reject: reject };
        post({ kind: "query", id: id, name: String(name), params: params || {} });
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
