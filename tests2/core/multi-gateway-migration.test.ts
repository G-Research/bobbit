// v2-native — compatibility migration for the former singleton AIGW preference.
import { afterEach, beforeEach, describe, it } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import { listGateways, migrateGatewayPrefs } from "../../src/server/agent/aigw-manager.js";

let stateDir = "";
beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-multi-gateway-migration-")); });
afterEach(() => { fs.rmSync(stateDir, { recursive: true, force: true }); });

describe("multi-gateway legacy preference migration", () => {
	it("migrates a nonblank singleton URL without changing aigw model preferences", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("aigw.url", " http://gateway.test/v1/ ");
		prefs.set("aigw.exclusive", false);
		prefs.set("default.sessionModel", "aigw/aws/us.anthropic.claude-sonnet");
		const result = migrateGatewayPrefs(prefs);
		assert.equal(result.migrated, true);
		assert.deepEqual(listGateways(prefs).map(({ id, ...gateway }) => gateway), [{ name: "aigw", url: "http://gateway.test/v1", type: "aigw", enabled: true }]);
		assert.equal(prefs.get("aigw.url"), undefined);
		assert.equal(prefs.get("aigw.exclusive"), undefined);
		assert.equal(prefs.get("default.sessionModel"), "aigw/aws/us.anthropic.claude-sonnet");
	});

	it("is idempotent and treats an existing list, including [], as authoritative", () => {
		const prefs = new PreferencesStore(stateDir);
		prefs.set("aigw.url", "http://gateway.test/v1");
		migrateGatewayPrefs(prefs);
		const once = JSON.stringify(prefs.get("modelGateways"));
		assert.equal(migrateGatewayPrefs(prefs).migrated, false);
		assert.equal(JSON.stringify(prefs.get("modelGateways")), once);

		prefs.set("modelGateways", []);
		prefs.set("aigw.url", "http://stale.test/v1");
		assert.deepEqual(migrateGatewayPrefs(prefs), { migrated: false, gateways: [] });
		assert.equal(prefs.get("aigw.url"), undefined);
	});
});
