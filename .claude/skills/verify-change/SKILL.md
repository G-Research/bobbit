---
name: verify-change
description: Verify a diff cheaply and correctly before opening a PR — typecheck + LSP diagnostics + affected tests. Use after implementing a fix, before committing.
---

# /verify-change

Prove the change works; don't just trust it.

1. **Typecheck:** `npm run check` (tsc server + web, no emit). Must be clean.
2. **LSP diagnostics** on each edited file (faster than a full build for a spot-check) via the `LSP` tool.
3. **Affected tests** for the changed area:
   - Until `TEST-01` lands, `run-unit.mjs` ignores argv — run the relevant phase: `npm run test:unit` (UI/logic + file:// browser fixtures), and for server changes `npm run test:e2e`. For one node test: `node --test tests/<file>.test.ts`.
   - **Server changes require `npm run restart-server`** before e2e (sessions survive restart).
4. **User-facing change → a browser E2E** covering navigation / happy path / persistence across reload / cleanup (pattern: `tests/e2e/ui/settings.spec.ts`). This is a hard rule (AGENTS.md).
5. **No flaky tests.** A flake is a real bug — frequently the snapshot↔live raciness root cause (`~/Documents/dev/bobbit-fable-refactor/design/raciness-and-testing-rethink.md`). **Do not mask with retries.**

Report: typecheck result, LSP diagnostics, tests run + pass/fail, and whether a browser E2E was added.
