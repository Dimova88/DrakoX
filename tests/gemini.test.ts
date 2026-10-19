import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempEnv } from './setup-home';
import { GeminiProvider, geminiToolName, toGeminiSchema } from '../src/core/providers/gemini';
import { describeNetworkError } from '../src/core/providers/types';

/**
 * A local stand-in for generativelanguage.googleapis.com that follows Google's documented behaviour:
 * x-goog-api-key auth (an extra Authorization header is rejected, as Google does for "AQ." keys),
 * SSE streaming with thought parts, function calls carrying thought signatures, and Google's error JSON.
 */
const KEY = 'AQ.Ab8RN6-mock-auth-key-for-tests-0123456789abcdef';
const WEIRD_TOOL = 'mcp__weird server__get/thing';
let base = '';
let server: http.Server;
let env: { home: string; ws: string };
const requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];

const googleError = (code: number, message: string, status: string, reason?: string) =>
  JSON.stringify({ error: { code, message, status, ...(reason ? { details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } : {}) } });

function sse(res: http.ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
  res.end();
}

beforeAll(async () => {
  env = tempEnv();
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const url = req.url ?? '';
    requests.push({ method: req.method ?? 'GET', path: url, headers: req.headers, body });
    if (req.headers.authorization) {
      res.writeHead(400).end(googleError(400, 'Multiple authentication credentials received. Please pass only one.', 'INVALID_ARGUMENT'));
      return;
    }
    if (req.headers['x-goog-api-key'] !== KEY) {
      res.writeHead(400).end(googleError(400, 'API key not valid. Please pass a valid API key.', 'INVALID_ARGUMENT', 'API_KEY_INVALID'));
      return;
    }
    if (req.method === 'GET' && url.startsWith('/v1beta/models?')) {
      res.end(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
            { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'TTS', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/gemma-3-27b-it', displayName: 'Gemma', supportedGenerationMethods: ['generateContent'] },
          ],
        }),
      );
      return;
    }
    if (url === '/v1beta/models/gemini-flash-latest:streamGenerateContent?alt=sse') {
      const answered = body.contents.some((c: any) => c.parts.some((p: any) => p.functionResponse));
      if (!answered) {
        sse(res, [
          { candidates: [{ content: { role: 'model', parts: [{ text: 'The user wants the file contents.', thought: true }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ text: 'Let me read ' }] } }] },
          { candidates: [{ content: { role: 'model', parts: [{ text: 'the file.' }] } }] },
          {
            candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'hello.txt' } }, thoughtSignature: 'SIG-123' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 20, thoughtsTokenCount: 8, totalTokenCount: 148 },
          },
        ]);
      } else {
        // Gemini 3 rejects multi-step function calling when the signature is not sent back
        const model = body.contents.find((c: any) => c.role === 'model');
        if (!model?.parts.some((p: any) => p.functionCall && p.thoughtSignature === 'SIG-123')) {
          res.writeHead(400).end(googleError(400, 'Function call is missing a thought_signature in functionCall parts.', 'INVALID_ARGUMENT'));
          return;
        }
        sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ text: 'The file says: hello from Gemini.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 9, totalTokenCount: 209 } }]);
      }
      return;
    }
    if (url === '/v1beta/models/gemini-names:streamGenerateContent?alt=sse') {
      sse(res, [{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: geminiToolName(WEIRD_TOOL), args: { q: 1 } } }] }, finishReason: 'STOP' }] }]);
      return;
    }
    if (url === '/v1beta/models/gemini-denied:streamGenerateContent?alt=sse') {
      res
        .writeHead(401)
        .end(googleError(401, 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential.', 'UNAUTHENTICATED', 'ACCESS_TOKEN_TYPE_UNSUPPORTED'));
      return;
    }
    res.writeHead(404).end(googleError(404, 'models/unknown is not found for API version v1beta.', 'NOT_FOUND'));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
});

afterAll(() => {
  server?.close();
});

async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('native Gemini provider', () => {
  it('lists chat models using only the x-goog-api-key header (works with AQ. keys)', async () => {
    const p = new GeminiProvider('gemini', { baseURL: base, apiKey: KEY });
    const models = await p.listModels();
    expect(models.map((m) => m.id)).toEqual(['gemini-flash-latest', 'gemini-2.5-flash']);
    expect(models[0]!.contextWindow).toBe(1048576);
    const req = requests.find((r) => r.path.startsWith('/v1beta/models?'))!;
    expect(req.headers['x-goog-api-key']).toBe(KEY);
    expect(req.headers.authorization).toBeUndefined();
  });

  it('runs a full agent turn: streams reasoning, calls a tool, replays the thought signature', async () => {
    fs.writeFileSync(path.join(env.ws, 'hello.txt'), 'hello from Gemini\n');
    const { Runtime } = await import('../src/core/runtime');
    const { Agent } = await import('../src/core/agent');
    const rt = await Runtime.create({ cwd: env.ws, connectMcp: false, overrides: { providers: { gemini: { type: 'gemini', baseURL: base, apiKey: KEY } } } });
    const agent = await Agent.create({ runtime: rt, model: 'gemini/gemini-flash-latest', mode: 'auto-edit', interactive: false });
    let reasoning = '';
    const tools: string[] = [];
    agent.on('event', (e: any) => {
      if (e.type === 'reasoning_delta') reasoning += e.delta;
      if (e.type === 'tool_result') tools.push(`${e.name}:${e.isError ? 'error' : 'ok'}`);
    });
    const before = requests.length;
    expect(await agent.send('What does hello.txt say?')).toBe('completed');
    expect(reasoning).toContain('wants the file');
    expect(tools).toEqual(['read_file:ok']);
    expect(agent.lastAssistantText()).toBe('The file says: hello from Gemini.');
    expect(agent.totals.inputTokens).toBe(320);

    const calls = requests.slice(before).filter((r) => r.path.includes(':streamGenerateContent'));
    expect(calls).toHaveLength(2);
    const [first, second] = [calls[0]!.body, calls[1]!.body];
    // request shape: system instruction, tool declarations as clean JSON Schema, thinking enabled
    expect(first.systemInstruction.parts[0].text.length).toBeGreaterThan(100);
    const decls = first.tools[0].functionDeclarations;
    expect(decls.find((d: any) => d.name === 'read_file').parametersJsonSchema.properties.path).toBeTruthy();
    expect(JSON.stringify(decls)).not.toMatch(/additionalProperties|\$schema/);
    expect(first.generationConfig.thinkingConfig).toEqual({ includeThoughts: true });
    // the model's own parts come back verbatim: merged text + signed function call, no unsigned thought summary
    const modelTurn = second.contents.find((c: any) => c.role === 'model');
    expect(modelTurn.parts).toEqual([{ text: 'Let me read the file.' }, { functionCall: { name: 'read_file', args: { path: 'hello.txt' } }, thoughtSignature: 'SIG-123' }]);
    const response = second.contents.flatMap((c: any) => c.parts).find((p: any) => p.functionResponse);
    expect(response.functionResponse.name).toBe('read_file');
    expect(response.functionResponse.id).toBeUndefined();
    expect(JSON.stringify(response.functionResponse.response)).toContain('hello from Gemini');

    // the raw parts survive a restart (event log replay)
    const resumed = await Agent.resume(rt, agent.id);
    const withCalls = resumed.messages.find((m: any) => m.role === 'assistant' && m.toolCalls?.length) as any;
    expect(withCalls.providerMeta.geminiParts).toHaveLength(2);
    await rt.dispose();
  });

  it('maps sanitized tool names back to the original names', async () => {
    const p = new GeminiProvider('gemini', { baseURL: base, apiKey: KEY });
    const events: any[] = [];
    for await (const ev of p.stream({ model: 'gemini-names', system: 's', messages: [{ role: 'user', content: 'go' }], tools: [{ name: WEIRD_TOOL, description: 'd', parameters: { type: 'object', properties: { q: { type: 'number' } } } }] })) events.push(ev);
    const done = events.find((e) => e.type === 'done');
    expect(done.toolCalls[0].name).toBe(WEIRD_TOOL);
    expect(geminiToolName(WEIRD_TOOL)).toBe('mcp__weird_server__get_thing');
    const long = geminiToolName(`mcp__server__${'x'.repeat(80)}`);
    expect(long).toHaveLength(64);
    expect(geminiToolName(`mcp__server__${'x'.repeat(80)}`)).toBe(long);
    expect(geminiToolName('9lives')).toBe('_9lives');
  });

  it('explains rejected keys and unreachable hosts instead of "fetch failed"', async () => {
    const wrong = new GeminiProvider('gemini', { baseURL: base, apiKey: 'AIzaSy-wrong' });
    const e1: any = await wrong.listModels().catch((e) => e);
    expect(e1.kind).toBe('auth');
    expect(e1.message).toMatch(/API key not valid.*aistudio\.google\.com\/apikey/);

    const p = new GeminiProvider('gemini', { baseURL: base, apiKey: KEY });
    const e2: any = await p.stream({ model: 'gemini-denied', system: '', messages: [{ role: 'user', content: 'hi' }], tools: [] }).next().catch((e) => e);
    expect(e2).toMatchObject({ kind: 'auth', status: 401 });
    expect(e2.message).toContain('ACCESS_TOKEN_TYPE_UNSUPPORTED');

    const port = await closedPort();
    const off = new GeminiProvider('gemini', { baseURL: `http://127.0.0.1:${port}/v1beta`, apiKey: KEY });
    const e3: any = await off.listModels().catch((e) => e);
    expect(e3.kind).toBe('network');
    expect(e3.message).toMatch(/^Can't reach 127\.0\.0\.1:\d+ \(gemini\): the connection was refused/);

    // the exact failure this sandbox produces for Google (TLS connection cut by a firewall)
    const reset = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET', message: 'Client network socket disconnected before secure TLS connection was established' } });
    expect(describeNetworkError(reset, 'https://generativelanguage.googleapis.com/v1beta/models', 'gemini')).toBe(
      "Can't reach generativelanguage.googleapis.com (gemini): the connection was cut before it was established, which usually means a firewall, proxy or VPN is blocking this host.",
    );
  });

  it('normalises MCP-style JSON Schemas into what Gemini acts on', () => {
    const schema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { $ref: '#/$defs/Target' },
        mode: { anyOf: [{ type: 'string', enum: ['fast', 'deep'] }, { type: 'null' }], default: null },
        tags: { type: ['array', 'null'], items: { type: 'string', pattern: '^[a-z]+$' } },
        version: { const: 'v1' },
        limits: { allOf: [{ type: 'object', properties: { max: { type: 'integer', minimum: 1 } } }, { properties: { min: { type: 'integer' } }, required: ['min'] }] },
      },
      required: ['target', 'ghost'],
      $defs: { Target: { type: 'object', title: 'Target', properties: { path: { type: 'string', format: 'uri' }, child: { $ref: '#/$defs/Target' } }, required: ['path'] } },
    };
    expect(toGeminiSchema(schema)).toEqual({
      type: 'object',
      properties: {
        target: { type: 'object', description: 'Target', properties: { path: { type: 'string' }, child: { type: 'object' } }, required: ['path'] },
        mode: { type: 'string', enum: ['fast', 'deep'] },
        tags: { type: 'array', items: { type: 'string' } },
        version: { type: 'string', enum: ['v1'] },
        limits: { type: 'object', properties: { max: { type: 'integer', minimum: 1 }, min: { type: 'integer' } }, required: ['min'] },
      },
      required: ['target'],
    });
    expect(toGeminiSchema({ type: 'object', properties: {} })).toBeUndefined();
  });
});
