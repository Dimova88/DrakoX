# Feature research: what DrakoX learned from five agent harnesses

This analysis followed the **REA (Reverse Engineer Anything)** methodology: frame one question per
product, collect public evidence, compress it, model the behaviour, and keep observation separate
from design decisions. It covers **only** public documentation, release notes, reviews and press
coverage (October 2026). No proprietary code was decompiled or copied.

Labels: **Seen** = stated in public docs/coverage · **Inferred** = reasoned from public evidence ·
**Unknown** = not determinable from public sources.

## Claude Code (Anthropic)

| Finding | Label | DrakoX response |
|---|---|---|
| Terminal agent with skills (SKILL.md folders), hooks, sub-agents, plugins, slash commands, checkpoints/rewind | Seen | Adopted: compatible skill format, hooks, sub-agent profiles (`.claude/agents` also read), checkpoints with code/chat rewind |
| Plan mode; "always allow" persisted per project | Seen | Adopted: plan mode with approve → auto-edit/ask/autopilot; rules persisted to `.drakox/settings.local.json` |
| Closed source; Anthropic models only | Seen | Fixed: MIT, 19 provider presets + any OpenAI-compatible endpoint |
| Weekly usage limits on subscription plans | Seen | Fixed: no harness limits; local models are unlimited |
| On-demand MCP tool loading for large tool sets | Seen | Adopted: `tool_search` deferral (auto above 40 tools / ~60k chars) |

## OpenAI Codex CLI

| Finding | Label | DrakoX response |
|---|---|---|
| Approval policy and OS sandbox are separate settings (Seatbelt / Landlock-style) | Seen | Adopted: 4 modes × 3 sandbox levels; Seatbelt / bubblewrap; fail-closed |
| AGENTS.md layering; `apply_patch` edit format; `/review`; `exec` headless mode; `resume` | Seen | Adopted all, Codex patch format supported verbatim |
| AGENTS.md content beyond 32 KiB is silently truncated by default | Seen | Fixed: 64 KiB default budget, overflow reported in `/status` and the UI — never silent |
| OpenAI-centric defaults | Seen | Fixed: provider-neutral; auto-detects keys, Ollama, LM Studio |

## Google Antigravity

| Finding | Label | DrakoX response |
|---|---|---|
| Agent Manager view for many parallel agents; artifacts (plans, walkthroughs) | Seen | Adopted: Mission Control grid + cross-agent approvals inbox; plan/review artifacts |
| Browser sub-agent; Allow/Ask/Deny terminal permissions | Seen | Adopted: rule engine with allow/ask/deny; browser via Playwright/Chrome DevTools MCP integrations |
| Several quota reductions (Dec 2025 – Mar 2026) with multi-day lockouts; opaque credits | Seen | Fixed: no quotas; real token counts and dollars |
| Published prompt-injection / data-exfiltration / code-execution findings, incl. trusted-workspace issues | Seen | Mitigated: untrusted-content wrapping for tool/web/MCP output, workspace trust gate for project hooks & MCP servers, sensitive-path approvals, catastrophic-command blocklist |
| Exact internal sandbox design | Unknown | — |

## Cursor

| Finding | Label | DrakoX response |
|---|---|---|
| Tab completion; Plan mode; parallel agents in worktrees; best-of-N model races; BugBot review | Seen | Adopted: Monaco Tab completion (any provider, local FIM), worktree agents, best-of-N with one-click "pick this one", background reviewer + `/review` |
| Credit-based pricing that users report burning quickly | Seen | Fixed: no credits; local models cost $0 |
| Hidden/automatic git trailers in some versions | Seen (user reports) | Fixed: DrakoX never injects hidden git metadata (`gitTrailers` is opt-in) |
| Proprietary editor | Seen | Fixed: open web app + any editor via files |

## Meta Muse Code

| Finding | Label | DrakoX response |
|---|---|---|
| Launched Aug 2026 (beta) on Muse Spark; terminal only; macOS/Linux only | Seen | Fixed: terminal + web app; Windows supported (sandbox falls back to approvals) |
| Multi-agent by default: parallel workers + background reviewer agents | Seen | Adopted: sub-agents (`task`), parallel tool batches, opt-in background reviewer |
| Append-only, replayable event log; crash-safe exact resume | Seen | Adopted: `events.jsonl` per session, replay rebuilds the exact transcript incl. compaction & rewind; audit view + JSONL export |
| Sub-agents in isolated git worktrees; OS sandbox that fails closed | Seen | Adopted |
| Meta model lock-in; cheaper tier trains on user code | Seen | Fixed: any model; DrakoX sends nothing anywhere except the model calls you configure |
| Internal scheduling of background agents | Inferred (event-driven workers) | DrakoX runs reviewers after turns that changed files |

## Design decisions (not observations)

- One npm package (`drakox`) containing core, CLI, server and the prebuilt web app.
- Own provider adapters (OpenAI-compatible, Anthropic, Ollama) instead of a framework, to keep
  streaming, tool-calling and reasoning metadata under control.
- The web app talks to the same `Agent` objects as the terminal; sessions are interchangeable.
- Everything is local-first: config, credentials (0600), sessions and worktrees live in `~/.drakox`.
