# AGENTS.md — DrakoX

DrakoX is an open-source, model-agnostic AI coding agent harness: a terminal agent, a local web app
and an SDK, in one npm package.

## Layout
- `src/core/` — agent loop (`agent.ts`), runtime, providers (`providers/`), tools (`tools/`),
  permissions, sandbox, sessions/event log (`session.ts`), MCP (`mcp/`), skills, hooks, slash commands.
- `src/cli/` — terminal REPL (`repl.ts`), renderer, `exec`, subcommands (`commands.ts`), entry (`index.ts`).
- `src/server/` — local HTTP + WebSocket API (`routes.ts`, `manager.ts`, `index.ts`).
- `web/` — React 19 + Tailwind 4 app (Vite). Built into `dist/web`, served by `drakox ui`.
- `skills/`, `agents/` — bundled skills and sub-agent profiles. `docs/` — documentation.

## Commands
- Install: `npm install`
- Build everything: `npm run build` (core via `tsc`, web via Vite)
- Typecheck: `npm run typecheck`
- Tests: `npm test` (vitest; single file: `npx vitest run tests/agent.test.ts`)
- Run from source: `npm run dev` (terminal), `npm run dev:ui` + `npm run dev:web` (web with HMR)

## Conventions
- TypeScript strict, ESM (`NodeNext`); relative imports in `src/` end with `.js`.
- Agent events are the single source of truth: add new behaviour as `AgentEvent`s
  (`src/core/types.ts`), persist only non-ephemeral ones, and keep `replay()` in sync with the
  live agent (compaction and rewind must replay exactly).
- Never put secrets in config files — use `~/.drakox/credentials.json` and `${secret:KEY}`.
- Tests use the offline demo provider (`demo/drakox-demo`); no network access in tests.

## Gotchas
- The web app imports core types via `web/src/lib/types.ts` (type-only) — don't import Node modules into `web/`.
- `npm run build:core` must run before `drakox ui` can serve the UI from `dist/web`.
- Worktree features need a git repository with at least one commit.
