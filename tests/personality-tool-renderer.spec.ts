/**
 * Unit tests for PersonalitiesListRenderer and PersonalitiesCreateRenderer.
 *
 * Tests the rendering decisions, header text, state resolution, personality
 * list display, and error/skipped handling for both tool renderers.
 *
 * Pattern: file:// fixture with window-exposed functions, evaluated in page context.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/personality-tool-renderer.html")}`;

test.describe("PersonalitiesListRenderer", () => {
	test.beforeEach(async ({ page }) => {
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("loading state shows 'Listing personalities…'", async ({ page }) => {

		const result = await page.evaluate(() => {
			return (window as any).renderList({}, undefined, true);
		});

		expect(result.branch).toBe("loading");
		expect(result.state).toBe("inprogress");
		expect(result.headerText).toBe("Listing personalities…");
	});

	test("loading state without streaming shows complete state", async ({ page }) => {

		const result = await page.evaluate(() => {
			return (window as any).renderList({}, undefined, false);
		});

		expect(result.branch).toBe("loading");
		expect(result.state).toBe("complete");
		expect(result.headerText).toBe("Listing personalities…");
	});

	test("success with personality list shows count and names", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify([
					{ name: "pirate", description: "Talk like a pirate" },
					{ name: "formal", description: "Use formal language" },
					{ name: "friendly", description: "Be warm and friendly" },
				]) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.branch).toBe("success");
		expect(result.state).toBe("complete");
		expect(result.count).toBe(3);
		expect(result.headerText).toBe("3 personalities");
		expect(result.isCollapsible).toBe(true);
		expect(result.defaultExpanded).toBe(false);
		expect(result.personalities).toHaveLength(3);
		expect(result.personalities[0].name).toBe("pirate");
		expect(result.personalities[1].name).toBe("formal");
		expect(result.personalities[2].name).toBe("friendly");
	});

	test("success with single personality uses singular form", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify([
					{ name: "pirate", description: "Talk like a pirate" },
				]) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.count).toBe(1);
		expect(result.headerText).toBe("1 personality");
	});

	test("success with personalities object wrapper", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({
					personalities: [
						{ name: "concise", description: "Keep responses short" },
					]
				}) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.branch).toBe("success");
		expect(result.count).toBe(1);
		expect(result.personalities[0].name).toBe("concise");
	});

	test("empty personality list shows 'No personalities defined'", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify([]) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.branch).toBe("empty");
		expect(result.state).toBe("complete");
		expect(result.headerText).toBe("No personalities defined");
		expect(result.count).toBe(0);
	});

	test("error result shows failure message", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Permission denied" }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("error");
		expect(result.isSkipped).toBe(false);
		expect(result.headerText).toBe("Personality list failed");
		expect(result.errorText).toBe("Permission denied");
		expect(result.errorClass).toBe("text-destructive");
	});

	test("skipped/aborted result shows warning styling", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Skipped due to queued user message" }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("warning");
		expect(result.isSkipped).toBe(true);
		expect(result.headerText).toBe("Aborted personality list");
		expect(result.errorClass).toContain("text-amber");
	});

	test("long description is truncated to 50 chars", async ({ page }) => {

		const result = await page.evaluate(() => {
			const longDesc = "A".repeat(60);
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify([
					{ name: "verbose", description: longDesc },
				]) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.personalities[0].description.length).toBeLessThanOrEqual(51); // 50 + ellipsis
		expect(result.personalities[0].description).toContain("…");
	});

	test("missing description shows empty string", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify([
					{ name: "minimal" },
				]) }],
			};
			return (window as any).renderList({}, mockResult, false);
		});

		expect(result.personalities[0].description).toBe("");
	});
});

test.describe("PersonalitiesCreateRenderer", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("loading state shows 'Creating personality <name>'", async ({ page }) => {

		const result = await page.evaluate(() => {
			return (window as any).renderCreate({ name: "pirate", description: "Talk like a pirate" }, undefined, true);
		});

		expect(result.branch).toBe("loading");
		expect(result.state).toBe("inprogress");
		expect(result.name).toBe("pirate");
		expect(result.headerText).toBe("Creating personality pirate");
		expect(result.description).toBe("Talk like a pirate");
	});

	test("loading state defaults name to 'personality' when missing", async ({ page }) => {

		const result = await page.evaluate(() => {
			return (window as any).renderCreate({}, undefined, true);
		});

		expect(result.name).toBe("personality");
		expect(result.headerText).toBe("Creating personality personality");
	});

	test("success shows 'Created personality <name>'", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: false,
				content: [{ type: "text", text: JSON.stringify({ status: "ok" }) }],
			};
			return (window as any).renderCreate({ name: "formal", description: "Use formal language" }, mockResult, false);
		});

		expect(result.branch).toBe("success");
		expect(result.state).toBe("complete");
		expect(result.name).toBe("formal");
		expect(result.headerText).toBe("Created personality formal");
		expect(result.description).toBe("Use formal language");
	});

	test("error result shows failure message", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Name already exists" }],
			};
			return (window as any).renderCreate({ name: "pirate" }, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("error");
		expect(result.isSkipped).toBe(false);
		expect(result.headerText).toBe("Failed to create personality pirate");
		expect(result.errorText).toBe("Name already exists");
		expect(result.errorClass).toBe("text-destructive");
	});

	test("skipped/aborted result shows warning styling", async ({ page }) => {

		const result = await page.evaluate(() => {
			const mockResult = {
				isError: true,
				content: [{ type: "text", text: "Skipped due to queued user message" }],
			};
			return (window as any).renderCreate({ name: "friendly" }, mockResult, false);
		});

		expect(result.branch).toBe("error");
		expect(result.state).toBe("warning");
		expect(result.isSkipped).toBe(true);
		expect(result.headerText).toBe("Aborted creation of personality friendly");
		expect(result.errorClass).toContain("text-amber");
	});

	test("long description is truncated to 60 chars", async ({ page }) => {

		const result = await page.evaluate(() => {
			const longDesc = "B".repeat(80);
			return (window as any).renderCreate({ name: "test", description: longDesc }, undefined, true);
		});

		expect(result.description.length).toBeLessThanOrEqual(61); // 60 + ellipsis
		expect(result.description).toContain("…");
	});

	test("no description param yields empty description", async ({ page }) => {

		const result = await page.evaluate(() => {
			return (window as any).renderCreate({ name: "test" }, undefined, true);
		});

		expect(result.description).toBe("");
	});
});

test.describe("getToolState shared logic", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any)._testReady === true);
	});

	test("returns correct states for all cases", async ({ page }) => {

		const states = await page.evaluate(() => {
			const fn = (window as any).getToolState;
			return {
				streaming: fn(undefined, true),
				noResultNoStream: fn(undefined, false),
				success: fn({ isError: false, content: [] }, false),
				error: fn({ isError: true, content: [{ type: "text", text: "Error" }] }, false),
				skipped: fn({ isError: true, content: [{ type: "text", text: "Skipped due to queued user message" }] }, false),
			};
		});

		expect(states.streaming).toBe("inprogress");
		expect(states.noResultNoStream).toBe("complete");
		expect(states.success).toBe("complete");
		expect(states.error).toBe("error");
		expect(states.skipped).toBe("warning");
	});
});
