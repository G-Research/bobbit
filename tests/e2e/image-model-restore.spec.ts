/**
 * API E2E: round-trip restoreSession() preserves image-tool activation.
 *
 * Phase 2 plan:
 *   1. Create a session via POST /api/sessions (mock agent).
 *   2. Send a prompt to start the session, then archive it.
 *   3. POST /api/sessions/:archivedId/continue (or restore) and assert the
 *      spawned agent's CLI args still include the `images/extension.ts`
 *      `--extension` so generate_image is wired up after restore.
 *
 * Phase 1: scaffold only. The exact restore endpoint shape and how to
 * introspect the resumed CLI args from the in-process harness will be wired
 * up after Agent A/B merge.
 */
import { test, expect } from "./in-process-harness.js";
import { readE2EToken, base } from "./e2e-setup.js";

const headers = () => ({
	Authorization: `Bearer ${readE2EToken()}`,
	"Content-Type": "application/json",
});

async function api(path: string, opts?: RequestInit): Promise<Response> {
	return fetch(`${base()}${path}`, { ...opts, headers: { ...headers(), ...(opts?.headers || {}) } });
}

test.describe("session restore: image tools survive archive→restore", () => {
	test.skip("create → archive → restore: CLI args include images/extension.ts", async () => {
		// TODO Phase 2: drive the lifecycle and assert via sessionManager
		// exposure on GatewayInfo (gateway-harness exposes `sessionManager`).
		const _ = api;
		expect(true).toBe(true);
	});
});
