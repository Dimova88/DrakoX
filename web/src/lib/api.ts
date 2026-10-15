const HEADERS = { 'content-type': 'application/json', 'X-DrakoX': '1' };

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const res = await fetch(path, {
    method,
    headers: HEADERS,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    signal: opts.signal,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError((data as any).error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

export const get = <T = any>(p: string, signal?: AbortSignal) => api<T>(p, { signal });
export const post = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'POST', body });
export const put = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'PUT', body });
export const patch = <T = any>(p: string, body: unknown = {}) => api<T>(p, { method: 'PATCH', body });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Reconnecting WebSocket for the live event stream. */
export function connectWs(onMessage: (m: any) => void, onStatus: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      retry = 0;
      onStatus(true);
    };
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = () => {
      onStatus(false);
      if (!closed) timer = setTimeout(open, Math.min(10_000, 400 * 2 ** retry++));
    };
    ws.onerror = () => ws?.close();
  };
  open();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

export function fileToImagePart(file: File): Promise<{ type: 'image'; mediaType: string; data: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      resolve({ type: 'image', mediaType: file.type || 'image/png', data: url.slice(comma + 1) });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
