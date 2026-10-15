---
name: test-writing
description: Write effective automated tests (unit, integration, e2e) that match the project's existing framework and conventions. Use when adding features, fixing bugs, or when asked to improve coverage.
---

# Writing tests

1. Detect the framework and conventions: look at existing tests, `package.json` scripts,
   `pytest.ini`/`pyproject.toml`, `go test`, `cargo test`, CI config. Mirror file naming,
   location, helpers and style exactly.
2. Decide what matters: public behaviour, edge cases (empty, null, large, unicode, errors),
   regressions for fixed bugs. Avoid testing private implementation details.
3. Arrange–Act–Assert, one behaviour per test, descriptive names
   ("returns 404 when the user does not exist").
4. Keep tests deterministic: fake time, seed randomness, no real network; use temporary
   directories for filesystem tests.
5. Run the new tests **and** the surrounding suite. A test you have not seen fail may be
   asserting nothing — for bug fixes, confirm the test fails without the fix.
6. Report what is covered and what is intentionally not.
