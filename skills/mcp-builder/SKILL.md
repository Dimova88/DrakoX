---
name: mcp-builder
description: Build a custom integration (an MCP server) so DrakoX — and any MCP client — can talk to an app, API, database or internal tool that has no integration yet. Use when the user wants to connect something that isn't in the catalog or the MCP Registry.
---

# Build your own integration (MCP server)

DrakoX integrations are **Model Context Protocol** servers, so anything you build here also
works in Claude Code, Codex, Cursor, VS Code and others.

## 1. Design
- List the 3–8 most useful **tools** (verbs: `search_tickets`, `create_invoice`), their inputs
  (JSON Schema with descriptions) and outputs (concise text/JSON). Mark read-only tools with
  `readOnlyHint` and destructive ones with `destructiveHint`.
- Decide auth: API key via environment variable (local stdio server) or OAuth (remote server).

## 2. Scaffold (TypeScript, stdio)
```bash
mkdir my-mcp && cd my-mcp && npm init -y
npm install @modelcontextprotocol/sdk zod
```
`index.mjs`:
```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'my-app', version: '0.1.0' });
server.registerTool(
  'search_items',
  { description: 'Search items by keyword', inputSchema: { query: z.string() }, annotations: { readOnlyHint: true } },
  async ({ query }) => {
    const res = await fetch(`https://api.example.com/items?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${process.env.MY_APP_TOKEN}` },
    });
    return { content: [{ type: 'text', text: JSON.stringify(await res.json(), null, 2) }] };
  },
);
await server.connect(new StdioServerTransport());
```
(Python: `pip install mcp` and use `FastMCP` with `@mcp.tool()` decorators.)

## 3. Connect it to DrakoX
```bash
drakox mcp add my-app -e MY_APP_TOKEN=xxxx -- node /abs/path/my-mcp/index.mjs
```
or in the web UI: **Integrations → Add custom**. Secrets are moved to
`~/.drakox/credentials.json` automatically. Use `--scope project` to share it with your team
via `.mcp.json` (teammates provide their own secrets).

## 4. Test
Run `drakox mcp get my-app` to list its tools, then ask DrakoX to use them. Keep tool output
small (summaries, pagination) — large outputs waste context.
