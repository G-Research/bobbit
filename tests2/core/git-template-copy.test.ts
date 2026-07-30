import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.js";

const root = mkdtempSync(join(tmpdir(), "bb-git-template-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("setup-prepared git template", () => {
	it("reuses the configured master repository prepared before the spawn guard", async () => {
		const first = await prepareGitTemplate();
		const second = await prepareGitTemplate();
		expect(second).toBe(first);
		expect(readFileSync(join(first, ".git", "HEAD"), "utf8").trim()).toBe("ref: refs/heads/master");
		const config = readFileSync(join(first, ".git", "config"), "utf8");
		expect(config).toMatch(/name = Bobbit Test/);
		expect(config).toMatch(/email = bobbit-test@example\.invalid/);
		expect(config).toMatch(/autocrlf = false/);
		// These local settings prevent the commit that built the template and Git
		// commands in its copies from starting automatic maintenance. In particular,
		// no background process may briefly add .git/objects/maintenance.lock after
		// the immutable tree has been hashed.
		expect(config).toMatch(/\[maintenance\][\s\S]*?auto = false/);
		expect(config).toMatch(/\[gc\][\s\S]*?auto = 0/);
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

	it("rejects arbitrary template mutations rather than filtering hash changes", async () => {
		const source = await prepareGitTemplate();
		const unexpected = join(source, ".git", "objects", "unexpected-template-state");
		writeFileSync(unexpected, "must not be ignored", "utf8");
		try {
			expect(() => copyGitTemplate(join(root, "rejected-mutation"))).toThrow(/immutable template was modified/);
		} finally {
			rmSync(unexpected, { force: true });
		}
		expect(() => copyGitTemplate(join(root, "restored-source"))).not.toThrow();
	});

	it("refuses to merge a template into a non-empty destination", async () => {
		await prepareGitTemplate();
		const occupied = join(root, "occupied");
		writeFileSync(occupied, "occupied", "utf8");
		expect(() => copyGitTemplate(occupied)).toThrow(/destination must be an empty directory or absent/);
	});
});
