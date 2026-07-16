import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyGitTemplate, prepareGitTemplate } from "./git-template.js";

const root = mkdtempSync(join(tmpdir(), "bb-git-template-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("git template", () => {
	it("prepares one configured master repository per fork", async () => {
		const first = await prepareGitTemplate();
		const second = await prepareGitTemplate();
		expect(second).toBe(first);
		expect(readFileSync(join(first, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
		const config = readFileSync(join(first, ".git", "config"), "utf8");
		expect(config).toMatch(/name = Bobbit Test/);
		expect(config).toMatch(/email = bobbit-test@example\.invalid/);
		expect(config).toMatch(/autocrlf = false/);
		expect(readFileSync(join(first, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
	});

	it("creates independent writable copies without modifying the source", async () => {
		const source = await prepareGitTemplate();
		const copyOne = copyGitTemplate(join(root, "one"));
		writeFileSync(join(copyOne, "README.md"), "changed\n", "utf8");
		const copyTwo = copyGitTemplate(join(root, "two"));

		expect(readFileSync(join(copyOne, "README.md"), "utf8")).toBe("changed\n");
		expect(readFileSync(join(copyTwo, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(source, "README.md"), "utf8")).toBe("# Bobbit test repository\n");
		expect(readFileSync(join(copyTwo, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
	});

	it("refuses to merge a template into a non-empty destination", async () => {
		await prepareGitTemplate();
		const occupied = join(root, "occupied");
		writeFileSync(occupied, "occupied", "utf8");
		expect(() => copyGitTemplate(occupied)).toThrow(/destination must be an empty directory or absent/);
	});
});
