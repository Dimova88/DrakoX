---
name: git-workflow
description: Clean git hygiene — focused commits with good messages, branches, and pull request descriptions. Use when the user asks to commit, open a PR, or tidy history.
---

# Git workflow

- Check state first: `git status`, `git diff`, current branch. Never commit secrets, build
  output or unrelated changes — stage files explicitly.
- Commits: one logical change each. Message: imperative summary ≤ 72 chars, blank line,
  body explaining *why* (wrap at 72). Follow the repo's convention (e.g. Conventional Commits)
  if it uses one (`git log --oneline -20`).
- DrakoX never adds hidden trailers or attribution lines unless the user's config asks for it.
- Branches: `feature/<short-name>`, `fix/<issue>`; rebase on the base branch before a PR if
  the project prefers linear history.
- Pull requests: title like a commit summary; body with **What**, **Why**, **How tested**,
  and screenshots for UI. Link issues.
- Never force-push shared branches or rewrite published history without explicit permission.
