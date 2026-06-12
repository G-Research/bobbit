/**
 * Unit tests for `saveGateways()` validation (docs/design/multi-gateway-providers.md §1).
 *
 * Pins the naming constraints — in particular the singleton `aigw`-name rule
 * that keeps the three literal `"aigw"` guards (pi-ai-bedrock-headers-patch.ts,
 * model-completion.ts, shared/thinking-levels.ts) correct UNCHANGED:
 *
 *   - accept an `aigw`-type gateway named exactly "aigw";
 *   - reject an `aigw`-type gateway named anything else;
 *   - reject a list containing more than one `aigw`-type gateway;
 *   - accept arbitrarily-named `openai-compatible` gateways;
 *   - reject names colliding with a built-in provider id;
 *   - reject names violating `^[a-zA-Z0-9._-]+$`;
 *   - reject duplicate names;
 *   - fill a missing `id` with a generated UUID.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");
const { saveGateways, listGateways } = await import("../src/server/agent/aigw-manager.ts");

let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-valid-"));
});

afterEach(() => {
	rmSync(stateDir, { recursive: true, force: true });
});

const aigw = (name: string) => ({ id: "x", name, url: "http://gw/v1", type: "aigw" as const, enabled: true });
const local = (name: string) => ({ id: name, name, url: "http://host:9292", type: "openai-compatible" as const, enabled: true });

describe("saveGateways validation", () => {
	it("accepts an aigw-type gateway named exactly \"aigw\"", () => {
		const prefs = new PreferencesStore(stateDir);
		assert.doesNotThrow(() => saveGateways(prefs as any, [aigw("aigw")]));
		const list = listGateways(prefs as any);
		assert.equal(list.length, 1);
		assert.equal(list[0].name, "aigw");
		assert.equal(list[0].type, "aigw");
	});

	it("accepts arbitrarily-named openai-compatible gateways", () => {
		const prefs = new PreferencesStore(stateDir);
		assert.doesNotThrow(() => saveGateways(prefs as any, [local("llama-swap"), local("ollama"), local("my.gw_1")]));
		assert.equal(listGateways(prefs as any).length, 3);
	});

	it("accepts one aigw plus openai-compatible gateways together", () => {
		const prefs = new PreferencesStore(stateDir);
		assert.doesNotThrow(() => saveGateways(prefs as any, [aigw("aigw"), local("llama-swap")]));
		assert.equal(listGateways(prefs as any).length, 2);
	});

	it("rejects an aigw-type gateway named anything other than \"aigw\"", () => {
		const prefs = new PreferencesStore(stateDir);
		assert.throws(() => saveGateways(prefs as any, [aigw("enterprise")]), /aigw-type gateway must be named/i);
	});

	it("rejects more than one aigw-type gateway", () => {
		const prefs = new PreferencesStore(stateDir);
		// Two aigw rows: the first must be named "aigw"; the second is rejected
		// either for the duplicate name or the >1 aigw rule — both are correct.
		assert.throws(() => saveGateways(prefs as any, [aigw("aigw"), aigw("aigw")]));
	});

	it("rejects a name colliding with a built-in provider id", () => {
		const prefs = new PreferencesStore(stateDir);
		for (const builtin of ["openai", "anthropic", "amazon-bedrock", "google", "groq", "mistral", "xai"]) {
			assert.throws(() => saveGateways(prefs as any, [local(builtin)]), /collides with a built-in provider id/i, `expected "${builtin}" to be rejected`);
		}
	});

	it("rejects names violating ^[a-zA-Z0-9._-]+$", () => {
		const prefs = new PreferencesStore(stateDir);
		for (const bad of ["has space", "a/b", "café", "name!", ""]) {
			assert.throws(() => saveGateways(prefs as any, [local(bad)]), `expected "${bad}" to be rejected`);
		}
	});

	it("rejects duplicate names", () => {
		const prefs = new PreferencesStore(stateDir);
		assert.throws(() => saveGateways(prefs as any, [local("dup"), local("dup")]), /duplicate gateway name/i);
	});

	it("fills a missing id with a generated UUID", () => {
		const prefs = new PreferencesStore(stateDir);
		saveGateways(prefs as any, [{ name: "llama-swap", url: "http://host:9292", type: "openai-compatible", enabled: true } as any]);
		const list = listGateways(prefs as any);
		assert.equal(list.length, 1);
		assert.equal(typeof list[0].id, "string");
		assert.ok(list[0].id.length > 0, "id must be filled in");
	});
});
