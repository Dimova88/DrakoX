import type { Tool } from './types.js';
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './fs.js';
import { applyPatchTool } from './patch.js';
import { globTool, grepTool } from './search.js';
import { bashKillTool, bashOutputTool, bashTool } from './shell.js';
import { webFetchTool, webSearchTool } from './web.js';
import { askUserTool, skillTool, submitPlanTool, taskTool, todoWriteTool } from './meta.js';

export * from './types.js';
export { BackgroundShells } from './shell.js';
export { applyEdit } from './fs.js';
export { parsePatch, applyChunks } from './patch.js';
export { webSearchAvailable } from './web.js';

/** All built-in tools, in the order they are presented to the model. */
export const BUILTIN_TOOLS: Tool<any>[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  editFileTool,
  writeFileTool,
  applyPatchTool,
  bashTool,
  bashOutputTool,
  bashKillTool,
  webFetchTool,
  webSearchTool,
  todoWriteTool,
  taskTool,
  skillTool,
  askUserTool,
  submitPlanTool,
];

export function builtinTool(name: string): Tool<any> | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name);
}

/** Claude Code / Codex tool names → DrakoX names (for portable agent definitions & hooks). */
export const TOOL_ALIASES: Record<string, string> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Bash: 'bash',
  BashOutput: 'bash_output',
  KillShell: 'bash_kill',
  Glob: 'glob',
  Grep: 'grep',
  LS: 'list_dir',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  Task: 'task',
  Skill: 'skill',
  ExitPlanMode: 'submit_plan',
  AskUserQuestion: 'ask_user',
  shell: 'bash',
  apply_patch: 'apply_patch',
};

export function normalizeToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}
