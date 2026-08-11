import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
	appendCompactionSidecarEntry,
	copyCompactionSidecarForTranscript,
	initCompactionSidecarDir,
	readCompactionSidecarEntries,
	resolveCompactionTranscriptEntryId,
} from "../../src/server/agent/compaction-sidecar.ts";
import {
	appendIdentifiedSkillSidecarEntry,
	appendSkillSidecarEntry,
	appendSkillSidecarTranscriptBinding,
	copySkillSidecarForTranscript,
	initSkillSidecarDir,
	readSkillSidecarEntries,
} from "../../src/server/skills/skill-sidecar.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-fork-sidecars-"));
initSkillSidecarDir(root);
initCompactionSidecarDir(root);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function skill(modelText: string, originalText: string) {
	return { ts: 1, modelText, originalText, skillExpansions: [] };
}

function compaction(id: string, transcriptCompactionEntryId?: string, firstKeptEntryId = "kept-user") {
	return {
		schemaVersion: 1 as const,
		id,
		trigger: "auto" as const,
		tokensBefore: 800,
		tokensAfter: null,
		durationMs: 10,
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:00.010Z",
		success: true,
		firstKeptEntryId,
		...(transcriptCompactionEntryId ? { transcriptCompactionEntryId } : {}),
	};
}

function snapshot(entries: Array<Record<string, unknown>>, leafId: string | null) {
	return { entries, leafId };
}

describe("history-fork skill sidecar identity", () => {
	it("copies only the proven retained Pi occurrence when inactive and active prompts have identical text", () => {
		const source = "skill-source";
		const target = "skill-target";
		const inactive = appendIdentifiedSkillSidecarEntry(source, skill("same", "/inactive @secret"));
		const active = appendIdentifiedSkillSidecarEntry(source, skill("same", "/active @kept"));
		assert.ok(inactive && active);
		expect(appendSkillSidecarTranscriptBinding(source, inactive, "inactive-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, active, "active-user")).toBe(true);

		expect(copySkillSidecarForTranscript(source, target, new Set(["active-user"]))).toBe(true);
		expect(readSkillSidecarEntries(target)).toEqual([
			expect.objectContaining({ originalText: "/active @kept", transcriptEntryId: "active-user" }),
		]);
	});

	it("does not trust a syntactically valid inline Pi identity without a binding", () => {
		const source = "skill-forged-inline-source";
		const target = "skill-forged-inline-target";
		expect(appendSkillSidecarEntry(source, {
			...skill("retained", "/forged @secret.ts"),
			schemaVersion: 1,
			recordId: "skill:v1:forged-inline",
			transcriptEntryId: "retained-user",
			fileMentions: [{ path: "secret.ts", start: 8, end: 18 } as any],
		})).toBe(true);

		const [sourceEntry] = readSkillSidecarEntries(source);
		expect(sourceEntry).toMatchObject({
			modelText: "retained",
			originalText: "/forged @secret.ts",
			fileMentions: [expect.objectContaining({ path: "secret.ts" })],
		});
		expect(sourceEntry).not.toHaveProperty("transcriptEntryId");
		expect(copySkillSidecarForTranscript(source, target, new Set(["retained-user"]))).toBe(true);
		expect(readSkillSidecarEntries(target)).toEqual([]);
	});

	it("omits legacy, duplicate, and conflicting bindings without affecting source replay", () => {
		const source = "skill-conflict-source";
		const target = "skill-conflict-target";
		expect(appendSkillSidecarEntry(source, skill("legacy", "/legacy"))).toBe(true);
		const conflict = appendIdentifiedSkillSidecarEntry(source, skill("same", "/conflict"));
		const repeated = appendIdentifiedSkillSidecarEntry(source, skill("repeated", "/repeated"));
		const duplicateA = appendIdentifiedSkillSidecarEntry(source, skill("one", "/one"));
		const duplicateB = appendIdentifiedSkillSidecarEntry(source, skill("two", "/two"));
		assert.ok(conflict && repeated && duplicateA && duplicateB);
		expect(appendSkillSidecarTranscriptBinding(source, conflict, "active-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, conflict, "other-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, repeated, "repeated-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, repeated, "repeated-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, duplicateA, "duplicate-user")).toBe(true);
		expect(appendSkillSidecarTranscriptBinding(source, duplicateB, "duplicate-user")).toBe(true);

		expect(copySkillSidecarForTranscript(
			source,
			target,
			new Set(["active-user", "repeated-user", "duplicate-user"]),
		)).toBe(true);
		expect(readSkillSidecarEntries(target)).toEqual([]);
		expect(readSkillSidecarEntries(source).map((entry) => entry.originalText)).toEqual([
			"/legacy", "/conflict", "/repeated", "/one", "/two",
		]);
	});
});

describe("history-fork compaction identity", () => {
	it("keeps Bobbit card identity distinct from its proven Pi checkpoint identity", () => {
		const source = "compaction-source";
		const target = "compaction-target";
		expect(appendCompactionSidecarEntry(source, compaction("c_1700000000000_abcdef", "pi-compaction"))).toBe(true);
		expect(copyCompactionSidecarForTranscript(source, target, [{ entry: {
			type: "compaction", id: "pi-compaction", firstKeptEntryId: "kept-user",
		} }], new Set(["kept-user", "pi-compaction"]))).toBe(true);
		expect(readCompactionSidecarEntries(target)).toEqual([
			expect.objectContaining({ id: "c_1700000000000_abcdef", transcriptCompactionEntryId: "pi-compaction" }),
		]);
	});

	it.each([
		["missing binding", compaction("c_missing")],
		["stale binding", compaction("c_stale", "stale")],
		["boundary mismatch", compaction("c_boundary", "pi-compaction", "other-user")],
	] as const)("drops %s", (_label, entry) => {
		const source = `compaction-drop-${entry.id}`;
		const target = `${source}-target`;
		expect(appendCompactionSidecarEntry(source, entry)).toBe(true);
		expect(copyCompactionSidecarForTranscript(source, target, [{ entry: {
			type: "compaction", id: "pi-compaction", firstKeptEntryId: "kept-user",
		} }], new Set(["kept-user", "pi-compaction"]))).toBe(true);
		expect(readCompactionSidecarEntries(target)).toEqual([]);
	});

	it("resolves exactly one new matching active compaction and ignores an inactive same-boundary sibling", () => {
		const baseline = snapshot([
			{ type: "message", id: "root", parentId: null },
			{ type: "message", id: "before", parentId: "root" },
		], "before");
		const post = snapshot([
			...baseline.entries,
			{ type: "compaction", id: "inactive", parentId: "before", summary: "same", firstKeptEntryId: "root", tokensBefore: 10 },
			{ type: "compaction", id: "active", parentId: "before", summary: "same", firstKeptEntryId: "root", tokensBefore: 10 },
		], "active");
		expect(resolveCompactionTranscriptEntryId(baseline, post, {
			summary: "same", firstKeptEntryId: "root", tokensBefore: 10,
		})).toBe("active");
	});

	it("fails closed for malformed trees and zero or multiple matching active checkpoints", () => {
		const baseline = snapshot([{ type: "message", id: "root", parentId: null }], "root");
		const expectation = { summary: "same", firstKeptEntryId: "root", tokensBefore: 10 };
		expect(resolveCompactionTranscriptEntryId(baseline, snapshot([
			{ type: "compaction", id: "broken", parentId: "missing", ...expectation },
		], "broken"), expectation)).toBeUndefined();
		expect(resolveCompactionTranscriptEntryId(baseline, snapshot([
			...baseline.entries,
			{ type: "compaction", id: "one", parentId: "root", summary: "different", firstKeptEntryId: "root", tokensBefore: 10 },
		], "one"), expectation)).toBeUndefined();
		expect(resolveCompactionTranscriptEntryId(baseline, snapshot([
			...baseline.entries,
			{ type: "compaction", id: "one", parentId: "root", ...expectation },
			{ type: "compaction", id: "two", parentId: "one", ...expectation },
		], "two"), expectation)).toBeUndefined();
	});
});
