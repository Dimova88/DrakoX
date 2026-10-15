# Integrations (MCP)

DrakoX speaks the **Model Context Protocol**. Anything with an MCP server can be connected; anything
without one can get one (see the bundled `/mcp-builder` skill).

## Ways to add an integration

| How | Terminal | Web app |
|---|---|---|
| Curated catalog (43 apps) | `drakox mcp catalog`, `drakox mcp install <id>` | Integrations → Catalog |
| Official MCP Registry | `drakox mcp search <q>`, `drakox mcp add-registry <name>` | Integrations → MCP Registry |
| Any local command | `drakox mcp add <name> [-e KEY=VAL] -- <command> [args…]` | Integrations → Add custom |
| Any remote URL | `drakox mcp add <name> <url> [-H "Header: value"]` | Integrations → Add custom |
| Paste JSON (Claude/Cursor/VS Code/Codex formats) | `drakox mcp paste < config.json` | Integrations → Add custom → Paste JSON |
| Import from other tools | `drakox mcp import [--from <id>]` | Integrations → Import |

Remote servers that need sign-in: `drakox mcp login <name>` (opens the browser; callback on
`127.0.0.1:4546`) or the **Sign in** button in the web app.

## Scopes

- `user` (default): `~/.drakox/config.json` — available in every project.
- `project`: `.mcp.json` in the repository — shared with your team (no secrets inside).
- `local`: `.drakox/settings.local.json` — this project, only you (git-ignored).

Project-defined local servers only start after you **trust** the folder (`/trust`, `drakox trust`
or the banner in the web app).

## Secrets

Secrets are stored in `~/.drakox/credentials.json` (mode 600) and referenced from config as
`${secret:KEY}`. Environment variables can be referenced as `${env:VAR}`. When you add a server with
literal tokens (or paste a config), DrakoX moves them to the credentials file automatically.

## Large servers

When connected servers expose more than 40 tools (or ~60k characters of schemas), DrakoX offers a
single `tool_search` tool. The agent searches by capability and the matching tools are activated for
the following steps. Configure with `"mcpToolSearch": "auto" | "on" | "off"`.

## Approvals for integration tools

Read-only tools (annotated `readOnlyHint`) run without asking in ask mode; others ask unless a rule
allows them, e.g. `"allow": ["mcp__github__get_*", "mcp__linear__*"]`. Set `"autoApprove": true`
(or a list of tool names) on a server to trust it entirely.

## REA

`drakox mcp install rea` → `npx -y rea-agents@6.5.0 mcp` (Node 22.19+). Use with the
`/reverse-engineer` skill or the `reverse-engineer` sub-agent.
