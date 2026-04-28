/**
 * Unit tests for role-store: model & thinkingLevel field round-trip and
 * malformed-value handling.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { RoleStore, validateModelString, validateThinkingLevel } =
	await import("../src/server/agent/role-store.ts");

function mkTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-role-store-test-"));
}

describe("validateModelString", () => {
	it("accepts well-formed provider/model", () => {
		assert.equal(validateModelString("anthropic/claude-opus-4"), "anthropic/claude-opus-4");
		assert.equal(validateModelString("aigw/claude-sonnet-4-5"), "aigw/claude-sonnet-4-5");
	});

	it("trims surrounding whitespace", () => {
		assert.equal(validateModelString("  anthropic/claude-opus-4  "), "anthropic/claude-opus-4");
	});

	it("rejects malformed values", () => {
		assert.equal(validateModelString(""), undefined);
		assert.equal(validateModelString("   "), undefined);
		assert.equal(validateModelString("no-slash"), undefined);
		assert.equal(validateModelString("/no-provider"), undefined);
		assert.equal(validateModelString("no-model/"), undefined);
		assert.equal(validateModelString(123 as unknown as string), undefined);
		assert.equal(validateModelString(null as unknown as string), undefined);
		assert.equal(validateModelString(undefined), undefined);
	});
});

describe("validateThinkingLevel", () => {
	it("accepts canonical values", () => {
		for (const v of ["off", "minimal", "low", "medium", "high"]) {
			assert.equal(validateThinkingLevel(v), v);
		}
	});

	it("rejects unknown / malformed values", () => {
		assert.equal(validateThinkingLevel(""), undefined);
		assert.equal(validateThinkingLevel("ultra"), undefined);
		assert.equal(validateThinkingLevel("HIGH"), undefined); // case-sensitive
		assert.equal(validateThinkingLevel(undefined), undefined);
		assert.equal(validateThinkingLevel(7 as unknown as string), undefined);
	});
});

describe("RoleStore — model & thinkingLevel round-trip", () => {
	it("persists model + thinkingLevel through put → reload", () => {
		const dir = mkTempDir();
		const store = new RoleStore(dir);
		store.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "you are a coder",
			accessory: "bandana",
			model: "anthropic/claude-opus-4",
			thinkingLevel: "high",
			createdAt: 1000,
			updatedAt: 1000,
		});

		// Verify YAML on disk contains both fields
		const yamlPath = path.join(dir, "roles", "coder.yaml");
		const raw = fs.readFileSync(yamlPath, "utf-8");
		assert.match(raw, /model:\s*anthropic\/claude-opus-4/);
		assert.match(raw, /thinkingLevel:\s*high/);

		// Reload from disk via a new store instance
		const store2 = new RoleStore(dir);
		const loaded = store2.get("coder");
		assert.ok(loaded, "role should be loaded from disk");
		assert.equal(loaded!.model, "anthropic/claude-opus-4");
		assert.equal(loaded!.thinkingLevel, "high");
	});

	it("omits model + thinkingLevel from YAML when unset", () => {
		const dir = mkTempDir();
		const store = new RoleStore(dir);
		store.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "you are a coder",
			accessory: "bandana",
			createdAt: 1000,
			updatedAt: 1000,
		});

		const raw = fs.readFileSync(path.join(dir, "roles", "coder.yaml"), "utf-8");
		assert.doesNotMatch(raw, /^model:/m);
		assert.doesNotMatch(raw, /^thinkingLevel:/m);

		const store2 = new RoleStore(dir);
		const loaded = store2.get("coder");
		assert.equal(loaded!.model, undefined);
		assert.equal(loaded!.thinkingLevel, undefined);
	});

	it("drops malformed model + thinkingLevel from YAML on load", () => {
		const dir = mkTempDir();
		const rolesDir = path.join(dir, "roles");
		fs.mkdirSync(rolesDir, { recursive: true });
		fs.writeFileSync(
			path.join(rolesDir, "bad.yaml"),
			[
				"name: bad",
				"label: Bad Role",
				"accessory: none",
				"model: not-a-valid-model",
				"thinkingLevel: ultra",
				"promptTemplate: bad",
				"createdAt: 0",
				"updatedAt: 0",
			].join("\n"),
		);

		const store = new RoleStore(dir);
		const loaded = store.get("bad");
		assert.ok(loaded);
		assert.equal(loaded!.model, undefined);
		assert.equal(loaded!.thinkingLevel, undefined);
	});

	it("normalises malformed values on put (rejects rather than persisting garbage)", () => {
		const dir = mkTempDir();
		const store = new RoleStore(dir);
		store.put({
			name: "coder",
			label: "Coder",
			promptTemplate: "p",
			accessory: "none",
			model: "garbage-no-slash",
			thinkingLevel: "ultra",
			createdAt: 1,
			updatedAt: 1,
		});

		const raw = fs.readFileSync(path.join(dir, "roles", "coder.yaml"), "utf-8");
		assert.doesNotMatch(raw, /model:/);
		assert.doesNotMatch(raw, /thinkingLevel:/);
	});
});
