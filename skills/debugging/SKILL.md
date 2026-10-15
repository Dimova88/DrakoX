---
name: debugging
description: Systematic debugging of failures, crashes, flaky tests, wrong output or performance problems. Use when something is broken and the cause is not obvious.
---

# Systematic debugging

1. **Reproduce** — get a reliable, minimal reproduction (a failing test or a command).
   Capture the exact error, stack trace, inputs and environment. No repro → gather logs first.
2. **Locate** — follow the stack trace / data flow to the narrowest suspicious region.
   Use `grep` for the error message, add temporary logging, or bisect (`git bisect`) for regressions.
3. **Hypothesise** — write down 2–3 concrete hypotheses ranked by likelihood and cost to test.
4. **Test one hypothesis at a time** — change one thing, re-run the repro, observe.
5. **Fix the root cause**, not the symptom. Prefer the smallest correct change.
6. **Prove it** — the repro now passes; add a regression test; run the related test suite.
7. **Clean up** — remove temporary logging; explain the cause and the fix in 2–3 sentences.

Tips: check recent changes (`git log -p -n 5 -- <file>`), environment differences,
off-by-one/timezone/encoding issues, async ordering, caching, and stale build artifacts.
For flaky tests, run them in a loop and look for shared state or timing assumptions.
