import type http from 'node:http';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  body: any;
}

type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY = 25 * 1024 * 1024; // images can be large

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\/:(\w+)(\*)?/g, (_, k: string, star: string) => {
          keys.push(k);
          return star ? '/(.+)' : '/([^/]+)';
        }) +
        '/?$',
    );
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p: string, h: Handler): this {
    return this.add('GET', p, h);
  }
  post(p: string, h: Handler): this {
    return this.add('POST', p, h);
  }
  put(p: string, h: Handler): this {
    return this.add('PUT', p, h);
  }
  patch(p: string, h: Handler): this {
    return this.add('PATCH', p, h);
  }
  delete(p: string, h: Handler): this {
    return this.add('DELETE', p, h);
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const method = req.method ?? 'GET';
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(url.pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      try {
        const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
        const out = await r.handler({ req, res, url, params, query: url.searchParams, body });
        if (res.writableEnded) return true;
        if (out === undefined) {
          res.writeHead(204).end();
        } else sendJson(res, 200, out);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : typeof (err as any)?.status === 'number' ? (err as any).status : 500;
        if (!res.headersSent) sendJson(res, status, { error: (err as Error).message ?? String(err) });
        else res.end();
      }
      return true;
    }
    if (pathMatched) {
      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    }
    return false;
  }
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

export function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

export function requireString(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `"${name}" is required`);
  return v;
}
