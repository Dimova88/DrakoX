import type { Todo } from '../types.js';
import { errorResult, textResult, type Tool } from './types.js';

export const todoWriteTool: Tool<{ todos: Todo[] }> = {
  name: 'todo_write',
  kind: 'meta',
  description:
    'Create or update your task list for the current request (shown to the user as a live checklist). ' +
    'Use it for multi-step work: send the FULL list each time; exactly one item should be in_progress while working. ' +
    'Mark items completed immediately when done. Skip it for trivial single-step requests.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative description, e.g. "Add login form validation"' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
            activeForm: { type: 'string', description: 'Present-continuous form, e.g. "Adding login form validation"' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  title: (a) => {
    const t = Array.isArray(a.todos) ? a.todos : [];
    const done = t.filter((x) => x.status === 'completed').length;
    return `Update tasks (${done}/${t.length})`;
  },
  async run(a, ctx) {
    if (!Array.isArray(a.todos)) return errorResult('"todos" must be an array');
    const todos: Todo[] = a.todos
      .filter((t) => t && typeof t.content === 'string')
      .map((t) => ({
        content: t.content,
        status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending',
        activeForm: t.activeForm,
      }));
    ctx.todos.set(todos);
    ctx.emit({ type: 'todos', todos, ts: Date.now() });
    const done = todos.filter((t) => t.status === 'completed').length;
    return textResult(`Task list updated (${done}/${todos.length} completed).`);
  },
};

export const submitPlanTool: Tool<{ plan: string }> = {
  name: 'submit_plan',
  kind: 'meta',
  description:
    'Plan mode only: present your implementation plan (markdown) to the user for approval. Include goal, the files you will change, the steps, and risks/open questions. ' +
    'If approved, you will be told to proceed and may then make changes. If rejected, revise according to the feedback.',
  parameters: {
    type: 'object',
    properties: { plan: { type: 'string', description: 'The plan in markdown' } },
    required: ['plan'],
  },
  title: () => 'Submit plan for approval',
  async run(a, ctx) {
    if (typeof a.plan !== 'string' || !a.plan.trim()) return errorResult('"plan" is required');
    if (!ctx.submitPlan) return textResult('Plan recorded (non-interactive session; not executed).');
    const d = await ctx.submitPlan(a.plan);
    if (d.approved) return textResult(`The user approved the plan. Mode is now "${d.mode ?? 'auto-edit'}". Proceed with the implementation now, following the plan.${d.feedback ? `\nUser notes: ${d.feedback}` : ''}`);
    return textResult(`The user rejected the plan.${d.feedback ? ` Feedback: ${d.feedback}` : ''} Revise the plan (stay in plan mode) and submit it again, or ask a clarifying question.`);
  },
};

export const askUserTool: Tool<{ question: string; options?: string[] }> = {
  name: 'ask_user',
  kind: 'meta',
  description: 'Ask the user a clarifying question when a decision materially changes the outcome. Offer 2-4 concise options when possible. Do not overuse.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers' },
    },
    required: ['question'],
  },
  title: (a) => `Ask: ${a.question}`,
  async run(a, ctx) {
    if (!ctx.askUser) return textResult('No user is available in this session (non-interactive). Make a reasonable assumption, state it, and continue.');
    const answer = await ctx.askUser(String(a.question), Array.isArray(a.options) ? a.options.map(String) : undefined);
    return textResult(`User answered: ${answer}`);
  },
};

export const skillTool: Tool<{ name: string }> = {
  name: 'skill',
  kind: 'meta',
  parallelSafe: true,
  description: 'Load a skill (specialised instructions + resources) by name from the "Available skills" list when the task matches its description.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  title: (a) => `Load skill ${a.name}`,
  async run(a, ctx) {
    const body = await ctx.loadSkill?.(String(a.name));
    if (!body) return errorResult(`Unknown skill "${a.name}".`);
    return textResult(body);
  },
};

export const taskTool: Tool<{ description: string; prompt: string; subagent_type?: string; model?: string; isolation?: 'none' | 'worktree' }> = {
  name: 'task',
  kind: 'meta',
  parallelSafe: true,
  description:
    'Delegate a self-contained task to a sub-agent with its own fresh context window. Use it for broad codebase research, parallel independent work, ' +
    'or reviews. Call it several times in one response to run sub-agents in parallel. The sub-agent returns a final report; it cannot see this conversation, ' +
    'so the prompt must contain all needed context. isolation "worktree" gives it an isolated git worktree (for parallel edits).',
  parameters: {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Short (3-6 words) task label' },
      prompt: { type: 'string', description: 'Complete, self-contained instructions and the expected output' },
      subagent_type: { type: 'string', description: 'Agent profile from the "Available sub-agents" list (default: general)' },
      model: { type: 'string', description: 'Optional model override (provider/model)' },
      isolation: { type: 'string', enum: ['none', 'worktree'] },
    },
    required: ['description', 'prompt'],
  },
  title: (a) => `Sub-agent: ${a.description ?? 'task'}${a.subagent_type ? ` (${a.subagent_type})` : ''}`,
  async run(a, ctx) {
    if (!ctx.runSubagent) return errorResult('Sub-agents are not available here (sub-agents cannot spawn sub-agents).');
    if (!a.prompt) return errorResult('"prompt" is required');
    const report = await ctx.runSubagent({ description: a.description ?? 'task', prompt: a.prompt, agentType: a.subagent_type, model: a.model, isolation: a.isolation });
    return textResult(report);
  },
};
