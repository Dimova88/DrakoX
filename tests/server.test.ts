import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempEnv } from './setup-home';

let base = '';
let token = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const env = tempEnv();
  process.env.DRAKOX_TOKEN = 'test-token-0123456789abcdef';
  token = process.env.DRAKOX_TOKEN;
  const { startServer } = await import('../src/server/index');
  const port = 45000 + Math.floor(Math.random() * 1000);
  const s = await startServer({ cwd: env.ws, port, open: false, connectMcp: false });
  base = `http://127.0.0.1:${port}`;
  close = s.close;
});

afterAll(async () => {
  await close?.();
});

describe('web server security', () => {
  it('rejects requests without the token', async () => {
    expect((await fetch(`${base}/api/info`)).status).toBe(401);
  });
  it('accepts the bearer token', async () => {
    const r = await fetch(`${base}/api/info`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    expect((await r.json()).version).toBeTruthy();
  });
  it('requires the CSRF header for mutations', async () => {
    const r = await fetch(`${base}/api/agents`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });
  it('blocks DNS-rebinding hosts', async () => {
    const http = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const u = new URL(base);
      http.get({ host: u.hostname, port: u.port, path: '/api/info', headers: { host: 'evil.example.com', authorization: `Bearer ${token}` } }, (res) => resolve(res.statusCode ?? 0));
    });
    expect(status).toBe(403);
  });
  it('sets an HttpOnly cookie from the one-time URL token', async () => {
    const r = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
    expect(r.status).toBe(302);
    expect(r.headers.get('set-cookie')).toMatch(/HttpOnly/);
  });
  it('confines file access to the workspace', async () => {
    const r = await fetch(`${base}/api/file?path=../../etc/passwd`, { headers: { authorization: `Bearer ${token}` } });
    expect(r.status).toBe(403);
  });
});
