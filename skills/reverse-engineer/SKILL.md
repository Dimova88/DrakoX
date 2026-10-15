---
name: reverse-engineer
description: Understand how an existing system works (a codebase, binary, app, API, protocol or product behaviour) using the REA methodology — evidence first, findings labelled seen / inferred / unknown. Use for "how does X work", undocumented code, legacy systems, black-box behaviour, or before rebuilding a feature.
---

# Reverse engineering (REA methodology)

Based on the open-source **REA — Reverse Engineer Anything** workflow (github.com/morluto/rea).
If the `rea` integration is connected (tools named `mcp__rea__*`), prefer its tools for
binaries, packaged apps, runtime capture and evidence storage. For ordinary source
repositories, normal repo tools (grep, glob, read_file, bash) are the right instruments.

## Ground rules
- **Lawful use only.** Analyse things the user owns or is authorised to study. Never help
  bypass licensing, DRM, paywalls, authentication or provider usage policies.
- **Study behaviour, don't copy.** When the goal is to rebuild something, describe the
  behaviour and design an independent implementation — never paste proprietary code or assets.
- **One feature at a time.** Narrow the question before collecting evidence.

## Five-stage workflow
1. **Frame** — restate the exact question, the target, and what "understood" means
   (e.g. "trace how a login request is authenticated end-to-end").
2. **Collect evidence** — entry points, configs, call sites, logs, network traces, strings,
   test fixtures, docs, git history. Record where each piece came from (file:line, command).
3. **Compress** — summarise raw evidence into a short structured brief before reasoning
   further. Large raw dumps hurt accuracy; keep only what supports a claim.
4. **Model** — build the mental model: components, data flow, state, invariants, edge cases.
   Draw it as a list or a mermaid diagram.
5. **Verify** — test each important claim (run the code, write a probe test, replay a request).
   Rebuild + test is a single step: if you re-implement, prove equivalence with tests.

## Report format
Label every finding:
- **Seen** — directly observed in code/output (cite `file:line` or the command).
- **Inferred** — follows from evidence but not directly observed (say why).
- **Unknown** — not determined yet (say how to find out).

End with: open questions, risks, and the smallest next experiment that would reduce
the biggest unknown.
