/**
 * Browser E2E for the nine Children tool renderers.
 *
 * Opens the app, sets the subgoals flag ON, then mounts each renderer
 * directly via the in-page `renderTool()` function into a sandbox <div>.
 * This decouples the test from the goal-creation / session-stream pipeline
 * (which is exercised by other E2Es).
 *
 * Reference pattern: tests/e2e/ui/settings.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

async function setSubgoalsFlag(value: boolean): Promise<void> {
	const resp = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(resp.status).toBe(200);
}

/** Inject a #e2e-render-host <div> into the DOM and render the given tool
 *  call/result through the production renderTool() pipeline. */
async function mountTool(
	page: any,
	toolName: string,
	params: any,
	result: any,
	ctx: any = {},
): Promise<void> {
	await page.waitForFunction(() => (window as any).__bobbitRenderTool && (window as any).__bobbitLitRender, null, { timeout: 10_000 });
	await page.evaluate(async ({ toolName, params, result, ctx }: any) => {
		let host = document.getElementById("e2e-render-host");
		if (!host) {
			host = document.createElement("div");
			host.id = "e2e-render-host";
			host.setAttribute("data-testid", "e2e-render-host");
			document.body.appendChild(host);
		}
		host.innerHTML = "";
		const renderTool = (window as any).__bobbitRenderTool;
		const litRender = (window as any).__bobbitLitRender;
		const renderOnce = () => {
			const out = renderTool(toolName, params, result, false, ctx);
			litRender(out.content, host);
		};
		renderOnce();
		if (!host.querySelector("[data-lazy-renderer-placeholder-btn]")) return;
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(() => reject(new Error(`lazy renderer ${toolName} did not load`)), 10_000);
			const onLoaded = (event: Event) => {
				if ((event as CustomEvent).detail?.toolName !== toolName) return;
				window.clearTimeout(timeout);
				document.removeEventListener("bobbit-tool-renderer-loaded", onLoaded);
				resolve();
			};
			document.addEventListener("bobbit-tool-renderer-loaded", onLoaded);
		});
		renderOnce();
	}, { toolName, params, result, ctx });
}

function makeResult(payload: any) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "x",
		isError: false,
		content: [{ type: "text", text: JSON.stringify(payload) }],
		timestamp: Date.now(),
	};
}

test.describe("Children tool renderers", () => {
	test("goal_spawn_child renders title + planId data-testids @smoke", async ({ page }) => {
		await setSubgoalsFlag(true);
		await openApp(page);
		await mountTool(page,
			"goal_spawn_child",
			{ title: "Add login", planId: "plan-1", spec: "Implement the login flow." },
			makeResult({ id: "g-deadbeef-1234" }),
		);

		const host = page.locator("#e2e-render-host");
		await expect(host.locator("[data-testid='children-spawn-title']")).toHaveText("Add login", { timeout: 10_000 });
		await expect(host.locator("[data-testid='children-spawn-planid']")).toHaveText("plan-1");
	});

	test("goal_plan_propose renders step rows + classification badge", async ({ page }) => {
		await setSubgoalsFlag(true);
		await openApp(page);
		await mountTool(page,
			"goal_plan_propose",
			{ steps: [
				{ phase: "do", title: "Step A", spec: "A" },
				{ phase: "verify", title: "Step B", spec: "B" },
			] },
			makeResult({ classification: "fix-up", applied: true }),
		);

		const host = page.locator("#e2e-render-host");
		const rows = host.locator("[data-testid='children-plan-step-row']");
		await expect(rows.first()).toBeVisible({ timeout: 10_000 });
		expect(await rows.count()).toBe(2);
		await expect(host.locator("[data-testid='children-classification-badge']")).toHaveText("fix-up");
	});

	test("goal_plan_propose with requiresApproval shows Approve+Reject buttons", async ({ page }) => {
		await setSubgoalsFlag(true);
		await openApp(page);
		await mountTool(page,
			"goal_plan_propose",
			{ steps: [{ phase: "do", title: "X", spec: "y" }] },
			makeResult({ classification: "expansion", requiresApproval: true, requestId: "req-e2e-1" }),
			{ goalId: "goal-e2e-1" },
		);

		const host = page.locator("#e2e-render-host");
		const approve = host.locator("[data-testid='children-mutation-approve']");
		const reject = host.locator("[data-testid='children-mutation-reject']");
		await expect(approve).toBeVisible({ timeout: 5_000 });
		await expect(approve).toBeEnabled();
		await expect(reject).toBeVisible();
		await expect(reject).toBeEnabled();
	});

	test("Approve click POSTs /api/goals/:id/mutation/:reqId/decision with {decision:'approve'} → Approved pill", async ({ page }) => {
		await setSubgoalsFlag(true);
		await openApp(page);

		// Intercept BEFORE mounting so the click definitely hits the route handler.
		await page.route("**/api/goals/goal-e2e-2/mutation/req-e2e-2/decision", async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({ applied: true }),
			});
		});

		await mountTool(page,
			"goal_plan_propose",
			{ steps: [{ phase: "do", title: "X", spec: "y" }] },
			makeResult({ classification: "expansion", requiresApproval: true, requestId: "req-e2e-2" }),
			{ goalId: "goal-e2e-2" },
		);

		const host = page.locator("#e2e-render-host");
		const approve = host.locator("[data-testid='children-mutation-approve']");
		await expect(approve).toBeVisible({ timeout: 5_000 });

		const respPromise = page.waitForResponse(
			(r: any) => r.url().includes("/api/goals/goal-e2e-2/mutation/req-e2e-2/decision") && r.request().method() === "POST",
			{ timeout: 10_000 },
		);
		await approve.click();
		const resp = await respPromise;
		expect(JSON.parse(resp.request().postData() || "{}")).toEqual({ decision: "approve" });

		await expect(host.locator("[data-testid='children-mutation-decided']")).toHaveText(/Approved/, { timeout: 5_000 });
	});
});
