/**
 * Retained spawned-gateway smoke for Children tool renderer registration.
 * Detailed renderer output/action matrices live in tests/children-tool-renderers.spec.ts.
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

async function mountTool(page: any, toolName: string, params: any, result: any): Promise<void> {
	await page.waitForFunction(() => (window as any).__bobbitRenderTool && (window as any).__bobbitLitRender, null, { timeout: 10_000 });
	await page.evaluate(async ({ toolName, params, result }: any) => {
		let host = document.getElementById("e2e-render-host");
		if (!host) {
			host = document.createElement("div");
			host.id = "e2e-render-host";
			host.setAttribute("data-testid", "e2e-render-host");
			document.body.appendChild(host);
		}
		host.innerHTML = "";
		const renderOnce = () => {
			const out = (window as any).__bobbitRenderTool(toolName, params, result, false, {});
			(window as any).__bobbitLitRender(out.content, host);
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
	}, { toolName, params, result });
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
	test("goal_spawn_child renderer is registered in the real app @smoke", async ({ page }) => {
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
});
