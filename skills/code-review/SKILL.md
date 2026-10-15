---
name: code-review
description: Thorough code review of a diff, branch or set of files — correctness, security, performance, tests, maintainability. Use when the user asks to review changes or a PR, or before committing important work.
---

# Code review

## Process
1. Get the change: `git diff` (unstaged), `git diff --cached`, or `git diff <base>...HEAD`.
   List untracked files too (`git status --porcelain`).
2. Understand intent first: read the PR description / commit messages / related issue.
3. Read every changed hunk **and enough surrounding code** to judge it. Follow calls into
   unchanged code when behaviour depends on it.
4. Run the tests / type checker / linter if available and cheap.

## What to look for (in priority order)
- **Correctness**: logic errors, off-by-one, null/undefined, wrong conditions, unhandled
  promise rejections, race conditions, incorrect error handling, broken edge cases.
- **Security**: injection (SQL, shell, path traversal, XSS), authz/authn gaps, secrets in
  code or logs, unsafe deserialisation, SSRF, overly broad permissions.
- **Data safety**: migrations, destructive operations, backwards compatibility.
- **Performance**: N+1 queries, unbounded loops/memory, blocking I/O on hot paths.
- **Tests**: are the important paths covered? Do tests assert behaviour, not implementation?
- **API & maintainability**: breaking changes, naming, dead code, duplicated logic.

## Output
For each finding: **severity** (critical / major / minor / nit), `file:line`, the problem,
why it matters, and a concrete fix (code if short). Group by severity. Finish with a verdict
(approve / approve with nits / request changes) and missing tests. Don't pad with praise;
if it's good, say so in one line.
