// v2-integration: session create → fetch → mark-read → delete via the shared
// gateway fixture. Demonstrates the scope() ownership + leak-guard discipline
// that replaces the Playwright worker fixture. Consolidates the API-only slices
// of the session-lifecycle browser specs (the visual journey stays in tier 2).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getGateway, type GatewayFixture, type EntityCounts } from "../harness/gateway.js";
import { createScope, type TestScope } from "../harness/scope.js";
import { assertNoLeaks, snapshotEntities } from "../harness/leak-detector.js";

let gw: GatewayFixture;
let scope: TestScope;
let baseline: EntityCounts;

beforeAll(async () => { gw = await getGateway(); baseline = snapshotEntities(gw); });
beforeEach(() => { scope = createScope(gw); });
afterEach(async () => { await scope.cleanup(); });
afterAll(() => { assertNoLeaks(baseline, snapshotEntities(gw)); });

describe("session lifecycle API", () => {
	it("creates a session that is then fetchable by id", async () => {
		const session = await scope.createSession({});
		expect(session?.id).toBeTruthy();

		const fetched = await gw.apiJson<any>(`/api/sessions/${session.id}`);
		expect(fetched.id).toBe(session.id);
	});

	it("mark-read on an existing session returns ok", async () => {
		const session = await scope.createSession({});
		const resp = await gw.api(`/api/sessions/${session.id}/mark-read`, { method: "POST" });
		expect(resp.ok).toBe(true);
	});

	it("lists the created session in GET /api/sessions", async () => {
		const session = await scope.createSession({});
		const body = await gw.apiJson<any>("/api/sessions");
		const list: any[] = Array.isArray(body) ? body : (body.sessions ?? []);
		expect(list.some(s => s.id === session.id)).toBe(true);
	});
});
