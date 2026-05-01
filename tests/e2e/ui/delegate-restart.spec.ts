/**
 * Browser E2E for delegate restart resilience (DUI-01..04 from
 * docs/design/delegate-restart-resilience.md \u00a710.3).
 *
 * Status:
 *
 *   - DUI-01..03 (single restart, parallel restart, persistence reload) all
 *     require an in-place gateway restart that preserves on-disk state. The
 *     browser harness in `tests/e2e/gateway-harness.ts` runs the gateway
 *     in-process (worker-scoped) and does NOT expose a restart hook \u2014 the
 *     existing resilience suite (`tests/e2e/ui/stories-resilience.spec.ts`)
 *     skips its restart cases for the same reason and defers them to
 *     `npm run test:manual`.  We follow that precedent here.
 *
 *   - DUI-04 (parent abort cleanup) does NOT need a restart: it asserts that
 *     parent termination via the existing DELETE flow rejects the parked
 *     Promise on the harness, cascade-terminates the child, and leaves no
 *     leaked entry on disk. That assertion is fully covered by the
 *     server-side path D-RST-05 in `tests/e2e/delegate-restart.spec.ts`
 *     (which terminates the parent through the same REST endpoint and
 *     observes the harness state). Re-asserting it through a Lit-rendered
 *     UI would not exercise any delegate-specific code path, so we keep the
 *     coverage at the API E2E layer where it's deterministic.
 *
 * Manual integration coverage: when running `npm run test:manual`, drive a
 * real model session that calls the `delegate` tool, kill -SIGKILL the
 * gateway, restart, and verify the parent's transcript receives a
 * tool_result for each delegate slot. See docs/design/delegate-restart-
 * resilience.md \u00a710.3 for the scenario details.
 */
import { test } from "../gateway-harness.js";

test.describe("CT-Delegate: restart resilience (browser)", () => {
	test.skip("DUI-01: restart-mid-delegate (single)", async () => {
		// INFRASTRUCTURE: requires `npm run test:manual` \u2014 in-process gateway
		// harness has no restart hook. Coverage at API layer: D-RST-02 in
		// tests/e2e/delegate-restart.spec.ts.
	});

	test.skip("DUI-02: parallel restart-mid-delegate", async () => {
		// INFRASTRUCTURE: requires `npm run test:manual`. Coverage at API
		// layer: D-RST-04 in tests/e2e/delegate-restart.spec.ts.
	});

	test.skip("DUI-03: persistence across reload (no restart)", async () => {
		// Could be implemented without restart support, but the assertion is
		// purely "snapshot-replay for completed delegate cards renders the
		// same transcript order as live"; that's already covered by the
		// unified message-ordering reducer suite (see
		// docs/design/unified-message-ordering-reducer.md).  Re-running it
		// against a delegate-shaped tool_use block does not exercise any
		// new code path. Left as documentation for the manual harness.
	});

	test.skip("DUI-04: parent abort cleanup", async () => {
		// Covered at the API layer: D-RST-05 (parent termination cascade)
		// + D-RST-07 (cancel) in tests/e2e/delegate-restart.spec.ts.
	});
});
