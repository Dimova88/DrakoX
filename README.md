<div align="center">

<img src="web/public/favicon.svg" width="88" alt="DrakoX logo" />

# DrakoX

**The open agent harness. Any model, any app, no limits.**

A terminal agent, a web app with Mission Control and an editor, and an SDK. It takes the best
ideas from Claude Code, Codex, Antigravity, Cursor and Muse Code, and fixes their weak spots.

[Quick start](#quick-start) · [Free & unlimited](#free--unlimited-for-real) · [Integrations](#integrations-connect-any-app) · [Web app](#the-web-app) · [Terminal](#the-terminal) · [Docs](docs/)

MIT licensed · no account · no credits · no quotas

</div>

---

## Why DrakoX

| | Claude Code | Codex | Antigravity | Cursor | Muse Code | **DrakoX** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Open source harness | ✗ | ✓ | ✗ | ✗ | ✗ | **✓ (MIT)** |
| Any model (local, free tiers, any API) | ✗ | partly | ✗ | partly | ✗ | **✓ 19 providers + any OpenAI-compatible API** |
| No vendor quotas / credits | ✗ weekly limits | ✗ | ✗ quota cuts | ✗ credits | ✗ | **✓ (unlimited with local models)** |
| Terminal **and** web UI | terminal | terminal + app | IDE | IDE | terminal only | **✓ both, same sessions** |
| Parallel agents + Agent Manager | sub-agents | cloud tasks | ✓ | ✓ | ✓ | **✓ Mission Control, worktrees, best-of-N** |
| Plan mode with approval | ✓ | – | ✓ | ✓ | – | **✓** |
| Approvals and OS sandbox as separate dials | partly | ✓ | partly | partly | ✓ | **✓ 4 modes × 3 sandbox levels** |
| Checkpoints + rewind (code and/or chat) | ✓ | – | – | ✓ | replay | **✓** |
| Replayable append-only event log | – | – | – | – | ✓ | **✓ (+ audit view & JSONL export)** |
| Background reviewer agent | – | /review | – | BugBot | ✓ | **✓ (opt-in) + /review** |
| MCP integrations + catalog + registry search | ✓ | ✓ | ✓ | ✓ | ✓ | **✓ 43-app catalog, live MCP Registry, import from 8 tools, OAuth** |
| Huge MCP servers without context blow-up | tool search | – | – | – | – | **✓ on-demand `tool_search`** |
| Editor with AI Tab completion | – | – | ✓ | ✓ | – | **✓ Monaco + Tab (works with local FIM models)** |
| Skills, hooks, custom commands, sub-agent profiles | ✓ | ✓ | partly | rules | AGENTS.md | **✓ (Claude/Codex skill-compatible)** |
| Reads AGENTS.md / CLAUDE.md / GEMINI.md / .cursorrules | own file | AGENTS.md (32 KiB cap) | GEMINI.md | rules | AGENTS.md | **✓ all of them, 64 KiB budget, overflow reported, never silent** |
| Windows / macOS / Linux | ✓ | ✓ | ✓ | ✓ | no Windows | **✓** |
| Trains on your code | opt-out | opt-out | ? | opt-out | cheap tier does | **never — nothing leaves your machine except model calls you choose** |

<sub>The comparison is based on public documentation and reviews as of October 2026. See [docs/research/feature-matrix.md](docs/research/feature-matrix.md) for sources and the seen / inferred / unknown labels.</sub>

## Quick start

> Requires **Node.js 20.18+** (22+ recommended) and git. ripgrep is optional but recommended.

```bash
git clone https://github.com/Dimova88/DrakoX.git
cd DrakoX
npm install
npm run build
npm link            # puts `drakox` on your PATH (or use: node dist/cli/index.js)

cd ~/your-project
drakox ui           # web app → opens http://127.0.0.1:4545 with a private token
drakox              # or the terminal agent
```

No model configured yet? DrakoX starts with an **offline demo model**, so you can explore the
whole UI immediately. Then connect a real model, as described in the next section.

## Free & unlimited, for real

DrakoX is MIT-licensed, needs no account, and imposes **no** quotas, credits or rate limits.

- **Truly unlimited and private:** run a local model. Nothing leaves your machine.
  ```bash
  # https://ollama.com
  ollama pull qwen3-coder:30b        # or gpt-oss:20b / qwen2.5-coder:7b on smaller machines
  drakox -m ollama/qwen3-coder:30b
  ```
  LM Studio, llama.cpp (`llama-server`) and vLLM are detected automatically too.
- **Free cloud tiers:** Google Gemini, Groq, OpenRouter `:free` models, Cerebras, GitHub Models
  and Mistral. Run `drakox setup` or click **Connect a model** in the web app, then paste a free key.
- **Bring your own key:** Anthropic, OpenAI, DeepSeek, xAI, Moonshot (Kimi), Z.ai (GLM), Together,
  Fireworks, or any OpenAI-compatible endpoint. You pay the provider directly, at cost. DrakoX shows
  real token counts and dollars instead of opaque credits.

DrakoX never bypasses provider subscriptions or terms of service. "Unlimited" means the harness
adds no limits; providers' own limits still apply to their services.

## The web app

`drakox ui` opens a local web app (React 19, Tailwind 4, Monaco). It shares sessions with the terminal.

- **Mission Control:** launch agents from one prompt and watch them all work in a live grid. A
  **cross-agent approvals inbox** lets you approve or deny any agent's request from one place. Each agent
  can run in your working tree, in an **isolated git worktree**, or as a **best-of-N** race (2–4
  parallel attempts; pick the winner with one click).
- **Agent view:** streaming chat with rich cards for tools, diffs, terminal output, sub-agents,
  approvals (with full diffs), plans (approve → auto-edit / ask / autopilot) and questions. It also has a
  live task list, a context meter, the cost, **rewind to any checkpoint** (code, chat or both),
  per-file revert, and a worktree apply/commit action.
- **Composer:** `@` file mentions with fuzzy search, `/` commands, image paste and drag-and-drop, voice
  dictation, and mode and model pickers. **Shift+Tab** cycles modes and **Esc** stops the agent.
- **Editor:** a Monaco editor with a file explorer, **AI Tab completion** (ghost text, any provider,
  including local FIM models), **Ctrl/Cmd+K "edit with DrakoX"**, diff vs HEAD, and a built-in terminal runner.
- **Integrations:** a catalog of 43 apps, live **MCP Registry** search, a custom server form, JSON paste
  (Claude, Cursor, VS Code and Codex formats), one-click import, OAuth sign-in, per-server tools and
  toggles.
- **Skills & agents:** browse, create and edit skills; sub-agent profiles; custom commands.
- **Settings:** connect providers (local detection, free tiers, keys, custom endpoints), the default
  model, modes, the sandbox, allow/ask/deny rules, the background reviewer, a session budget, web
  search and the theme.
- **Event log:** the append-only audit trail of everything an agent did, with JSONL export.
- **Command palette** (Ctrl/Cmd+K), first-run onboarding, and light and dark themes.

Security: the server binds to `127.0.0.1` and requires a one-time token, which it exchanges for an
HttpOnly SameSite cookie. It also checks the Host header (DNS-rebinding protection) and requires a
CSRF header on every mutation. File APIs are confined to the workspace.

## The terminal

```text
$ drakox
  ____            _          __  __
 |  _ \ _ __ __ _| | _____   \ \/ /      model    ollama/qwen3-coder:30b
 | | | | '__/ _` | |/ / _ \   \  /       mode     ◆ ask · asks before edits & risky commands
 | |_| | | | (_| |   < (_) |  /  \       sandbox  workspace-write · bubblewrap
 |____/|_|  \__,_|_|\_\___/  /_/\_\

◆ ask ❯ add rate limiting to the login endpoint
● I'll look at how auth is wired first.
  ◇ Grep "login" in src
  ✎ Edit src/routes/auth.ts
╭─ Permission · edit_file ──────────────────────────────────────╮
│ Edit src/routes/auth.ts                                       │
│ @@ -12,6 +12,9 @@                                             │
│ +import { rateLimit } from '../middleware/rate-limit.js';     │
│ y allow once   a always (edit)   n deny   f deny + tell why    │
╰───────────────────────────────────────────────────────────────╯
```

- `shift+tab` cycles plan → ask → auto-edit → autopilot; `esc` interrupts; press Enter while the agent
  is working to queue your next message.
- `@path` attaches files, folders or images; `!cmd` runs a shell command and shares its output with DrakoX.
- Slash commands: `/plan`, `/review [base]`, `/init`, `/model`, `/models`, `/mode`, `/compact`, `/undo`,
  `/rewind`, `/diff`, `/cost`, `/status`, `/mcp`, `/skills`, `/agents`, `/permissions`, `/resume`,
  `/trust`, plus your custom commands, skills and MCP prompts.

```bash
drakox exec "fix the failing test" --json      # headless / CI (JSONL events); risky actions are denied unless --yolo
drakox review main                              # code review of your branch
drakox resume | drakox -c                       # resume a session (replayed exactly from its event log)
drakox doctor                                   # environment check
```

## Integrations: connect any app

Every integration is a **Model Context Protocol** server, so DrakoX works with thousands of apps
and with anything you build yourself.

```bash
drakox mcp catalog                                   # 43 curated apps: GitHub, Linear, Notion, Slack, Figma, Stripe, Postgres, Playwright…
drakox mcp install github                            # prompts for the token, stores it in ~/.drakox/credentials.json (0600)
drakox mcp add linear https://mcp.linear.app/mcp     # remote server…
drakox mcp login linear                              # …with browser OAuth sign-in
drakox mcp add rea -- npx -y rea-agents mcp          # any local command
drakox mcp search postgres                           # the official MCP Registry
drakox mcp add-registry io.github.morluto/rea        # install straight from the registry
drakox mcp import                                    # from Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Codex, Gemini CLI, opencode
```

- **Secrets never live in config files.** Literal tokens are moved to the credentials file and
  referenced as `${secret:KEY}`.
- **Huge servers stay cheap.** When integrations expose many tools (REA exposes 200+, roughly 190k tokens of
  schemas), DrakoX loads them on demand through `tool_search`.
- **Prompt-injection hardening.** Integration and web output is wrapped as untrusted content.
  Project-defined servers and hooks don't run until you trust the folder.
- **Build your own:** the bundled `/mcp-builder` skill walks you (or the agent) through creating an MCP
  server for any internal API.

### REA, Reverse Engineer Anything

DrakoX was designed with the [REA](https://github.com/morluto/rea) methodology, applied to the public
documentation and observable behaviour of the tools it learns from. REA is also built in for your own work:

- `drakox mcp install rea` adds REA's MCP server (207 tools for binaries, apps, JavaScript bundles,
  runtime capture and evidence).
- `/reverse-engineer <question>` follows REA's five-stage workflow and labels findings **seen / inferred / unknown**.
- the `reverse-engineer` sub-agent profile can use REA's tools autonomously.

## Safety model

DrakoX has two independent dials, like Codex:

| Mode (approvals) | What it may do without asking |
|---|---|
| **plan** | read and research only, then propose a plan for your approval |
| **ask** (default) | read; edits and risky commands ask |
| **auto-edit** | edit files in the workspace; risky commands ask |
| **autopilot** | everything except hard-blocked actions (e.g. `rm -rf /`, writing outside the workspace) |

| Sandbox (OS-level) | |
|---|---|
| **read-only** / **workspace-write** (default) / **full-access** | enforced with Seatbelt (macOS) or bubblewrap (Linux) when available; **fails closed**, so without a sandbox, risky commands always ask |

There are also `allow` / `ask` / `deny` rules (`bash(npm test*)`, `edit_file(src/**)`,
`web_fetch(domain:github.com)`, `mcp__github__*`), where deny always wins. Sensitive files (`.env`, keys)
always ask, and every edit is checkpointed with one-click rewind. Hooks (`PreToolUse`, `PostToolUse`,
`UserPromptSubmit`, `Stop`, …) let you run formatters, linters or policy checks.

## Configuration

Config layers, merged in order: `~/.drakox/config.json` → `.mcp.json` → `.drakox/settings.json`
(shared) → `.drakox/settings.local.json` (personal, git-ignored) → CLI flags.

```jsonc
// ~/.drakox/config.json
{
  "model": "ollama/qwen3-coder:30b",
  "models": { "fast": "groq/llama-3.3-70b-versatile", "autocomplete": "ollama/qwen2.5-coder:1.5b" },
  "mode": "ask",
  "sandbox": "workspace-write",
  "permissions": { "allow": ["bash(npm test*)", "bash(npm run lint*)"], "deny": ["bash(git push --force*)"] },
  "autoReview": true,
  "budget": { "sessionUsd": 2 },
  "providers": { "mycorp": { "type": "openai", "baseURL": "https://llm.mycorp.internal/v1" } }
}
```

See [docs/configuration.md](docs/configuration.md) for every option.

## SDK

```ts
import { Runtime, Agent } from 'drakox';

const runtime = await Runtime.create({ cwd: process.cwd() });
const agent = await Agent.create({ runtime, model: 'ollama/qwen3-coder:30b', mode: 'auto-edit', interactive: false });
agent.on('event', (e) => e.type === 'text_delta' && process.stdout.write(e.delta));
await agent.send('Add input validation to src/api/users.ts and run the tests');
```

## Architecture

```
src/core/      agent loop, providers, tools, permissions, sandbox, sessions (event log), MCP, skills, hooks
src/cli/       terminal REPL, exec mode, subcommands
src/server/    local HTTP + WebSocket API for the web app
web/           React app (Mission Control, agent view, editor, integrations, settings)
skills/        bundled skills (reverse-engineer, code-review, debugging, test-writing, mcp-builder, …)
agents/        bundled sub-agent profiles (explorer, reviewer, tester, reverse-engineer)
```

More in [docs/architecture.md](docs/architecture.md).

## Development

```bash
npm install
npm run dev            # terminal agent from source (tsx)
npm run dev:ui         # API server on :4545 …
npm run dev:web        # …and the Vite dev server on :5173 with hot reload
npm test               # vitest
npm run typecheck
npm run build
```

## Clean-room statement & credits

DrakoX is an independent implementation. Its design was derived from public documentation, release
notes, reviews and observable behaviour, following REA's rule to *study behaviour and rebuild
independently, never copy code or assets*. It contains no proprietary code from the tools it compares itself to.

Built on great open source: [REA](https://github.com/morluto/rea),
[Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk),
[React](https://react.dev), [Vite](https://vite.dev), [Tailwind CSS](https://tailwindcss.com),
[Monaco Editor](https://github.com/microsoft/monaco-editor), [cmdk](https://github.com/pacocoursey/cmdk),
[sonner](https://github.com/emilkowalski/sonner), [zustand](https://github.com/pmndrs/zustand),
[lucide](https://lucide.dev), [react-markdown](https://github.com/remarkjs/react-markdown),
[highlight.js](https://highlightjs.org), [jsdiff](https://github.com/kpdecker/jsdiff), [ws](https://github.com/websockets/ws),
[Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/).

## License

[MIT](LICENSE)
