// Single source of truth for the heavy REAL-FIDELITY integration specs that were
// relocated OUT of the fast `unit` gate and into the e2e tier (team/child
// lifecycle, worktree continue/multi-repo, gateway restart, real git flows).
//
// Consumed by:
//   - vitest.config.ts  → excludes these from the `v2-integration` (unit) project
//     and serves them from the dedicated `v2-integration-e2e` project.
//   - scripts/testing-v2/run-e2e-v2.mjs → Group I runs them in the e2e stage and
//     reports a numeric count.
//
// This list is intentionally identical to the merge-base inventory. Performance
// work must not add files here: optimize unit setup/fixtures instead of changing
// the tier that owns an existing test.
export const integrationE2eFiles = [
	"tests2/integration/team-lead-child-authz.test.ts",
	"tests2/integration/orchestrate-restart.test.ts",
	"tests2/integration/continue-archived.test.ts",
	"tests2/integration/continue-archived-assistant.test.ts",
	"tests2/integration/multi-repo-flow-api.test.ts",
	"tests2/integration/steer-gateway-restart.test.ts",
	"tests2/integration/team-wait-semantics.test.ts",
	"tests2/integration/team-delegate.test.ts",
	"tests2/integration/team-dismiss-structured-regression.test.ts",
	"tests2/integration/project-isolation.test.ts",
	"tests2/integration/commit-file-diffs-api.test.ts",
	"tests2/integration/sidebar-actions-fork-github-link.test.ts",
];
