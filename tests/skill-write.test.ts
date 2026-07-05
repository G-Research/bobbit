/**
 * Unit tests for src/server/skills/skill-write.ts (F26 — the propose_skill
 * half). Covers name validation, frontmatter serialization, and that a
 * written SKILL.md round-trips through the real discovery scanner
 * (scanSkillDir in slash-skills.ts) unchanged — the write side and the read
 * side must agree on the file shape.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isValidSkillName, serializeSkillFile, writeSkillFile } from "../src/server/skills/skill-write.ts";
import { scanSkillDir } from "../src/server/skills/slash-skills.ts";

let configDir: string;

before(() => {
	configDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-write-test-"));
});

after(() => {
	fs.rmSync(configDir, { recursive: true, force: true });
});

describe("isValidSkillName", () => {
	it("accepts lowercase alphanumeric + hyphens", () => {
		assert.equal(isValidSkillName("commit"), true);
		assert.equal(isValidSkillName("resolve-pr-conflicts"), true);
		assert.equal(isValidSkillName("a"), true);
		assert.equal(isValidSkillName("a1-b2"), true);
	});

	it("rejects uppercase, underscores, leading/trailing hyphens, and non-strings", () => {
		assert.equal(isValidSkillName("Commit"), false);
		assert.equal(isValidSkillName("my_skill"), false);
		assert.equal(isValidSkillName("-leading"), false);
		assert.equal(isValidSkillName("trailing-"), false);
		assert.equal(isValidSkillName(""), false);
		assert.equal(isValidSkillName(undefined), false);
		assert.equal(isValidSkillName(42), false);
	});
});

describe("serializeSkillFile", () => {
	it("writes name/description frontmatter and the body below it", () => {
		const out = serializeSkillFile({ name: "my-skill", description: "Does a thing", content: "Do the thing." });
		assert.match(out, /^---\n/);
		assert.match(out, /name: my-skill/);
		assert.match(out, /description: Does a thing/);
		assert.match(out, /\nDo the thing\.\n$/);
	});

	it("includes argument-hint and allowed-tools only when provided", () => {
		const bare = serializeSkillFile({ name: "n", description: "d", content: "c" });
		assert.doesNotMatch(bare, /argument-hint/);
		assert.doesNotMatch(bare, /allowed-tools/);

		const full = serializeSkillFile({
			name: "n",
			description: "d",
			content: "c",
			argumentHint: "[push]",
			allowedTools: ["bash", "bash_bg"],
		});
		assert.match(full, /argument-hint: .?\[push\].?/);
		assert.match(full, /allowed-tools: bash, bash_bg/);
	});
});

describe("writeSkillFile", () => {
	it("writes skills/<name>/SKILL.md and round-trips through scanSkillDir", async () => {
		const { filePath } = await writeSkillFile(configDir, {
			name: "roundtrip-skill",
			description: "A round-trip test skill",
			content: "Do the round-trip thing.\n",
		});
		assert.equal(filePath, path.join(configDir, "skills", "roundtrip-skill", "SKILL.md"));
		assert.ok(fs.existsSync(filePath));

		const scanned = scanSkillDir(path.join(configDir, "skills"), "project");
		const found = scanned.find((s) => s.name === "roundtrip-skill");
		assert.ok(found, "written skill must be discoverable by scanSkillDir");
		assert.equal(found!.description, "A round-trip test skill");
		// The blank line separating frontmatter from body (matching the
		// existing .claude/skills/*/SKILL.md convention) means the parsed
		// content carries a leading newline — same as any hand-authored skill.
		assert.equal(found!.content, "\nDo the round-trip thing.\n");
	});

	it("rejects an invalid name without writing a file", async () => {
		await assert.rejects(
			() => writeSkillFile(configDir, { name: "Not Valid", description: "d", content: "c" }),
			/lowercase alphanumeric/,
		);
		assert.equal(fs.existsSync(path.join(configDir, "skills", "Not Valid")), false);
	});

	it("rejects a missing description or content", async () => {
		await assert.rejects(() => writeSkillFile(configDir, { name: "no-desc", description: "", content: "c" }), /description/);
		await assert.rejects(() => writeSkillFile(configDir, { name: "no-content", description: "d", content: "" }), /content/);
	});

	it("overwrites an existing skill of the same name (update semantics)", async () => {
		await writeSkillFile(configDir, { name: "updatable", description: "v1", content: "first\n" });
		await writeSkillFile(configDir, { name: "updatable", description: "v2", content: "second\n" });
		const scanned = scanSkillDir(path.join(configDir, "skills"), "project");
		const found = scanned.find((s) => s.name === "updatable");
		assert.equal(found!.description, "v2");
		assert.equal(found!.content, "\nsecond\n");
	});
});
