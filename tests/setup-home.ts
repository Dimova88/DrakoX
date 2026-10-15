import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Isolated DRAKOX_HOME + workspace per test file. */
export function tempEnv(): { home: string; ws: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drakox-home-'));
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'drakox-ws-'));
  process.env.DRAKOX_HOME = home;
  // never pick up real provider keys from the developer's environment
  for (const k of Object.keys(process.env)) if (/_API_KEY$|^OPENROUTER|^GROQ|^GEMINI|^ANTHROPIC|^OPENAI/.test(k)) delete process.env[k];
  process.env.OLLAMA_HOST = 'http://127.0.0.1:9';
  process.env.DRAKOX_DISABLE_LOCAL_DISCOVERY = '1';
  return { home, ws };
}
