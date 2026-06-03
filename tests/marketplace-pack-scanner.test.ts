/**
 * Unit tests for the marketplace pack scanner (§2, §5).
 * Points at the file:// fixture source tree tests/fixtures/marketplace/source-a.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { scanSource, scanPackDir, parsePackManifest, hashPackPayload } =
	await import("../src/server/marketplace/pack-scanner.ts");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_A = path.join(__dirname, "fixtures", "marketplace", "source-a");

describe("marketplace pack scanner", () => {
	it("scans only dirs with pack.yaml and ignores non-pack dirs", () => {
		const packs = scanSource("src-a", SOURCE_A);
		const ids = packs.map((p) => p.packId).sort();
		assert.deepEqual(ids, ["invalid-pack", "research-pack", "roles-only-pack"]);
		// not-a-pack/ has no pack.yaml → ignored
		assert.ok(!ids.includes("not-a-pack"));
	});

	it("parses manifest identity fields and declared entities", () => {
		const packs = scanSource("src-a", SOURCE_A);
		const research = packs.find((p) => p.packId === "research-pack")!;
		assert.equal(research.valid, true);
		assert.equal(research.manifest?.name, "Research Pack");
		assert.equal(research.manifest?.version, "1.2.0");
		const entityKeys = research.entities.map((e) => `${e.type}/${e.name}`).sort();
		assert.deepEqual(entityKeys, ["role/researcher", "skill/deep-research", "tool/research"]);
	});

	it("sets hasTools true iff a tool entity is declared", () => {
		const packs = scanSource("src-a", SOURCE_A);
		assert.equal(packs.find((p) => p.packId === "research-pack")!.hasTools, true);
		assert.equal(packs.find((p) => p.packId === "roles-only-pack")!.hasTools, false);
	});

	it("surfaces an error for a pack declaring a missing entity, keeping siblings valid", () => {
		const packs = scanSource("src-a", SOURCE_A);
		const invalid = packs.find((p) => p.packId === "invalid-pack")!;
		assert.equal(invalid.valid, false);
		assert.match(invalid.error ?? "", /missing-role/);
		// Sibling valid packs are still returned.
		assert.equal(packs.find((p) => p.packId === "roles-only-pack")!.valid, true);
	});

	it("rejects apiVersion !== 1 without crashing", () => {
		const res = parsePackManifest("apiVersion: 2\nid: x\nname: X\ndescription: d\nversion: 1\ncontents:\n  roles: [a]\n");
		assert.equal(res.manifest, undefined);
		assert.match(res.error ?? "", /apiVersion/);
	});

	it("rejects a pack id that violates the pattern", () => {
		const res = parsePackManifest('apiVersion: 1\nid: Bad_Id\nname: X\ndescription: d\nversion: "1"\ncontents:\n  roles: [a]\n');
		assert.match(res.error ?? "", /must match/);
	});

	it("rejects contents with no supported non-empty list", () => {
		const res = parsePackManifest('apiVersion: 1\nid: x\nname: X\ndescription: d\nversion: "1"\ncontents:\n  panels: [a]\n');
		assert.match(res.error ?? "", /at least one/);
	});

	it("preserves unknown contents keys (forward-compat) while still parsing", () => {
		const res = parsePackManifest(
			'apiVersion: 1\nid: x\nname: X\ndescription: d\nversion: "1"\ncontents:\n  roles: [a]\n  panels: [p]\n',
		);
		assert.ok(res.manifest);
		assert.deepEqual((res.manifest!.contents as Record<string, unknown>).panels, ["p"]);
	});

	it("hashPackPayload is stable and changes when payload changes", () => {
		const research = scanPackDir("src-a", path.join(SOURCE_A, "research-pack"));
		const h1 = hashPackPayload(research);
		const h2 = hashPackPayload(scanPackDir("src-a", path.join(SOURCE_A, "research-pack")));
		assert.equal(h1, h2);

		// Copy to a temp dir, mutate a file, expect a different hash.
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pack-hash-"));
		fs.cpSync(path.join(SOURCE_A, "research-pack"), path.join(tmp, "research-pack"), { recursive: true });
		const copyPack = scanPackDir("src-a", path.join(tmp, "research-pack"));
		assert.equal(hashPackPayload(copyPack), h1);
		fs.appendFileSync(path.join(tmp, "research-pack", "roles", "researcher.yaml"), "\n# mutated\n");
		assert.notEqual(hashPackPayload(scanPackDir("src-a", path.join(tmp, "research-pack"))), h1);
	});
});
