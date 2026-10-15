# Architecture

```
┌────────────┐   ┌──────────────────────────────┐   ┌──────────────────────────┐
│ drakox CLI │   │ drakox ui (HTTP + WebSocket) │   │ SDK (import 'drakox')    │
│ REPL/exec  │   │ REST /api/* · /ws events     │   │                          │
└─────┬──────┘   └──────────────┬───────────────┘   └────────────┬─────────────┘
      └──────────────┬──────────┴────────────────────────────────┘
                     ▼
              ┌─────────────┐   one per workspace: config, providers, MCP, sessions, shells
              │   Runtime   │
              └──────┬──────┘
                     ▼
              ┌─────────────┐   turn loop · tool batches · approvals · checkpoints · compaction
              │    Agent    │──▶ sub-agents (task tool, optional git worktree)
              └──────┬──────┘
     ┌───────────────┼──────────────────┬───────────────────┬──────────────────┐
     ▼               ▼                  ▼                   ▼                  ▼
 Providers      Built-in tools      Permission engine    MCP manager       SessionStore
 openai/        read/list/glob/     modes × rules ×      stdio/HTTP/SSE,   events.jsonl
 anthropic/     grep/edit/write/    sandbox; hooks       OAuth, tool       + blobs (file
 ollama/demo    apply_patch/bash…                        search            checkpoints)
```

## Key flows

**Turn loop** (`src/core/agent.ts`): user message → `UserPromptSubmit` hooks → model stream (text,
reasoning, tool calls) → tools grouped into parallel-safe batches → for each tool: permission check →
approval (if needed) → `PreToolUse` hook → run → `PostToolUse` hook → results appended → repeat until
the model stops, the step limit, the budget, a plan submission or an interrupt.

**Event log** (`src/core/session.ts`): every persistent event is appended to
`~/.drakox/sessions/<id>/events.jsonl`. `replay()` rebuilds the exact message list, including
compactions and rewinds, so resume is exact after crashes. File contents before/after each edit
are stored content-addressed in `blobs/` to power checkpoints.

**Permissions** (`src/core/permissions.ts`): deny rules → catastrophic-command block → sensitive paths
→ allow rules → mode policy (plan/ask/auto-edit/autopilot) → sandbox availability. Shell commands
are split into segments; every segment must be safe for auto-approval.

**Sandbox** (`src/core/sandbox.ts`): Seatbelt (`sandbox-exec`) on macOS, bubblewrap on Linux,
with writable roots = workspace + temp. Without a sandbox, non-read-only commands always ask.

**MCP** (`src/core/mcp/manager.ts`): connects stdio / Streamable HTTP / SSE servers (auto-fallback),
OAuth 2.1 + PKCE for remote servers (tokens in credentials.json), `${secret:KEY}` / `${env:VAR}`
placeholders, tool output wrapped as untrusted content. Large tool sets are deferred behind
`tool_search`.

**Web server** (`src/server/`): token → HttpOnly cookie auth, Host-header check, `X-DrakoX` CSRF
header, workspace-confined file APIs, WebSocket broadcast of all agent events, OAuth callback route.

**Web app** (`web/`): React 19 + zustand store fed by the WebSocket; views for Mission Control,
agents, editor (Monaco, lazy-loaded), integrations, skills, settings and the event log.
