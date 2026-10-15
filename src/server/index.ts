import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { Runtime } from '../core/runtime.js';
import type { DrakoxConfig } from '../core/types.js';
import { packageRoot, packageVersion } from '../core/paths.js';
import { AgentManager } from './manager.js';
import { Router, sendJson } from './http.js';
import { registerRoutes } from './routes.js';
import { authPage, openBrowser } from '../cli/commands.js';
import { c, logo } from '../cli/ansi.js';

export interface ServerOptions {
  cwd: string;
  overrides?: Partial<DrakoxConfig>;
  port?: number;
  host?: string;
  open?: boolean;
  /** Require the session token (default true). Disable only for trusted sandboxes. */
  auth?: boolean;
  connectMcp?: boolean;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

const COOKIE = 'drakox_token';

export async function startServer(o: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const port = o.port ?? Number(process.env.DRAKOX_PORT ?? 4545);
  const host = o.host ?? process.env.DRAKOX_HOST ?? '127.0.0.1';
  const auth = o.auth !== false;
  const token = process.env.DRAKOX_TOKEN || randomBytes(24).toString('hex');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  let publicBase = `http://${loopback ? host.replace('::1', '[::1]') : '127.0.0.1'}:${port}`;

  const runtime = await Runtime.create({ cwd: o.cwd, overrides: o.overrides, connectMcp: o.connectMcp !== false, oauthRedirectBase: () => publicBase });
  const manager = new AgentManager(runtime);
  const clients = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  manager.on('event', (m) => broadcast({ type: 'event', ...m }));
  manager.on('agent', (agent) => broadcast({ type: 'agent', agent }));
  manager.on('removed', (id) => broadcast({ type: 'removed', id }));
  runtime.on('mcp', () => broadcast({ type: 'mcp' }));
  runtime.on('mcp_auth', (x) => broadcast({ type: 'mcp_auth', ...x }));

  const router = new Router();
  registerRoutes(router, { runtime, manager, broadcast, setPublicBase: (b) => (publicBase = b), publicBase: () => publicBase });

  const webRoot = path.join(packageRoot(), 'dist', 'web');

  const allowedHost = (req: http.IncomingMessage): boolean => {
    if (!loopback) return true; // user chose to expose the server (e.g. --host 0.0.0.0)
    const h = (req.headers.host ?? '').toLowerCase();
    return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost', '127.0.0.1'].includes(h);
  };
  const tokenOk = (candidate: string | undefined | null): boolean => {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const authorized = (req: http.IncomingMessage): boolean => {
    if (!auth) return true;
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (tokenOk(bearer)) return true;
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    return tokenOk(cookie);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!allowedHost(req)) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Invalid Host header');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');

      // OAuth redirect from an integration's sign-in page (protected by the OAuth state check)
      const oauth = /^\/oauth\/callback\/([^/]+)$/.exec(url.pathname);
      if (oauth) {
        const name = decodeURIComponent(oauth[1]!);
        const code = url.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        if (!code) {
          res.end(authPage(false, url.searchParams.get('error_description') ?? url.searchParams.get('error') ?? 'No authorization code'));
          return;
        }
        try {
          const st = await runtime.mcp.finishAuth(name, code, url.searchParams.get('state') ?? undefined);
          res.end(authPage(st.status === 'connected', st.error) + `<script>try{window.opener&&window.opener.postMessage({type:'drakox-oauth',server:${JSON.stringify(name)}},'*')}catch(e){}</script>`);
        } catch (err) {
          res.end(authPage(false, (err as Error).message));
        }
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized — open the URL printed by `drakox ui` (it contains the session token).' });
        const method = req.method ?? 'GET';
        if (method !== 'GET' && method !== 'HEAD' && req.headers['x-drakox'] !== '1') return sendJson(res, 403, { error: 'Missing X-DrakoX header' });
        const handled = await router.handle(req, res, url);
        if (!handled) sendJson(res, 404, { error: 'Not found' });
        return;
      }

      // token bootstrap: /?token=… → HttpOnly cookie, then clean URL
      const qToken = url.searchParams.get('token');
      if (auth && qToken) {
        if (!tokenOk(qToken)) {
          res.writeHead(401, { 'content-type': 'text/plain' }).end('Invalid token');
          return;
        }
        url.searchParams.delete('token');
        res.writeHead(302, {
          'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          location: url.pathname + (url.search || ''),
        });
        res.end();
        return;
      }

      serveStatic(webRoot, url.pathname, res, auth && !authorized(req));
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws' || !allowedHost(req)) {
      socket.destroy();
      return;
    }
    if (auth) {
      const origin = req.headers.origin;
      if (origin && loopback) {
        try {
          const o2 = new URL(origin);
          if (!['localhost', '127.0.0.1', '[::1]'].includes(o2.hostname)) {
            socket.destroy();
            return;
          }
        } catch {
          socket.destroy();
          return;
        }
      }
      if (!authorized(req) && !tokenOk(url.searchParams.get('token'))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'hello', version: packageVersion() }));
      ws.on('message', (raw) => {
        try {
          const m = JSON.parse(String(raw));
          if (m?.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.t }));
        } catch {
          /* ignore */
        }
      });
      ws.on('close', () => clients.delete(ws));
      ws.on('error', () => clients.delete(ws));
    });
  });

  // keep-alive so proxies do not drop idle sockets
  const heartbeat = setInterval(() => broadcast({ type: 'heartbeat', t: Date.now() }), 25_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} is already in use. Try: drakox ui --port ${port + 1}`));
      else reject(err);
    });
    server.listen(port, host, () => resolve());
  });

  const displayHost = loopback ? host.replace('::1', '[::1]') : host === '0.0.0.0' ? 'localhost' : host;
  const baseUrl = `http://${displayHost}:${port}`;
  const openUrl = auth ? `${baseUrl}/?token=${token}` : baseUrl;
  if (!fs.existsSync(path.join(webRoot, 'index.html'))) {
    console.log(c.warn(`⚠ Web UI assets not found in ${webRoot}. Run \`npm run build\` (API is still available).`));
  }
  console.log(`\n${logo()}\n`);
  console.log(`  ${c.bold('DrakoX')} ${c.dim('v' + packageVersion())} — web app running`);
  console.log(`  ${c.dim('workspace')} ${runtime.projectRoot}`);
  console.log(`  ${c.dim('open     ')} ${c.brand(c.underline(openUrl))}`);
  if (!auth) console.log(c.warn(`  ⚠ Authentication is disabled${!loopback ? ' and the server is reachable from the network' : ''}. Anyone who can reach it can run commands as you.`));
  else if (!loopback) console.log(c.warn('  ⚠ Listening on all interfaces — keep the token private.'));
  console.log(c.dim('  Press Ctrl+C to stop.\n'));
  if (o.open) openBrowser(openUrl);

  const close = async () => {
    clearInterval(heartbeat);
    for (const ws of clients) ws.close();
    await manager.dispose();
    await runtime.dispose();
    await new Promise<void>((r) => server.close(() => r()));
  };
  let closing = false;
  const onSignal = () => {
    if (closing) process.exit(1);
    closing = true;
    console.log(c.dim('\n  Shutting down…'));
    void close().finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return { url: openUrl, close };
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function serveStatic(root: string, pathname: string, res: http.ServerResponse, locked: boolean): void {
  let rel = decodeURIComponent(pathname);
  if (rel.includes('\0')) {
    res.writeHead(400).end();
    return;
  }
  rel = path.normalize(rel).replace(/^([/\\])+/, '');
  let file = path.join(root, rel);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  let st = fs.statSync(file, { throwIfNoEntry: false });
  if (!st || st.isDirectory()) {
    // SPA fallback
    file = path.join(root, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>DrakoX</title><body style="font-family:system-ui;background:#0b0b0f;color:#eee;padding:40px"><h1>DrakoX API is running</h1><p>The web UI has not been built. Run <code>npm run build</code> and restart <code>drakox ui</code>.</p></body>`);
      return;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const isAsset = rel.startsWith('assets/');
  if (locked && ext === '.html') {
    res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8"><title>DrakoX — locked</title><body style="font-family:system-ui;background:#0b0b0f;color:#e7e7ea;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:460px"><div style="font-size:42px">🔒</div><h2>This DrakoX session is private</h2><p style="color:#9a9aa5">Open the link printed in your terminal by <code>drakox ui</code> — it contains a one-time token.</p></div></body>`,
    );
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}
