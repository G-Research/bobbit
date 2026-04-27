/**
 * Unit tests for buildSkillResourceManifest and buildActivationHeader
 * (Claude Code skill parity — Level-3 progressive disclosure).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { buildSkillResourceManifest, buildActivationHeader, ACTIVATION_HEADER_STRIP_RE } =
	await import("../src/server/skills/skill-manifest.ts");

let root: string;

function mkSkillDir(name: string, layout: Record<string, string>): string {
	const skillRoot = path.join(root, name);
	fs.mkdirSync(skillRoot, { recursive: true });
	fs.writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: x\ndescription: y\n---\nbody", "utf-8");
	for (const [rel, body] of Object.entries(layout)) {
		const abs = path.join(skillRoot, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body, "utf-8");
	}
	return skillRoot;
}

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manifest-test-"));
});
after(() => {
	try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("buildSkillResourceManifest", () => {
	it("all three subdirs present → alphabetical, prefixed paths", () => {
		const skill = mkSkillDir("all-three", {
			"references/REFERENCE.md": "ref",
			"scripts/extract.py": "#!/usr/bin/env python",
			"assets/template.docx": "blob",
		});
		const m = buildSkillResourceManifest(skill);
		assert.ok(m, "manifest should not be null");
		assert.equal(m!.root, skill);
		assert.deepEqual(m!.resources, [
			"assets/template.docx",
			"references/REFERENCE.md",
			"scripts/extract.py",
		]);
		assert.equal(m!.truncated, false);
	});

	it("one subdir missing → others still present", () => {
		const skill = mkSkillDir("missing-scripts", {
			"references/A.md": "a",
			"assets/b.txt": "b",
		});
		const m = buildSkillResourceManifest(skill);
		assert.ok(m);
		assert.deepEqual(m!.resources, ["assets/b.txt", "references/A.md"]);
	});

	it("all three missing → returns null (caller omits the resource line)", () => {
		const skill = mkSkillDir("nothing", {});
		const m = buildSkillResourceManifest(skill);
		assert.equal(m, null);
	});

	it("nonexistent root → returns null", () => {
		const m = buildSkillResourceManifest(path.join(root, "does-not-exist"));
		assert.equal(m, null);
	});

	it("one-level-deep only — does NOT recurse into nested subdirs", () => {
		const skill = mkSkillDir("deep", {
			"references/top.md": "top",
			"references/nested/deep.md": "deep",
		});
		const m = buildSkillResourceManifest(skill);
		assert.ok(m);
		// `references/nested/deep.md` must NOT appear; nested dir entry skipped.
		assert.deepEqual(m!.resources, ["references/top.md"]);
	});

	it(">2 KB → truncates alphabetically and reports remaining count", () => {
		const layout: Record<string, string> = {};
		// Generate 200 files in references/ with names ~25 bytes each — well over 2 KB.
		for (let i = 0; i < 200; i++) {
			const name = `file-${String(i).padStart(4, "0")}.md`;
			layout[`references/${name}`] = "x";
		}
		const skill = mkSkillDir("big", layout);
		const m = buildSkillResourceManifest(skill);
		assert.ok(m);
		assert.equal(m!.truncated, true);
		assert.ok(m!.resources.length < 200, "should be capped");
		assert.ok(m!.resources.length > 0, "should keep some");
		// Resources kept must be the alphabetically-earliest ones
		assert.equal(m!.resources[0], "references/file-0000.md");
		// Joined byte length is within cap
		const joined = m!.resources.join(", ");
		assert.ok(Buffer.byteLength(joined, "utf-8") <= 2048,
			`joined size ${Buffer.byteLength(joined, "utf-8")} should be ≤ 2048`);
		// Truncation suffix mentions remaining count
		assert.match(m!.truncationSuffix || "", /^\(\d+ more files\)$/);
	});
});

describe("buildActivationHeader", () => {
	it("emits fenced header with root + resources for project skill", () => {
		const skill = mkSkillDir("hdr-project", {
			"references/REF.md": "ref",
		});
		const header = buildActivationHeader({
			filePath: path.join(skill, "SKILL.md"),
			source: "project",
		});
		assert.match(header, /^<!-- skill-activation-header -->/);
		assert.match(header, new RegExp(`Skill root: ${skill.replace(/\\/g, "\\\\").replace(/\./g, "\\.")}`));
		assert.match(header, /Available resources: references\/REF\.md/);
		assert.match(header, /<!-- \/skill-activation-header -->\n$/);
	});

	it("omits Available resources line when no resource dirs exist", () => {
		const skill = mkSkillDir("hdr-empty", {});
		const header = buildActivationHeader({
			filePath: path.join(skill, "SKILL.md"),
			source: "project",
		});
		assert.match(header, /^<!-- skill-activation-header -->/);
		assert.ok(!header.includes("Available resources:"),
			"should not include resources line when no dirs");
		assert.match(header, /Skill root: /);
	});

	it("returns empty string for legacy commands and built-ins", () => {
		assert.equal(buildActivationHeader({ filePath: "(built-in)", source: "built-in" }), "");
		assert.equal(buildActivationHeader({ filePath: "/some/.claude/commands/foo.md", source: "legacy" }), "");
	});

	it("sandboxed degraded header when pathRewrite returns null", () => {
		const skill = mkSkillDir("hdr-sandbox", {
			"references/REF.md": "ref",
		});
		const header = buildActivationHeader(
			{ filePath: path.join(skill, "SKILL.md"), source: "built-in" },
			() => null,
		);
		assert.match(header, /Skill root: \(not visible inside sandbox/);
		assert.ok(!header.includes("Available resources:"),
			"degraded header should not list resources");
	});

	it("pathRewrite that returns a string is used for the displayed root", () => {
		const skill = mkSkillDir("hdr-rewritten", {
			"scripts/run.sh": "#!/bin/sh",
		});
		const header = buildActivationHeader(
			{ filePath: path.join(skill, "SKILL.md"), source: "project" },
			() => "/workspace/.claude/skills/hdr-rewritten",
		);
		assert.match(header, /Skill root: \/workspace\/\.claude\/skills\/hdr-rewritten/);
		// Resources still scanned from the host
		assert.match(header, /Available resources: scripts\/run\.sh/);
	});

	it("strip regex round-trip removes the header and only the header", () => {
		const skill = mkSkillDir("hdr-strip", { "references/A.md": "a" });
		const header = buildActivationHeader({
			filePath: path.join(skill, "SKILL.md"),
			source: "project",
		});
		const body = "# Real body\n\nText with <!-- skill-activation-header --> inline marker preserved <!-- /skill-activation-header --> in the middle.";
		const combined = header + body;
		const stripped = combined.replace(ACTIVATION_HEADER_STRIP_RE, "");
		assert.equal(stripped, body, "in-body fence must NOT be stripped (anchored regex)");
	});

	it("strip regex on body without header is a no-op", () => {
		const body = "no header here\nmultiple lines\n";
		assert.equal(body.replace(ACTIVATION_HEADER_STRIP_RE, ""), body);
	});
});
