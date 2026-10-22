import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import httpProxy from 'http-proxy'

/**
 * Dev-only proxy that forwards to whatever server prefix is typed in the app,
 * so the browser never makes a cross-origin call (no CORS setup needed on XPS).
 *
 *   REST:       /__xps/<path>        + header  X-Xps-Target: https://testsrvr.sidelinesports.com/
 *   Web socket: /__xpsws/<path>?...  + query   xpsTarget=https://testsrvr.sidelinesports.com/
 */
function xpsDynamicProxy() {
  const proxy = httpProxy.createProxyServer({ changeOrigin: true, secure: false, ws: true })

  const parseTarget = (raw) => {
    try {
      const u = new URL(raw)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
      return u.toString().replace(/\/+$/, '')
    } catch {
      return null
    }
  }

  // Make the request look like it came from the target's own origin.
  proxy.on('proxyReq', (proxyReq, req) => {
    proxyReq.removeHeader('x-xps-target')
    if (req.xpsTarget) proxyReq.setHeader('origin', new URL(req.xpsTarget).origin)
  })
  proxy.on('proxyReqWs', (proxyReq, req) => {
    if (req.xpsTarget) proxyReq.setHeader('origin', new URL(req.xpsTarget).origin)
  })
  proxy.on('error', (err, req, res) => {
    console.error(`[xps-proxy] ${req.method} ${req.url}: ${err.message}`)
    if (res && typeof res.writeHead === 'function') {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ proxyError: err.message }))
    } else if (res && typeof res.destroy === 'function') {
      res.destroy()
    }
  })

  return {
    name: 'xps-dynamic-proxy',
    configureServer(server) {
      server.middlewares.use('/__xps', (req, res) => {
        const target = parseTarget(req.headers['x-xps-target'])
        if (!target) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ proxyError: 'Missing or invalid X-Xps-Target header' }))
          return
        }
        req.xpsTarget = target
        proxy.web(req, res, { target })
      })

      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url || !req.url.startsWith('/__xpsws/')) return // leave Vite's own HMR socket alone
        const u = new URL(req.url, 'http://localhost')
        const target = parseTarget(u.searchParams.get('xpsTarget'))
        if (!target) {
          socket.destroy()
          return
        }
        u.searchParams.delete('xpsTarget')
        req.url = u.pathname.replace(/^\/__xpsws/, '') + (u.search || '')
        req.xpsTarget = target
        proxy.ws(req, socket, head, { target })
      })
    },
  }
}

/**
 * Dev-only stand-in for where XPS will host widget files.
 *   POST /__preview                  body {html, js}  -> {id}
 *   GET  /__preview/<id>/index.html  and  /__preview/<id>/widget.js
 * Real URLs (not srcdoc) so relative paths like ./widget.js, the SDK at
 * /vibe-coding-sdk/1/xps.js and the #ctx=... fragment work exactly as in XPS.
 */
function widgetPreviewHost() {
  const store = new Map()
  let counter = 0
  const MAX = 30

  return {
    name: 'widget-preview-host',
    configureServer(server) {
      server.middlewares.use('/__preview', (req, res) => {
        if (req.method === 'POST' && (req.url === '/' || req.url === '')) {
          let body = ''
          req.on('data', (c) => (body += c))
          req.on('end', () => {
            try {
              const { html = '', js = '' } = JSON.parse(body || '{}')
              const id = `w${++counter}`
              store.set(id, { html, js })
              if (store.size > MAX) store.delete(store.keys().next().value)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ id }))
            } catch (err) {
              res.writeHead(400, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: err.message }))
            }
          })
          return
        }
        const m = /^\/(w\d+)\/([^?#]*)/.exec(req.url || '')
        const entry = m && store.get(m[1])
        const file = m && (m[2] || 'index.html')
        const headers = {
          'Cache-Control': 'no-store',
          // The iframe is sandboxed without allow-same-origin, so its origin is "null"
          // and module scripts need CORS.
          'Access-Control-Allow-Origin': '*',
        }
        if (entry && file === 'index.html') {
          // The same policy as XPS (CustomWidgetFileRules.contentSecurityPolicy): nothing from other sites.
          // Only difference: images may come from any https host, since the demo's real-server pictures aren't on localhost.
          const self = `http://${req.headers.host}`
          headers['Content-Security-Policy'] = [
            "default-src 'none'",
            `script-src ${self} https://xps-fast.s3.amazonaws.com`,
            `style-src ${self} 'unsafe-inline'`,
            `img-src ${self} data: blob: https:`,
            'font-src data:',
            "connect-src 'none'",
            "media-src 'none'",
            "frame-src 'none'",
            "worker-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
          ].join('; ')
          res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8' })
          res.end(entry.html)
        } else if (entry && file === 'widget.js') {
          res.writeHead(200, { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' })
          res.end(entry.js)
        } else {
          res.writeHead(404, { ...headers, 'Content-Type': 'text/plain' })
          res.end(entry ? `No file ${file} in this widget (only index.html and widget.js)` : 'Preview expired, reload it')
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), xpsDynamicProxy(), widgetPreviewHost()],
  server: { port: 5173, open: true },
})
