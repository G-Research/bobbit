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
});
