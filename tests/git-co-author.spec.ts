import { test, expect } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function fixtureUrl(name: string) {
	return "file:///" + path.join(__dirname, "fixtures", name).replace(/\\/g, "/");
}

test.describe("injectCoAuthorTrailer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(fixtureUrl("git-co-author.html"));
	});

	async function inject(
		page: any,
		command: string,
		modelName: string = "Claude Sonnet 4.6 (aws)",
	) {
		return page.evaluate(
			([cmd, model]: [string, string]) => {
				return (window as any).injectCoAuthorTrailer(cmd, model);
			},
			[command, modelName],
		);
	}

	test("appends trailer to simple git commit", async ({ page }) => {
		const result = await inject(page, 'git commit -m "msg"');
		expect(result).toContain(
			'--trailer "Co-Authored-By: Bobbit (Claude Sonnet 4.6 (aws)) <noreply@bobbit.dev>"',
		);
	});

	test("uses plain Bobbit when no model name", async ({ page }) => {
		const result = await inject(page, 'git commit -m "msg"', "");
		expect(result).toContain(
			'--trailer "Co-Authored-By: Bobbit <noreply@bobbit.dev>"',
		);
	});

	test("handles chained commands", async ({ page }) => {
		const result = await inject(page, 'git add . && git commit -m "msg"');
		expect(result).toContain("git add .");
		expect(result).toContain("--trailer");
	});

	test("does not modify git log", async ({ page }) => {
		const result = await inject(page, "git log --oneline");
		expect(result).toBe("git log --oneline");
	});

	test("does not modify git merge", async ({ page }) => {
		const result = await inject(page, "git merge --no-edit");
		expect(result).toBe("git merge --no-edit");
	});

	test("does not modify git revert", async ({ page }) => {
		const result = await inject(page, "git revert HEAD");
		expect(result).toBe("git revert HEAD");
	});

	test("does not modify git cherry-pick", async ({ page }) => {
		const result = await inject(page, "git cherry-pick abc123");
		expect(result).toBe("git cherry-pick abc123");
	});

	test("skips if already has Co-Authored-By trailer", async ({ page }) => {
		const cmd = 'git commit -m "msg" --trailer "Co-Authored-By: Someone"';
		const result = await inject(page, cmd);
		expect(result).toBe(cmd);
	});

	test("handles git commit --amend", async ({ page }) => {
		const result = await inject(page, "git commit --amend");
		expect(result).toContain("--trailer");
	});

	test("handles git commit --amend -m", async ({ page }) => {
		const result = await inject(page, 'git commit --amend -m "new msg"');
		expect(result).toContain("--trailer");
	});

	test("handles piped input", async ({ page }) => {
		const result = await inject(page, "echo msg | git commit -F -");
		expect(result).toContain("--trailer");
	});

	test("does not match git log --grep=commit", async ({ page }) => {
		const result = await inject(page, "git log --grep=commit");
		expect(result).toBe("git log --grep=commit");
	});

	test("modifies only commit in chained git diff && git commit", async ({
		page,
	}) => {
		const result = await inject(page, 'git diff && git commit -m "x"');
		expect(result).toMatch(/^git diff && git commit/);
		expect(result).toContain("--trailer");
	});
});
