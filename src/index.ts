/**
 * DrakoX SDK — embed the agent harness in your own tools.
 *
 *   import { Runtime, Agent } from 'drakox';
 *   const runtime = await Runtime.create({ cwd: process.cwd() });
 *   const agent = await Agent.create({ runtime, interactive: false, autoApprove: false });
 *   agent.on('event', (e) => { if (e.type === 'text_delta') process.stdout.write(e.delta); });
 *   await agent.send('Explain this repository');
 */
export * from './core/types.js';
export { Runtime, type RuntimeOptions } from './core/runtime.js';
export { Agent, type AgentOptions, type AgentSnapshot, unifiedDiff } from './core/agent.js';
export { SessionStore, replay, type SessionMeta } from './core/session.js';
export { ProviderRegistry, PROVIDER_PRESETS, getPreset, type Provider, type ProviderStatus } from './core/providers/index.js';
export { McpManager, type McpServerState, type McpStatus } from './core/mcp/manager.js';
export { CATALOG as MCP_CATALOG, catalogEntry, type CatalogEntry } from './core/mcp/catalog.js';
export { BUILTIN_TOOLS, type Tool, type ToolContext, type ToolResult } from './core/tools/index.js';
export { evaluatePermission } from './core/permissions.js';
export { loadConfig, updateConfigFile, readCredentials, updateCredentials } from './core/config.js';
export { listSlashCommands, resolveSlash, BUILTIN_COMMANDS } from './core/slash.js';
export { paths, packageVersion } from './core/paths.js';
