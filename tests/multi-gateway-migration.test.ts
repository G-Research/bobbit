/**
 * Unit tests for `migrateGatewayPrefs()` — the idempotent boot-time migration
 * of the legacy single-URL prefs (`aigw.url` [+ `aigw.exclusive`]) into the new
 * ordered `modelGateways` list.
 *
 * Contract (docs/design/multi-gateway-providers.md §2):
 *   1. A configured single URL migrates to one `{name:"aigw", type:"aigw"}`
 *      gateway; `aigw.url` / `aigw.exclusive` are removed; unrelated prefs
 *      (e.g. `default.sessionModel = "aigw/..."`) are left untouched.
 *   2. Running it again is a no-op (`migrated:false`) and leaves the list
 *      byte-identical.
 *   3. With nothing to migrate, prefs are untouched and `modelGateways` stays
 *      absent (readers treat absent as `[]`).
 *   4. With `modelGateways` already present, a stale `aigw.url` is stripped
 *      defensively and the list is unchanged.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { migrateGatewayPrefs, listGateways } = await import("../src/server/agent/aigw-manager.ts");

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-migrate-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

describe("migrateGatewayPrefs", () => {
	it("migrates a configured single URL into a one-element aigw gateway list", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("aigw.url", "http://gw/v1");
		prefs.set("aigw.exclusive", false);
		prefs.set("default.sessionModel", "aigw/claude-sonnet-4-6");

		const result = migrateGatewayPrefs(prefs as any);

		assert.equal(result.migrated, true, "should report a migration occurred");

		const gateways = listGateways(prefs as any);
		assert.equal(gateways.length, 1);
		assert.equal(typeof gateways[0].id, "string");
		assert.ok(gateways[0].id.length > 0, "id must be a non-empty string");
		// deep-equal everything but the random id
		const { id, ...rest } = gateways[0];
		assert.deepEqual(rest, {
			name: "aigw",
			url: "http://gw/v1",
			type: "aigw",
			enabled: true,
		});

		// Legacy keys gone; the result's gateways mirror the persisted list.
		assert.equal(prefs.get("aigw.url"), undefined, "aigw.url must be removed");
		assert.equal(prefs.get("aigw.exclusive"), undefined, "aigw.exclusive must be removed");
		assert.deepEqual(result.gateways, gateways);

		// Unrelated session-model pref keyed on the "aigw" provider survives.
		assert.equal(prefs.get("default.sessionModel"), "aigw/claude-sonnet-4-6");
	});

	it("is idempotent — a second run is a no-op leaving the list byte-identical", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("aigw.url", "http://gw/v1");

		const first = migrateGatewayPrefs(prefs as any);
		assert.equal(first.migrated, true);
		const afterFirst = JSON.stringify(prefs.get("modelGateways"));

		const second = migrateGatewayPrefs(prefs as any);
		assert.equal(second.migrated, false, "second run must not migrate again");
		const afterSecond = JSON.stringify(prefs.get("modelGateways"));

		assert.equal(afterSecond, afterFirst, "modelGateways must be byte-identical after re-run");
	});

	it("is a no-op when there is nothing to migrate", () => {
		const prefs = new PreferencesStore(stateDir);

		const result = migrateGatewayPrefs(prefs as any);

		assert.equal(result.migrated, false);
		assert.deepEqual(result.gateways, []);
		assert.equal(prefs.get("modelGateways"), undefined, "modelGateways must stay absent");
		assert.deepEqual(listGateways(prefs as any), []);
	});

	it("defensively strips a stale aigw.url when modelGateways already exists", () => {
		const prefs = new PreferencesStore(stateDir);
		const seeded = [{ id: "fixed-id", name: "llama-swap", url: "http://host:9292", type: "openai-compatible", enabled: true }];
		prefs.set("modelGateways", seeded);
		prefs.set("aigw.url", "http://stale/v1");
		const before = JSON.stringify(prefs.get("modelGateways"));

		const result = migrateGatewayPrefs(prefs as any);

		assert.equal(result.migrated, false);
		assert.equal(prefs.get("aigw.url"), undefined, "stale aigw.url must be removed");
		assert.equal(JSON.stringify(prefs.get("modelGateways")), before, "modelGateways must be unchanged");
	});
});
