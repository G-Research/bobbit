import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/markdown-throttle.html");
const BUNDLE = path.resolve("tests/fixtures/markdown-throttle-bundle.js");
const ENTRY = path.resolve("tests/fixtures/markdown-throttle-entry.ts");

test.beforeAll(() => {
	// Build the test bundle — bundles AssistantMessage + MarkdownBlock for file:// use
	const srcDir = path.resolve("src/ui/components/Messages.ts");
	const entryMtime = Math.max(fs.statSync(ENTRY).mtimeMs, fs.statSync(srcDir).mtimeMs);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;

	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				'--alias:pdfjs-dist=./tests/fixtures/empty-shim',
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const TEST_PAGE = `file://${FIXTURE}`;

test.describe("AssistantMessage markdown-block content throttling", () => {
	test("streaming updates are throttled to markdown-block", async ({ page }) => {
		await page.goto(TEST_PAGE);

		// Wait for custom elements to register
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

		const updateCount = 15;

		// Track how many times markdown-block.content actually changes
		const changeCount = await page.evaluate(async (updates: number) => {
			const container = document.getElementById("container")!;

			// Create the assistant-message element
			const el = document.createElement("assistant-message") as any;
			el.isStreaming = true;
			el.message = {
				role: "assistant",
				content: [{ type: "text", text: "initial" }],
				stopReason: null,
			};
			container.appendChild(el);

			// Wait for initial render
			await el.updateComplete;

			let changes = 0;
			let lastContent = "";

			// Simulate streaming: update text content multiple times
			for (let i = 0; i < updates; i++) {
				const newText = "Hello world ".repeat(i + 1) + `update-${i}`;
				el.message = {
					...el.message,
					content: [{ type: "text", text: newText }],
				};

				// Request Lit re-render and wait for it
				el.requestUpdate();
				await el.updateComplete;

				// Check the markdown-block content
				const mb = el.querySelector("markdown-block");
				if (mb) {
					const current = mb.content;
					if (current !== lastContent) {
						changes++;
						lastContent = current;
					}
				}
			}

			return changes;
		}, updateCount);

		// With throttling, markdown-block should NOT update on every render.
		// changeCount should be significantly less than updateCount.
		// Without the fix, this FAILS because changeCount === updateCount (no throttle).
		expect(changeCount).toBeLessThan(updateCount);
	});

	test("final content is accurate after streaming stops", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

		const finalText = await page.evaluate(async () => {
			const container = document.getElementById("container")!;

			const el = document.createElement("assistant-message") as any;
			el.isStreaming = true;
			el.message = {
				role: "assistant",
				content: [{ type: "text", text: "start" }],
				stopReason: null,
			};
			container.appendChild(el);
			await el.updateComplete;

			// Simulate several streaming updates
			for (let i = 0; i < 10; i++) {
				el.message = {
					...el.message,
					content: [{ type: "text", text: `streaming update ${i}` }],
				};
				el.requestUpdate();
				await el.updateComplete;
			}

			// Stop streaming — set final content
			const expectedFinal = "This is the final complete message with all content.";
			el.isStreaming = false;
			el.message = {
				role: "assistant",
				content: [{ type: "text", text: expectedFinal }],
				stopReason: "stop",
			};
			el.requestUpdate();
			await el.updateComplete;

			const mb = el.querySelector("markdown-block");
			return mb?.content ?? null;
		});

		// Final content must always be accurate regardless of throttling
		expect(finalText).toBe("This is the final complete message with all content.");
	});

	test("content identity resets across different messages", async ({ page }) => {
		await page.goto(TEST_PAGE);
		await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });

		const result = await page.evaluate(async () => {
			const container = document.getElementById("container")!;

			const el = document.createElement("assistant-message") as any;
			el.isStreaming = true;
			el.message = {
				role: "assistant",
				content: [{ type: "text", text: "first message" }],
				stopReason: null,
			};
			container.appendChild(el);
			await el.updateComplete;

			const mb1Content = el.querySelector("markdown-block")?.content;

			// Switch to a completely new message
			el.message = {
				role: "assistant",
				content: [{ type: "text", text: "second message" }],
				stopReason: null,
			};
			el.requestUpdate();
			await el.updateComplete;

			const mb2Content = el.querySelector("markdown-block")?.content;

			return { first: mb1Content, second: mb2Content };
		});

		expect(result.first).toBe("first message");
		expect(result.second).toBe("second message");
	});
});
