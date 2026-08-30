// Migrated from tests/e2e/unseen-activity-api.spec.ts (v2-integration tier).
// Uses the fork-scoped gateway fixture instead of the Playwright in-process
// harness; no entities are created so no scope() cleanup is needed.
import { beforeAll, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";

let gw: GatewayFixture;
beforeAll(async () => { gw = await getGateway(); });

describe("Unseen-activity API", () => {
	it("mark-read endpoint returns 404 for unknown session", async () => {
		const resp = await gw.api("/api/sessions/does-not-exist/mark-read", { method: "POST" });
		expect(resp.status).toBe(404);
	});
});
