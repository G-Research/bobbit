/**
 * Negative test for the gateway-fixture leak detector.
 *
 * Proves the detector actually catches a leak: we deliberately create a session
 * WITHOUT tracking it in a scope, snapshot entity counts before/after, and
 * assert that assertNoLeaks() throws. The file itself stays clean by purging the
 * leaked session in afterEach, so this test does not poison the shared fork.
 *
 * It also asserts the happy path: a scope that creates and cleans up a session
 * returns entity counts to baseline and assertNoLeaks() does NOT throw.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";
import { createScope } from "../harness/scope.js";

let gw: GatewayFixture;
const leakedSessionIds: string[] = [];

beforeAll(async () => {
	gw = await getGateway();
});

afterEach(async () => {
	// Purge any deliberately-leaked sessions so this file leaves no residue.
	for (const id of leakedSessionIds.splice(0)) {
		const resp = await gw.api(`/api/sessions/${id}?purge=true`, { method: "DELETE" });
		if (!resp.ok && resp.status !== 404) throw new Error(`cleanup failed: ${resp.status}`);
	}
});

describe("gateway fixture leak detector", () => {
	it("throws when a test leaks a session", async () => {
		const before = snapshotEntities(gw);

		// Deliberate leak: create a session and do NOT track it in a scope.
		const session = await gw.apiJson<any>("/api/sessions", {
			method: "POST",
			body: JSON.stringify({ projectId: gw.defaultProjectId }),
		});
		expect(session?.id).toBeTruthy();
		leakedSessionIds.push(session.id);

		const after = snapshotEntities(gw);
		expect(after.sessions).toBe(before.sessions + 1);
		expect(() => assertNoLeaks(before, after)).toThrow(/entity leak detected/);
	});

	it("does not throw when a scope cleans up its session", async () => {
		const before = snapshotEntities(gw);

		const scope = createScope(gw);
		const session = await scope.createSession({});
		expect(session?.id).toBeTruthy();
		expect(snapshotEntities(gw).sessions).toBe(before.sessions + 1);

		await scope.cleanup();

		const after = snapshotEntities(gw);
		expect(after.sessions).toBe(before.sessions);
		expect(() => assertNoLeaks(before, after)).not.toThrow();
	});
});
