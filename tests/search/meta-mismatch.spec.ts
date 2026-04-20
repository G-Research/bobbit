/**
 * Unit tests for `src/server/search/meta.ts::needsRebuild`.
 *
 * Verifies that any mismatch on engine / engineVersion / schemaVersion /
 * contentPolicyVersion triggers a rebuild, and matching values do not.
 *
 * Design reference: docs/design/portable-search.md §8.
 */
import { test, expect } from "@playwright/test";
import {
	buildCurrentMeta,
	needsRebuild,
	readMeta,
	writeMeta,
	type MetaRow,
} from "../../src/server/search/meta.ts";
import { SCHEMA_VERSION } from "../../src/server/search/types.ts";

function baseline(): MetaRow {
	return buildCurrentMeta({
		engine: "flexsearch",
		engineVersion: "0.8.158",
		contentPolicyVersion: 1,
		createdAt: 1_700_000_000_000,
	});
}

test.describe("needsRebuild", () => {
	test("null/undefined stored → rebuild", () => {
		expect(needsRebuild(null, baseline())).toBe(true);
		expect(needsRebuild(undefined, baseline())).toBe(true);
	});

	test("identical meta → no rebuild", () => {
		expect(needsRebuild(baseline(), baseline())).toBe(false);
	});

	test("engine differs → rebuild", () => {
		const stored = { ...baseline(), engine: "something-else" };
		expect(needsRebuild(stored, baseline())).toBe(true);
	});

	test("engineVersion differs → rebuild", () => {
		const stored = { ...baseline(), engineVersion: "0.7.0" };
		expect(needsRebuild(stored, baseline())).toBe(true);
	});

	test("schemaVersion differs → rebuild", () => {
		const stored = { ...baseline(), schemaVersion: SCHEMA_VERSION + 1 };
		expect(needsRebuild(stored, baseline())).toBe(true);
	});

	test("contentPolicyVersion differs → rebuild", () => {
		const stored = { ...baseline(), contentPolicyVersion: 99 };
		expect(needsRebuild(stored, baseline())).toBe(true);
	});

	test("createdAt differing alone does NOT trigger rebuild", () => {
		const stored = { ...baseline(), createdAt: 1 };
		expect(needsRebuild(stored, baseline())).toBe(false);
	});
});

test.describe("readMeta / writeMeta", () => {
	test("roundtrips to persisted form and back", () => {
		const meta = baseline();
		const persisted = writeMeta(meta);
		expect(persisted).toEqual({
			engine: meta.engine,
			engine_version: meta.engineVersion,
			schema_version: meta.schemaVersion,
			content_policy_version: meta.contentPolicyVersion,
			created_at: meta.createdAt,
		});
		expect(readMeta(persisted)).toEqual(meta);
	});

	test("readMeta returns null for null/undefined", () => {
		expect(readMeta(null)).toBeNull();
		expect(readMeta(undefined)).toBeNull();
	});

	test("readMeta returns null for malformed row (missing field)", () => {
		const bad = { engine: "flexsearch", engine_version: "1" } as unknown as Parameters<typeof readMeta>[0];
		expect(readMeta(bad)).toBeNull();
	});

	test("readMeta returns null when a field has the wrong type", () => {
		const bad = {
			engine: "flexsearch",
			engine_version: 123 as unknown as string,
			schema_version: 1,
			content_policy_version: 1,
			created_at: 123,
		};
		expect(readMeta(bad)).toBeNull();
	});
});

test.describe("buildCurrentMeta", () => {
	test("stamps SCHEMA_VERSION from types.ts", () => {
		const m = buildCurrentMeta({ engine: "flexsearch", engineVersion: "x", contentPolicyVersion: 1 });
		expect(m.schemaVersion).toBe(SCHEMA_VERSION);
	});

	test("defaults createdAt to now()", () => {
		const before = Date.now();
		const m = buildCurrentMeta({ engine: "flexsearch", engineVersion: "x", contentPolicyVersion: 1 });
		const after = Date.now();
		expect(m.createdAt).toBeGreaterThanOrEqual(before);
		expect(m.createdAt).toBeLessThanOrEqual(after);
	});
});
