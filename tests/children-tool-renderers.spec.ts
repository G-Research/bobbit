/**
 * Renderer-level unit tests for the nine Children tools.
 * Mounts each renderer in a file:// fixture and asserts on rendered DOM.
 * Mirrors tests/preview-renderer.spec.ts in style.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/children-tool-renderers.html");
const BUNDLE = path.resolve("tests/fixtures/children-tool-renderers-bundle.js");
const ENTRY = path.resolve("tests/fixtures/children-tool-renderers-entry.ts");

const RENDERER_FILES = [
	"src/ui/tools/renderers/GoalSpawnChildRenderer.ts",
	"src/ui/tools/renderers/GoalPlanProposeRenderer.ts",
	"src/ui/tools/renderers/GoalPlanStatusRenderer.ts",
	"src/ui/tools/renderers/GoalMergeChildRenderer.ts",
	"src/ui/tools/renderers/GoalPauseResumeRenderer.ts",
	"src/ui/tools/renderers/GoalArchiveChildRenderer.ts",
	"src/ui/tools/renderers/GoalDecideMutationRenderer.ts",
	"src/ui/tools/renderers/GoalSetPolicyRenderer.ts",
	"src/ui/tools/renderers/children-renderer-helpers.ts",
	"src/ui/lazy/children-mutation-approval.ts",
	"src/ui/lazy/children-goal-state-pill.ts",
].map(f => path.resolve(f));

test.beforeAll(() => {
	buildBundle({ entry: ENTRY, outfile: BUNDLE, deps: [ENTRY, ...RENDERER_FILES] });
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, { timeout: 10_000 });
	// Reset state between tests for safety.
	await page.evaluate(() => { (window as any).__setFlag(true); (window as any).__resetFetchCalls(); });
}

function makeResult(data: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "x",
		isError,
		content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
		timestamp: Date.now(),
	};
}

test.describe("Children tool renderers — streaming/success/error per tool", () => {
	const tools = [
		"goal_spawn_child", "goal_plan_propose", "goal_plan_status", "goal_merge_child",
		"goal_pause", "goal_resume", "goal_archive_child", "goal_decide_mutation", "goal_set_policy",
	];
	for (const name of tools) {
		test(`${name}: streaming renders header`, async ({ page }) => {
			await gotoAndWait(page);
			await page.evaluate((tool) => {
				(window as any).__renderChildren(tool, document.getElementById("container"), {}, undefined, true);
			}, name);
			// Loader spinner present (renderHeader's inprogress state)
			await expect(page.locator("#container .animate-spin")).toHaveCount(1);
		});

		test(`${name}: error result renders destructive text`, async ({ page }) => {
			await gotoAndWait(page);
			await page.evaluate((tool) => {
				(window as any).__renderChildren(tool, document.getElementById("container"), {}, {
					role: "toolResult", toolCallId: "t1", toolName: tool,
					isError: true, content: [{ type: "text", text: "boom" }], timestamp: 0,
				}, false);
			}, name);
			const destructiveCount = await page.locator("#container .text-destructive").count();
			expect(destructiveCount).toBeGreaterThan(0);
			await expect(page.locator("#container")).toContainText("boom");
		});
	}
});

test.describe("goal_spawn_child", () => {
	test("success renders title + planId data-testids + state pill", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_spawn_child", document.getElementById("container"),
				{ title: "Add login", planId: "p-1", spec: "Build login flow" },
				(window as any).__mk?.({ id: "g-deadbeef-1234" }) ?? {
					role: "toolResult", toolCallId: "t1", toolName: "goal_spawn_child",
					isError: false, content: [{ type: "text", text: JSON.stringify({ id: "g-deadbeef-1234" }) }], timestamp: 0,
				},
				false);
		});
		await expect(page.locator('[data-testid="children-spawn-title"]')).toHaveText("Add login");
		await expect(page.locator('[data-testid="children-spawn-planid"]')).toHaveText("p-1");
		await expect(page.locator('children-goal-state-pill')).toHaveCount(1);
	});
});

test.describe("goal_plan_propose", () => {
	test("renders step rows for plain proposal", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [
					{ phase: "do", title: "Step A", spec: "spec A" },
					{ phase: "do", title: "Step B", spec: "spec B" },
				] },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
					isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "fix-up", applied: true }) }], timestamp: 0 },
				false);
		});
		await expect(page.locator('[data-testid="children-plan-step-row"]')).toHaveCount(2);
		await expect(page.locator('[data-testid="children-classification-badge"]')).toHaveText("fix-up");
		await expect(page.locator('[data-testid="children-applied-pill"]')).toBeVisible();
	});

	test("criteria-drop classification shows red banner", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [{ phase: "do", title: "X", spec: "y" }] },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
					isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "criteria-drop" }) }], timestamp: 0 },
				false);
		});
		await expect(page.locator('[data-testid="children-criteria-drop-banner"]')).toContainText(/drop acceptance criteria/);
	});

	test("requiresApproval renders <children-mutation-approval> with buttons", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [{ phase: "do", title: "X", spec: "y" }] },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
					isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "expansion", requiresApproval: true, requestId: "req-aaa" }) }], timestamp: 0 },
				false, { goalId: "goal-xyz" });
		});
		await expect(page.locator('children-mutation-approval')).toHaveAttribute("request-id", "req-aaa");
		await expect(page.locator('children-mutation-approval')).toHaveAttribute("goal-id", "goal-xyz");
		await expect(page.locator('[data-testid="children-mutation-approve"]')).toBeVisible();
		await expect(page.locator('[data-testid="children-mutation-reject"]')).toBeVisible();
	});

	test("fallback spawn-children-direct shows spawned list", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [] },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
					isError: false, content: [{ type: "text", text: JSON.stringify({
						fallback: "spawn-children-direct",
						spawned: [
							{ planId: "p1", childGoalId: "abcdef1234" },
							{ planId: "p2", alreadyExists: true },
						],
					}) }], timestamp: 0 },
				false);
		});
		await expect(page.locator('[data-testid="children-fallback-list"]')).toBeVisible();
		await expect(page.locator('[data-testid="children-fallback-list"]')).toContainText("p1");
		await expect(page.locator('[data-testid="children-fallback-list"]')).toContainText("p2");
		await expect(page.locator("#container")).toContainText("fell back to spawn-children-direct");
	});

	test("partial streaming with steps renders rows already complete", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [{ phase: "do", title: "Partial", spec: "spec" }] },
				undefined, true);
		});
		await expect(page.locator('[data-testid="children-plan-step-row"]')).toHaveCount(1);
	});

	test("approve button POSTs decision endpoint with {decision:'approve'} and pill flips", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_plan_propose", document.getElementById("container"),
				{ steps: [{ phase: "do", title: "X", spec: "y" }] },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_plan_propose",
					isError: false, content: [{ type: "text", text: JSON.stringify({ classification: "expansion", requiresApproval: true, requestId: "req-bbb" }) }], timestamp: 0 },
				false, { goalId: "goal-zzz" });
			(window as any).__resetFetchCalls();
		});
		await page.locator('[data-testid="children-mutation-approve"]').click();
		await expect(page.locator('[data-testid="children-mutation-decided"]')).toHaveText(/Approved/, { timeout: 3000 });
		const calls = await page.evaluate(() => (window as any).__getFetchCalls());
		const post = calls.find((c: any) => c.method === "POST" && /mutation\/req-bbb\/decision/.test(c.url));
		expect(post).toBeTruthy();
		expect(JSON.parse(post.body)).toEqual({ decision: "approve" });
	});
});

test.describe("feature flag off → falls through to DefaultRenderer", () => {
	test("goal_spawn_child renders raw JSON code-block when flag off", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__setFlag(false);
			(window as any).__renderChildren("goal_spawn_child", document.getElementById("container"),
				{ title: "T", planId: "p-1" },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_spawn_child",
					isError: false, content: [{ type: "text", text: JSON.stringify({ id: "g-1" }) }], timestamp: 0 },
				false);
		});
		// DefaultRenderer emits a <code-block> for the JSON payload.
		await expect(page.locator("#container code-block")).toHaveCount(2);
		await expect(page.locator('[data-testid="children-spawn-title"]')).toHaveCount(0);
	});
});

test.describe("goal_set_policy", () => {
	test("renders policy row + concurrency bar", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_set_policy", document.getElementById("container"),
				{ divergencePolicy: "balanced", maxConcurrentChildren: 3 },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_set_policy",
					isError: false, content: [{ type: "text", text: "{}" }], timestamp: 0 },
				false);
		});
		await expect(page.locator('[data-testid="children-policy-row"]')).toContainText("balanced");
		await expect(page.locator('[data-testid="children-concurrency-row"]')).toContainText("3");
	});
});

test.describe("goal_decide_mutation", () => {
	test("approved decision + applied response", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_decide_mutation", document.getElementById("container"),
				{ decision: "approve", requestId: "req-cccccccc" },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_decide_mutation",
					isError: false, content: [{ type: "text", text: JSON.stringify({ applied: true }) }], timestamp: 0 },
				false);
		});
		await expect(page.locator("#container")).toContainText("Approved");
		await expect(page.locator("#container")).toContainText(/Applied/);
	});
});

test.describe("goal_merge_child outcome pills", () => {
	test("conflict result shows conflict pill and expandable output", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate((makeResult) => {
			void makeResult;
			(window as any).__renderChildren("goal_merge_child", document.getElementById("container"),
				{ childGoalId: "abc12345xyz" },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_merge_child",
					isError: false, content: [{ type: "text", text: JSON.stringify({ conflict: true, output: "CONFLICT (content)" }) }], timestamp: 0 },
				false);
		}, makeResult.toString());
		await expect(page.locator('[data-testid="children-merge-pill"]')).toContainText(/conflict/);
	});

	test("plain success shows merged pill", async ({ page }) => {
		await gotoAndWait(page);
		await page.evaluate(() => {
			(window as any).__renderChildren("goal_merge_child", document.getElementById("container"),
				{ childGoalId: "abc12345xyz" },
				{ role: "toolResult", toolCallId: "t1", toolName: "goal_merge_child",
					isError: false, content: [{ type: "text", text: JSON.stringify({ ok: true }) }], timestamp: 0 },
				false);
		});
		await expect(page.locator('[data-testid="children-merge-pill"]')).toContainText(/merged/);
	});
});
