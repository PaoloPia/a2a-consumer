import http from 'node:http'
import https from 'node:https'
import { defineConfig } from 'vite'
import type { ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const PROXY_PREFIX = '/__a2a_proxy__/'

/**
 * Dev-only transparent HTTP proxy that allows the browser-based SPA to call
 * any A2A agent endpoint without being blocked by CORS.  All outgoing
 * requests are routed through this local Vite middleware, which forwards them
 * from Node.js (where CORS does not apply) and injects the required
 * Access-Control response headers before returning the reply to the browser.
 *
 * This middleware is only active during `npm run dev`.  Production builds make
 * direct requests, so the target server must support CORS in that case.
 */
function a2aDevProxy() {
  return {
    name: 'a2a-dev-proxy',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(PROXY_PREFIX)) {
          return next()
        }

        // CORS preflight — answer immediately without touching the upstream
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'access-control-max-age': '86400',
          })
          res.end()
          return
        }

        const encoded = req.url.slice(PROXY_PREFIX.length)
        let targetUrl: URL
        try {
          targetUrl = new URL(decodeURIComponent(encoded))
        } catch {
          res.writeHead(400)
          res.end('a2a-dev-proxy: invalid target URL')
          return
        }

        if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
          res.writeHead(400)
          res.end('a2a-dev-proxy: only http/https targets are supported')
          return
        }

        // Build forwarded headers — replace host, strip origin/referer so the
        // upstream server does not see the localhost origin.
        const fwdHeaders: Record<string, string | string[] | undefined> = {}
        for (const [k, v] of Object.entries(req.headers)) {
          if (k !== 'host' && k !== 'origin' && k !== 'referer') {
            fwdHeaders[k] = v
          }
        }
        fwdHeaders['host'] = targetUrl.host

        const transport = targetUrl.protocol === 'https:' ? https : http
        const options: http.RequestOptions = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: req.method,
          headers: fwdHeaders,
        }

        const proxyReq = transport.request(options, (proxyRes) => {
          const respHeaders: Record<string, string | string[]> = {}
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (v !== undefined) respHeaders[k] = v
          }
          // Allow the browser to read the response
          respHeaders['access-control-allow-origin'] = '*'
          respHeaders['access-control-expose-headers'] = '*'

          res.writeHead(proxyRes.statusCode ?? 200, respHeaders)
          // Pipe works for both regular JSON and SSE streaming responses
          proxyRes.pipe(res)
        })

        proxyReq.on('error', (err) => {
          if (!res.headersSent) res.writeHead(502)
          res.end(`a2a-dev-proxy upstream error: ${err.message}`)
        })

        req.pipe(proxyReq)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), a2aDevProxy()],
})
