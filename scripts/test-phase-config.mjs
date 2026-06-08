/**
 * Single source of truth for the unit-phase node-runner globs.
 *
 * Consumed by BOTH:
 *   - scripts/run-unit.mjs            — the actual unit runner (gate `unit:`)
 *   - tests/test-phase-invariant.test.ts — the guard that pins the invariant
 *
 * Keeping the globs here (rather than duplicated in the runner script and the
 * guard) means the guard can never silently drift from what the runner runs:
 * if you add a new node-test directory, you change this list once and both the
 * runner and the guard's "unit node" bucket update together.
 *
 * Globs are repo-root-relative and are passed VERBATIM to node's test runner
 * (which expands them itself). They must never be expanded by the shell — on
 * Windows the top-level `tests/*.test.ts` glob alone expands to 340+ paths and
 * blows the ~32k command-line limit (see docs/testing-strategy.md).
 */
export const NODE_UNIT_GLOBS = ["tests/*.test.ts", "tests/contract/*.test.ts"];
