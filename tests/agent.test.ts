import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { tempEnv } from './setup-home';

let env: { home: string; ws: string };
beforeAll(() => {
  env = tempEnv();
});

describe('agent loop (offline demo model)', () => {
  it('runs a turn with tools, checkpoints edits, rewinds and replays from disk', async () => {
    const { Runtime } = await import('../src/core/runtime');
    const { Agent } = await import('../src/core/agent');
    const rt = await Runtime.create({ cwd: env.ws, connectMcp: false });
    const agent = await Agent.create({ runtime: rt, model: 'demo/drakox-demo', mode: 'auto-edit', interactive: false });
    const types: string[] = [];
    agent.on('event', (e: { type: string }) => types.push(e.type));

    const reason = await agent.send('Create a hello world page');
    expect(reason).toBe('completed');
    expect(types).toContain('tool_start');
    expect(types).toContain('file_change');
    const file = path.join(env.ws, 'DRAKOX_DEMO.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(agent.changedFiles().map((f) => f.path)).toContain(file);

    // code-only rewind restores the file system but keeps the conversation
    await agent.rewind(1, { conversation: false });
    expect(fs.existsSync(file)).toBe(false);
    const msgCount = agent.messages.length;
    expect(msgCount).toBeGreaterThan(2);

    // replay from the append-only log reproduces the conversation exactly
    const resumed = await Agent.resume(rt, agent.id);
    expect(resumed.messages.length).toBe(msgCount);
    expect(resumed.turn).toBe(1);

    // full rewind drops the turn
    await resumed.rewind(1);
    expect(resumed.messages.length).toBe(0);
    await rt.dispose();
  });

  it('denies approval-gated actions in headless mode and explains why', async () => {
    const { Runtime } = await import('../src/core/runtime');
    const { Agent } = await import('../src/core/agent');
    const rt = await Runtime.create({ cwd: env.ws, connectMcp: false });
    const agent = await Agent.create({ runtime: rt, model: 'demo/drakox-demo', mode: 'ask', interactive: false });
    const denials: unknown[] = [];
    agent.on('event', (e: { type: string; decision?: string }) => e.type === 'approval_response' && e.decision === 'deny' && denials.push(e));
    await agent.send('Create a file please');
    expect(denials.length).toBeGreaterThan(0);
    await rt.dispose();
  });

  it('plan mode submits a plan instead of editing', async () => {
    const { Runtime } = await import('../src/core/runtime');
    const { Agent } = await import('../src/core/agent');
    const rt = await Runtime.create({ cwd: env.ws, connectMcp: false });
    const agent = await Agent.create({ runtime: rt, model: 'demo/drakox-demo', mode: 'plan', interactive: false });
    const types: string[] = [];
    agent.on('event', (e: { type: string }) => types.push(e.type));
    const reason = await agent.send('Build a todo app');
    expect(types).toContain('plan');
    expect(types).not.toContain('file_change');
    expect(['plan_submitted', 'completed']).toContain(reason);
    await rt.dispose();
  });
});
