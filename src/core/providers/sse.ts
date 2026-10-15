/** Minimal, spec-compliant Server-Sent Events parser over a fetch body. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event: string | undefined;
  let data: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'data') data.push(val);
        else if (field === 'event') event = val;
      }
    }
    buf += decoder.decode();
    if (buf.trim()) {
      for (const line of buf.split(/\r?\n/)) {
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
    }
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Newline-delimited JSON stream parser (Ollama native API). */
export async function* parseNDJSON(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch {
          /* skip malformed line */
        }
      }
    }
    const rest = (buf + decoder.decode()).trim();
    if (rest) {
      try {
        yield JSON.parse(rest);
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
