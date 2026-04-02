/**
 * Unit tests for GateVerificationLive and VerificationOutputModal markdown rendering.
 *
 * Tests the rendering decision: step.type !== "command" renders <markdown-block>,
 * step.type === "command" renders <pre> with optional ANSI-to-HTML.
 * Also tests modal body element selection and step type propagation.
 *
 * Pattern: file:// fixture with window-exposed functions, evaluated in page context.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const TEST_PAGE = `file://${path.resolve("tests/fixtures/gate-verification-markdown.html")}`;

test.describe("GateVerificationLive step output rendering", () => {

	test("llm-review step renders markdown-block, not pre", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const element = await page.evaluate(() => {
			return (window as any).stepOutputElement("llm-review");
		});

		expect(element).toBe("markdown-block");
	});

	test("agent-qa step renders markdown-block, not pre", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const element = await page.evaluate(() => {
			return (window as any).stepOutputElement("agent-qa");
		});

		expect(element).toBe("markdown-block");
	});

	test("command step renders pre, not markdown-block", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const element = await page.evaluate(() => {
			return (window as any).stepOutputElement("command");
		});

		expect(element).toBe("pre");
	});

	test("unknown future step type renders markdown-block (future-proof)", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const element = await page.evaluate(() => {
			return (window as any).stepOutputElement("agent-linter");
		});

		expect(element).toBe("markdown-block");
	});

	test("mixed steps render correct elements for each type", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const results = await page.evaluate(() => {
			const steps = [
				{ name: "Type check", type: "command", output: "All good" },
				{ name: "Code review", type: "llm-review", output: "## Review\n\n- Looks good" },
				{ name: "QA test", type: "agent-qa", output: "## QA\n\nAll tests passed" },
				{ name: "Lint", type: "command", output: "0 errors" },
			];
			return (window as any).renderSteps(steps);
		});

		expect(results).toHaveLength(4);
		// command steps → pre
		expect(results[0].outputElement).toBe("pre");
		expect(results[0].isAgentStep).toBe(false);
		// llm-review → markdown-block
		expect(results[1].outputElement).toBe("markdown-block");
		expect(results[1].isAgentStep).toBe(true);
		// agent-qa → markdown-block
		expect(results[2].outputElement).toBe("markdown-block");
		expect(results[2].isAgentStep).toBe(true);
		// command → pre
		expect(results[3].outputElement).toBe("pre");
		expect(results[3].isAgentStep).toBe(false);
	});
});

test.describe("VerificationOutputModal agent step detection", () => {

	test("isAgentStep returns true for llm-review", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).isAgentStep("llm-review"));
		expect(result).toBe(true);
	});

	test("isAgentStep returns true for agent-qa", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).isAgentStep("agent-qa"));
		expect(result).toBe(true);
	});

	test("isAgentStep returns false for command", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).isAgentStep("command"));
		expect(result).toBe(false);
	});

	test("isAgentStep returns false for empty string", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => (window as any).isAgentStep(""));
		expect(result).toBe(false);
	});

	test("modal uses div for agent steps, pre for command steps", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const results = await page.evaluate(() => {
			return {
				llmReview: (window as any).modalBodyElement("llm-review"),
				agentQa: (window as any).modalBodyElement("agent-qa"),
				command: (window as any).modalBodyElement("command"),
				empty: (window as any).modalBodyElement(""),
			};
		});

		expect(results.llmReview).toBe("div");
		expect(results.agentQa).toBe("div");
		expect(results.command).toBe("pre");
		expect(results.empty).toBe("pre");
	});
});

test.describe("Modal step data propagation", () => {

	test("buildModalStep captures step type for modal", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = {
				name: "Code review",
				type: "llm-review",
				output: "## Review\nAll good",
				status: "passed",
			};
			return (window as any).buildModalStep(step, 0, null);
		});

		expect(result.index).toBe(0);
		expect(result.name).toBe("Code review");
		expect(result.output).toBe("## Review\nAll good");
		expect(result.type).toBe("llm-review");
	});

	test("buildModalStep prefers WS-accumulated output over step.output", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = {
				name: "Review",
				type: "llm-review",
				output: "initial output",
			};
			const wsMap = new Map();
			wsMap.set(0, "accumulated streaming output");
			return (window as any).buildModalStep(step, 0, wsMap);
		});

		expect(result.output).toBe("accumulated streaming output");
	});

	test("buildModalStep falls back to step.output when no WS data", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = {
				name: "Review",
				type: "llm-review",
				output: "api output",
			};
			const wsMap = new Map(); // empty map
			return (window as any).buildModalStep(step, 0, wsMap);
		});

		expect(result.output).toBe("api output");
	});

	test("buildModalStep defaults type to empty string when missing", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			const step = { name: "Unknown", output: "some output" };
			return (window as any).buildModalStep(step, 2, null);
		});

		expect(result.type).toBe("");
		expect(result.index).toBe(2);
	});
});

test.describe("ANSI handling for command steps only", () => {

	test("command step with ANSI codes should use ANSI rendering", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldUseAnsi("command", "Tests: \x1b[32m12 passed\x1b[0m");
		});

		expect(result).toBe(true);
	});

	test("command step without ANSI codes should not use ANSI rendering", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldUseAnsi("command", "Tests: 12 passed");
		});

		expect(result).toBe(false);
	});

	test("agent step never uses ANSI rendering even with ANSI codes", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldUseAnsi("llm-review", "Some \x1b[31mtext\x1b[0m");
		});

		expect(result).toBe(false);
	});

	test("agent-qa step never uses ANSI rendering", async ({ page }) => {
		await page.goto(TEST_PAGE);

		const result = await page.evaluate(() => {
			return (window as any).shouldUseAnsi("agent-qa", "\x1b[32mgreen\x1b[0m text");
		});

		expect(result).toBe(false);
	});
});
