/**
 * Tests for MessageEditor slash skill autocomplete with intra-prompt support.
 * Stories 31, 33, 34.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/message-editor-slash.html").replace(/\\/g, "/")}`;

test.describe("Slash autocomplete", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("story 31: typing / shows menu, /tes filters uniquely, Enter selects", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "/" — menu should appear with all skills
		await textarea.pressSequentially("/");
		await page.waitForFunction(() => (window as any).isMenuOpen());
		const allSkills = await page.evaluate(() => (window as any).getFilteredSkills());
		expect(allSkills.length).toBeGreaterThan(0);
		expect(allSkills).toContain("deploy");
		expect(allSkills).toContain("status");
		expect(allSkills).toContain("test");

		// Type "tes" to filter — should uniquely match "test"
		await textarea.pressSequentially("tes");
		await page.waitForFunction(() => {
			const skills = (window as any).getFilteredSkills();
			return skills.length === 1 && skills[0] === "test";
		});

		// Press Enter to select "test"
		await page.keyboard.press("Enter");
		const val = await textarea.inputValue();
		expect(val).toBe("/test "); // trailing space after skill name
		// Menu should be closed
		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(false);
	});

	test("story 33: intra-prompt slash — hello /sk shows menu, select replaces in-place", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "hello " first
		await textarea.pressSequentially("hello ");

		// Type "/sk" — menu should appear for skill-name
		await textarea.pressSequentially("/sk");
		await page.waitForFunction(() => (window as any).isMenuOpen());
		const filtered = await page.evaluate(() => (window as any).getFilteredSkills());
		expect(filtered).toContain("skill-name");

		// Select the skill
		await page.keyboard.press("Enter");
		const val = await textarea.inputValue();
		// "hello " preserved, "/sk" replaced with "/skill-name "
		expect(val).toBe("hello /skill-name ");

		// Cursor should be positioned after the inserted skill name
		const cursorPos = await textarea.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
		expect(cursorPos).toBe("hello /skill-name ".length);

		// Menu should be closed
		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(false);
	});

	test("story 33: intra-prompt slash preserves text after cursor", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Set value with text on both sides of where we'll type the slash command
		await textarea.evaluate((el: HTMLTextAreaElement) => {
			el.value = "hello  the code";
			// Position cursor after "hello " (index 6)
			el.setSelectionRange(6, 6);
			el.dispatchEvent(new Event("input"));
		});

		// Type "/sk"
		await textarea.pressSequentially("/sk");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		// Select skill-name
		await page.keyboard.press("Enter");
		const val = await textarea.inputValue();
		expect(val).toBe("hello /skill-name  the code");
	});

	test("story 34: menu left offset > 0 when slash is mid-line", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "hello /dep" — the slash is after "hello "
		await textarea.pressSequentially("hello /dep");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		const menuLeft = await page.evaluate(() => (window as any).getSlashMenuLeftOffset());
		// "hello " text should produce a non-zero left offset
		expect(menuLeft).toBeGreaterThan(0);

		// Verify the menu's CSS margin-left matches
		const menuStyle = await page.locator(".slash-menu").evaluate(
			(el: HTMLElement) => el.style.marginLeft,
		);
		expect(parseFloat(menuStyle)).toBeGreaterThan(0);
	});

	test("story 34: menu at position 0 when slash is at start of line", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type just "/dep" at the start
		await textarea.pressSequentially("/dep");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		const menuLeft = await page.evaluate(() => (window as any).getSlashMenuLeftOffset());
		expect(menuLeft).toBe(0);
	});

	test("Tab also selects from autocomplete", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "/tes" which uniquely matches "test"
		await textarea.pressSequentially("/tes");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		const filtered = await page.evaluate(() => (window as any).getFilteredSkills());
		expect(filtered).toContain("test");

		await page.keyboard.press("Tab");
		const val = await textarea.inputValue();
		expect(val).toBe("/test ");
		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(false);
	});

	test("Escape closes menu without selecting", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		await textarea.pressSequentially("/dep");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		await page.keyboard.press("Escape");
		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(false);
		// Text should remain as-is
		expect(await textarea.inputValue()).toBe("/dep");
	});

	test("ArrowDown/ArrowUp navigate menu items", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		await textarea.pressSequentially("/dep");
		await page.waitForFunction(() => (window as any).isMenuOpen());

		// First item is selected by default (index 0)
		let idx = await page.evaluate(() => (window as any).getSelectedIndex());
		expect(idx).toBe(0);

		// ArrowDown selects next
		await page.keyboard.press("ArrowDown");
		idx = await page.evaluate(() => (window as any).getSelectedIndex());
		expect(idx).toBe(1);

		// ArrowUp goes back
		await page.keyboard.press("ArrowUp");
		idx = await page.evaluate(() => (window as any).getSelectedIndex());
		expect(idx).toBe(0);
	});

	test("no menu when slash is not at word boundary", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "hello/dep" — no space before slash
		await textarea.pressSequentially("hello/dep");

		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(false);
	});

	test("slash after newline triggers menu", async ({ page }) => {
		const textarea = page.locator("#textarea");
		await textarea.click();

		// Type "line1\n/dep"
		await textarea.evaluate((el: HTMLTextAreaElement) => {
			el.value = "line1\n/dep";
			el.setSelectionRange(10, 10);
			el.dispatchEvent(new Event("input"));
		});

		const menuOpen = await page.evaluate(() => (window as any).isMenuOpen());
		expect(menuOpen).toBe(true);
	});
});
