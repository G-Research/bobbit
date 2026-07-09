// Migrated from tests/e2e/project-story-api.spec.ts (v2-integration tier).
// API/data-path coverage; browser-only project stories stay in the UI journey.
import { beforeAll, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture } from "../harness/gateway.js";

let gw: GatewayFixture;
beforeAll(async () => { gw = await getGateway(); });

describe("CT-16 project organization API stories", () => {
	// PR-04: Project removal API exists. Use a non-existent id so the endpoint
	// is exercised without side effects on the shared fork's default project.
	it("PR-04: Project removal API returns proper status", async () => {
		const resp = await gw.api("/api/projects/nonexistent-id-12345", { method: "DELETE" });
		expect([404, 400].includes(resp.status)).toBe(true);
	});
});
