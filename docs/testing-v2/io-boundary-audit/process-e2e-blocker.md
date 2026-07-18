# Verification process E2E blocker

Date: 2026-07-15

## Decision

Do not add verification-command coverage to `tests2/integration/orchestrate-restart.test.ts`.

That file owns OrchestrationCore delegate-child recovery: rebuilding parent/child links, restoring delegate sessions, sending collection reminders, re-collecting through `team_wait`, and reaping orphaned session children. It does not create workflows or goals, signal gates, call the verification harness, or inspect verification command state. Adding a gate command merely because this file is in the excluded E2E list would be unrelated coverage and violate the ownership rule.

Its restart primitive is also insufficient for verification-command restart proof. The tests call `SessionManager.restoreSessions()` or OrchestrationCore boot helpers on the existing in-process gateway. Production verification recovery requires a newly constructed `VerificationHarness` to load `active-verifications.json`, followed by the server boot hook `resumeInterruptedVerifications()`. The file's existing primitive neither reconstructs that harness nor drives that hook, so it cannot honestly prove durable command adoption or restart cleanup.

## Evidence reviewed

- Merge-base `scripts/testing-v2/integration-e2e-files.mjs`: none of the twelve files then excluded from unit owned verification commands; `orchestrate-restart.test.ts` covered team/child lifecycle and restart relinking. All twelve are now restored to the unit gate.
- `tests2/integration/orchestrate-restart.test.ts`: all cases concern agent-session children and OrchestrationCore/SessionManager state; there is no verification fixture or API journey.
- `tests2/integration/verification-core.test.ts`: naturally owns real verification command spawn and stdout/stderr/event observation, but is not an excluded E2E file.
- `tests2/integration/cancel-verification.test.ts`: naturally owns the cancellation API, but its configured Vitest project injects the fake command-step runner.
- `tests/e2e/verification-timeout.spec.ts`: already expresses real timeout/cancellation tree-liveness assertions, but `tests2/tests-map.json` classifies it as replaced by core coverage rather than migrated eligible E2E evidence.

## Required natural owner

Close the gap in a dedicated excluded verification-process E2E (or by explicitly migrating the legacy verification timeout E2E into such an owner). The test should drive only public gateway APIs and production dependencies, then:

1. signal a command step that prints distinct stdout and stderr markers plus its PID (and preferably a descendant PID);
2. observe the running step and both output streams through the active-verification/inspect surface;
3. observe the real exit result, or restart/cancel through a harness that reconstructs the gateway and verification harness;
4. poll OS liveness for every reported PID and assert no process survives; and
5. assert the final verification state and durable output after cleanup.

Creating that owner requires changing the E2E inventory or a different test file, both outside this task's allowed edit surface. `tests2/integration/orchestrate-restart.test.ts` is intentionally unchanged.
