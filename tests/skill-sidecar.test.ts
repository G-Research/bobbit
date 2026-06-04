/**
 * Unit tests for skill-sidecar.ts — round-trip + missing-sidecar fallback.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-sidecar-test-"));
const stateDir = path.join(tmpRoot, "state");
fs.mkdirSync(stateDir, { recursive: true });
process.env.BOBBIT_DIR = tmpRoot;

const {
	initSkillSidecarDir,
	appendSkillSidecarEntry,
	readSkillSidecarEntries,
	findSkillSidecarEntry,
	purgeSkillSidecar,
	mergeSidecarEntriesIntoMessages,
} = await import("../src/server/skills/skill-sidecar.ts");

initSkillSidecarDir(stateDir);

after(() => {
	try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sample = {
	ts: 1714000000000,
	modelText: "EXPANDED-BODY",
	originalText: "/mockup hero",
	skillExpansions: [
		{
			name: "mockup",
			args: "hero",
			source: "built-in" as const,
			filePath: "/path/to/SKILL.md",
			range: [0, "/mockup hero".length] as [number, number],
			expanded: "EXPANDED-BODY",
		},
	],
};

const fileMentionSample = {
	ts: 1714000001000,
	modelText: "see <file-reference path=\"a.txt\">hi</file-reference>",
	originalText: "see @a.txt",
	skillExpansions: [],
	fileMentions: [
		{
			path: "a.txt",
			absPath: "/abs/a.txt",
			range: [4, 10] as [number, number],
			kind: "text" as const,
			content: "hi",
			bytes: 2,
		},
	],
};

describe("skill-sidecar", () => {
	it("appends and reads back a single entry", () => {
		const sid = "session-roundtrip";
		appendSkillSidecarEntry(sid, sample);
		const entries = readSkillSidecarEntries(sid);
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0], sample);
	});

	it("findSkillSidecarEntry matches by modelText + ts within tolerance", () => {
		const sid = "session-find";
		appendSkillSidecarEntry(sid, sample);
		const got = findSkillSidecarEntry(sid, "EXPANDED-BODY", sample.ts + 1500);
		assert.ok(got, "should match within 2s tolerance");
		assert.equal(got!.originalText, "/mockup hero");
	});

	it("findSkillSidecarEntry falls back to text-only match when ts diverges", () => {
		const sid = "session-fallback";
		appendSkillSidecarEntry(sid, sample);
		const got = findSkillSidecarEntry(sid, "EXPANDED-BODY", sample.ts + 1_000_000_000);
		assert.ok(got, "text-only fallback should match");
	});

	it("missing sidecar returns empty array (backward compat)", () => {
		const sid = "session-never-existed";
		const entries = readSkillSidecarEntries(sid);
		assert.deepEqual(entries, []);
	});

	it("malformed lines are skipped, well-formed lines preserved", () => {
		const sid = "session-malformed";
		appendSkillSidecarEntry(sid, sample);
		// Append garbage manually
		const file = path.join(stateDir, "skill-sidecar", `${sid}.jsonl`);
		fs.appendFileSync(file, "not-json\n", "utf-8");
		appendSkillSidecarEntry(sid, { ...sample, ts: sample.ts + 1, modelText: "OTHER" });
		const entries = readSkillSidecarEntries(sid);
		assert.equal(entries.length, 2);
	});

	it("purge removes the sidecar file", () => {
		const sid = "session-purge";
		appendSkillSidecarEntry(sid, sample);
		purgeSkillSidecar(sid);
		assert.deepEqual(readSkillSidecarEntries(sid), []);
	});

	it("multiple entries: findSkillSidecarEntry returns the timestamp-closest match", () => {
		const sid = "session-multi";
		appendSkillSidecarEntry(sid, { ...sample, ts: 1000, originalText: "FIRST" });
		appendSkillSidecarEntry(sid, { ...sample, ts: 2000, originalText: "SECOND" });
		const got = findSkillSidecarEntry(sid, "EXPANDED-BODY", 2100, 500);
		// Within 500ms tolerance: only the second matches.
		assert.equal(got?.originalText, "SECOND");
	});

	it("round-trips an entry carrying fileMentions (no skill expansions)", () => {
		const sid = "session-file-mentions";
		appendSkillSidecarEntry(sid, fileMentionSample);
		const entries = readSkillSidecarEntries(sid);
		assert.equal(entries.length, 1);
		assert.deepEqual(entries[0], fileMentionSample);
		assert.equal(entries[0].fileMentions?.[0].kind, "text");
	});

	it("entry with only fileMentions (no skillExpansions array) still reads", () => {
		const sid = "session-file-only";
		const file = path.join(stateDir, "skill-sidecar", `${sid}.jsonl`);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		// Hand-write an entry missing skillExpansions entirely.
		const raw = {
			ts: 123,
			modelText: "m",
			originalText: "o",
			fileMentions: [{ path: "x.txt", range: [0, 6], kind: "text", content: "c" }],
		};
		fs.appendFileSync(file, JSON.stringify(raw) + "\n", "utf-8");
		const entries = readSkillSidecarEntries(sid);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].fileMentions?.[0].path, "x.txt");
	});

	it("old entry without fileMentions field still parses (backward compat)", () => {
		const sid = "session-old-entry";
		appendSkillSidecarEntry(sid, sample); // no fileMentions field
		const entries = readSkillSidecarEntries(sid);
		assert.equal(entries.length, 1);
		assert.equal(entries[0].fileMentions, undefined);
		assert.equal(entries[0].skillExpansions.length, 1);
	});
});

describe("mergeSidecarEntriesIntoMessages (restore / snapshot path)", () => {
	// Regression: the restore path must re-attach fileMentions, not just
	// skillExpansions — otherwise @-mention chips vanish on reload.
	it("re-attaches fileMentions onto a restored pure @-mention message", () => {
		const messages = [
			{ role: "user", content: fileMentionSample.modelText },
		];
		const out = mergeSidecarEntriesIntoMessages([fileMentionSample], messages);
		assert.equal(out[0].content, "see @a.txt"); // body rewritten to originalText
		assert.deepEqual(out[0].fileMentions, fileMentionSample.fileMentions);
		assert.deepEqual(out[0].skillExpansions, []);
	});

	it("re-attaches BOTH skillExpansions and fileMentions when present", () => {
		const entry = {
			ts: 1,
			modelText: "EXPANDED-BODY",
			originalText: "/mockup @a.txt",
			skillExpansions: sample.skillExpansions,
			fileMentions: fileMentionSample.fileMentions,
		};
		const out = mergeSidecarEntriesIntoMessages([entry], [{ role: "user", content: "EXPANDED-BODY" }]);
		assert.equal(out[0].content, "/mockup @a.txt");
		assert.equal(out[0].skillExpansions.length, 1);
		assert.deepEqual(out[0].fileMentions, fileMentionSample.fileMentions);
	});

	it("does NOT add a fileMentions key when the entry has none", () => {
		const out = mergeSidecarEntriesIntoMessages([sample], [{ role: "user", content: "EXPANDED-BODY" }]);
		assert.equal(out[0].content, "/mockup hero");
		assert.ok(!("fileMentions" in out[0]), "no empty fileMentions key on skill-only restore");
	});

	it("rewrites the text block of an array-content (user-with-attachments) message", () => {
		const messages = [
			{
				role: "user-with-attachments",
				content: [
					{ type: "text", text: fileMentionSample.modelText },
					{ type: "image", data: "..." },
				],
			},
		];
		const out = mergeSidecarEntriesIntoMessages([fileMentionSample], messages);
		const textBlock = out[0].content.find((c: any) => c.type === "text");
		assert.equal(textBlock.text, "see @a.txt");
		assert.deepEqual(out[0].fileMentions, fileMentionSample.fileMentions);
	});

	it("passes through messages with no matching entry (idempotent)", () => {
		const messages = [{ role: "user", content: "no match here" }];
		const out = mergeSidecarEntriesIntoMessages([fileMentionSample], messages);
		assert.equal(out, messages); // same reference — unchanged
	});
});
