# Configuration

Layers (later wins): built-in defaults → `~/.drakox/config.json` (user) → `.mcp.json` →
`.drakox/settings.json` (project, shared) → `.drakox/settings.local.json` (project, personal) →
command-line flags. Permission lists **accumulate** across layers. `DRAKOX_HOME` moves `~/.drakox`.

| Key | Type | Default | Description |
|---|---|---|---|
| `model` | `provider/model` | auto-detected | Default model. Detection order: provider keys in env → Ollama → LM Studio → offline demo |
| `models.fast` | ref | – | Model for sub-agents |
| `models.review` | ref | – | Model for `/review` and the background reviewer |
| `models.autocomplete` | ref | default model | Editor Tab completion (FIM models like `ollama/qwen2.5-coder:1.5b` are ideal) |
| `models.compact` | ref | default model | Conversation summaries |
| `mode` | `plan \| ask \| auto-edit \| autopilot` | `ask` | Approval mode |
| `sandbox` | `read-only \| workspace-write \| full-access` | `workspace-write` | OS sandbox level |
| `permissions.allow / ask / deny` | rules | `[]` | e.g. `bash(npm test*)`, `edit_file(src/**)`, `web_fetch(domain:x.com)`, `mcp__srv__*` |
| `permissions.sensitivePaths` | globs | `.env`, keys… | Always ask before reading/writing |
| `permissions.sandboxNetwork` | bool | `false` | Network inside the sandbox |
| `providers.<id>` | object | presets | `{ type: "openai" \| "anthropic" \| "ollama", baseURL, apiKey, models, headers, enabled }` |
| `mcpServers.<name>` | object | – | `{ command, args, env, cwd }` or `{ url, headers, oauth }`, plus `disabled`, `autoApprove`, `timeoutMs` |
| `mcpToolSearch` | `auto \| on \| off` | `auto` | Defer large integration tool sets behind `tool_search` |
| `hooks.<Event>` | list | – | `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `Notification`: `{ matcher, command, timeoutMs }` |
| `instructions.maxBytes` | number | 65536 | Budget for AGENTS.md & friends (overflow is reported) |
| `instructions.extraFiles` | paths | – | Always include these files |
| `instructions.disableCompat` | bool | `false` | Ignore CLAUDE.md / GEMINI.md / .cursorrules / copilot instructions |
| `webSearch` | object | – | `{ provider: "brave" \| "tavily" \| "exa" \| "searxng", baseURL }` (key in credentials) |
| `budget.sessionUsd` | number | – | Stop a session above this estimated cost |
| `maxTurns` | number | 60 | Model round-trips per message |
| `autoReview` | bool | `false` | Background reviewer after edits |
| `autoCompact` / `compactThreshold` | bool / 0–1 | `true` / `0.8` | Automatic context compaction |
| `pricing` / `contextWindows` | maps | built-in table | Override per model |
| `shell` | path | `$SHELL` / bash | Shell for the bash tool |
| `reasoningEffort` | `low \| medium \| high` | – | For reasoning models |
| `gitTrailers` | bool | `false` | DrakoX never adds hidden git metadata unless enabled |

## Files DrakoX reads

- Instructions: `AGENTS.md`, `DRAKOX.md`, `CLAUDE.md`, `CLAUDE.local.md`, `GEMINI.md` (root and
  directories up to the working directory), `.cursorrules`, `.windsurfrules`, `.clinerules`,
  `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`, and `~/.drakox/AGENTS.md`.
- Skills: `.drakox/skills`, `.agents/skills`, `.claude/skills`, `~/.drakox/skills`, `~/.agents/skills`, `~/.claude/skills`.
- Sub-agents: `.drakox/agents`, `.claude/agents`, `~/.drakox/agents`, `~/.claude/agents`.
- Custom commands: `.drakox/commands`, `.claude/commands`, `~/.drakox/commands` (markdown with `$ARGUMENTS`).

## Environment variables

`DRAKOX_HOME`, `DRAKOX_PORT`, `DRAKOX_HOST`, `DRAKOX_TOKEN`, provider keys (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`,
`MISTRAL_API_KEY`, `XAI_API_KEY`, `CEREBRAS_API_KEY`, `GITHUB_TOKEN`, …), `OLLAMA_HOST`, `NO_COLOR`.
