import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject, deleteSession } from "../e2e-setup.js";
import { createSessionViaUI, openApp } from "./ui-helpers.js";

// This journey uses the real authenticated browser origin and the real gateway
// route. The mock Pi runtime cannot execute arbitrary tools, so route-level
// gate output is the furthest deterministic fan-out boundary available here.
test.describe.configure({ mode: "serial", retries: 0 });

const PACK_ID = "tool-result-filter-fixture";
const FIXTURE_ROOT = path.resolve("tests2/_fixtures/tool-result-filter");
const REJECTED = "EP14_FIXTURE_REJECT__browser_canary_never_render";
const REDACTED = "EP14_FIXTURE_REDACT__browser_canary_never_render";
const ORDERED = "EP14_FIXTURE_ORDER_EP14_FIXTURE_REJECT__browser_canary_never_render";

type BrowserResponse = { status: number; text: string };

function fixturePackDir(bobbitDir: string): string {
	return path.join(bobbitDir, "config", "market-packs", PACK_ID);
}

function installFixture(bobbitDir: string): string {
	const target = fixturePackDir(bobbitDir);
	fs.rmSync(target, { recursive: true, force: true });
	fs.cpSync(FIXTURE_ROOT, target, { recursive: true });
	fs.writeFileSync(path.join(target, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n", "utf8");
	return target;
}

async function browserApi(page: Page, request: { path: string; method?: string; body?: unknown }): Promise<BrowserResponse> {
	return page.evaluate(async ({ path, method, body }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET", credentials: "include",
			headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

function parse(response: BrowserResponse): any {
	expect(response.status, response.text).toBe(200);
	return JSON.parse(response.text);
}

function rawResult(text: string): Record<string, unknown> {
	return {
		content: [{ type: "text", text }], details: { rawResultCanary: text }, isError: false,
		usage: { inputTokens: 3, outputTokens: 5 },
	};
}

async function grant(page: Page, projectId: string, hookId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants`, method: "PUT",
		body: { packId: PACK_ID, hookId, capability: "filter:tool-result" },
	});
	expect(response.status, response.text).toBe(200);
}

async function revoke(page: Page, projectId: string, hookId: string): Promise<void> {
	const response = await browserApi(page, {
		path: `/api/projects/${encodeURIComponent(projectId)}/extension-grants/${encodeURIComponent(PACK_ID)}/${encodeURIComponent(hookId)}/filter%3Atool-result`, method: "DELETE",
	});
	expect(response.status, response.text).toBe(200);
}

/**
 * Render the exact safe route response through the application's real tool
 * renderer. This existing E2E hook mounts production Lit output in the app;
 * rejected source bytes are never injected into the browser.
 */
async function renderSafeToolResult(page: Page, result: any, suffix: string): Promise<void> {
	await page.waitForFunction(() => (window as any).__bobbitRenderTool && (window as any).__bobbitLitRender);
	await page.evaluate(({ result, suffix }) => {
		const id = `ep14-tool-result-render-host-${suffix}`;
		const host = document.getElementById(id) ?? document.body.appendChild(document.createElement("div"));
		host.id = id;
		const output = (window as any).__bobbitRenderTool("fixture-tool", {}, {
			role: "toolResult", toolCallId: `ep14-browser-tool-${suffix}`, toolName: "fixture-tool",
			content: result.content, isError: result.isError,
		}, false, {});
		(window as any).__bobbitLitRender(output.content, host);
	}, { result, suffix });
}

test.describe("tool result filter", () => {
	let packDir = "";
	let projectId = "";
	let sessionId = "";

	test.beforeAll(async ({ gateway }) => {
		packDir = installFixture(gateway.bobbitDir);
		projectId = (await defaultProject()).id;
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
		});
		expect(activation.status, await activation.text()).toBe(200);
	});
	test.afterAll(async () => { if (packDir) fs.rmSync(packDir, { recursive: true, force: true }); });

	test("browser-origin grant, reject-wins, redact, revoke, and reload expose only safe result bytes", async ({ page }) => {
		const consoleMessages: string[] = [];
		const collectConsole = (message: { type(): string; text(): string }) => {
			consoleMessages.push(`[${message.type()}] ${message.text()}`);
		};
		page.on("console", collectConsole);
		try {
			await openApp(page);
			sessionId = await createSessionViaUI(page);
			const route = `/api/sessions/${encodeURIComponent(sessionId)}/tool-result-filter`;
			const inert = parse(await browserApi(page, { path: route, method: "POST", body: { toolCallId: "inert", toolName: "fixture-tool", result: rawResult(REJECTED) } }));
			expect(inert.content[0].text).toBe(REJECTED);

			await grant(page, projectId, "result-filter");
			await grant(page, projectId, "competing-result-filter");
			const rejected = parse(await browserApi(page, { path: route, method: "POST", body: { toolCallId: "reject", toolName: "fixture-tool", result: rawResult(ORDERED) } }));
			expect(rejected).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
			expect(JSON.stringify(rejected)).not.toContain(ORDERED);
			expect(JSON.stringify(rejected)).not.toContain("EP14_SAFE_COMPETING_REPLACEMENT");

			const redacted = parse(await browserApi(page, { path: route, method: "POST", body: { toolCallId: "redact", toolName: "fixture-tool", result: rawResult(REDACTED) } }));
			expect(redacted).toEqual({ content: [{ type: "text", text: "EP14_SAFE_REDACTED_RESULT" }], isError: false });
			expect(JSON.stringify(redacted)).not.toContain(REDACTED);

			// Render the real route's safe outputs through the actual product chat,
			// then inspect both visible DOM and the accessibility snapshot. This avoids
			// the prior vacuous assertion against an otherwise empty application body.
			await renderSafeToolResult(page, rejected, "reject");
			await renderSafeToolResult(page, redacted, "redact");
			const redactedRenderHost = page.locator("#ep14-tool-result-render-host-redact");
			const rejectedRenderHost = page.locator("#ep14-tool-result-render-host-reject");
			for (const host of [redactedRenderHost, rejectedRenderHost]) {
				await host.locator("button").filter({ hasText: "Expand to inspect" }).last().click();
			}
			await expect(redactedRenderHost.getByText("EP14_SAFE_REDACTED_RESULT", { exact: true })).toBeVisible();
			await expect(rejectedRenderHost.getByText(/^Tool result withheld by project result policy \[ref: /).first()).toBeVisible();
			const rendered = await page.locator("body").innerText();
			const snapshot = await page.locator("body").ariaSnapshot();
			expect(rendered).toContain("EP14_SAFE_REDACTED_RESULT");
			expect(snapshot).toContain("EP14_SAFE_REDACTED_RESULT");
			for (const canary of [REJECTED, REDACTED, ORDERED]) {
				expect(rendered).not.toContain(canary);
				expect(snapshot).not.toContain(canary);
			}

			// Browser-origin reads expose the downstream REST/trace/audit surfaces.
			// These calls are deliberately made after the gate has rejected/redacted
			// the canaries, so only safe metadata can reach client-visible responses.
			for (const path of [
				`/api/sessions/${encodeURIComponent(sessionId)}/context-trace?limit=50`,
				`/api/sessions/${encodeURIComponent(sessionId)}/tool-result-filter-audit?limit=50`,
			]) {
				const response = await browserApi(page, { path });
				expect(response.status, response.text).toBe(200);
				for (const canary of [REJECTED, REDACTED, ORDERED]) expect(response.text).not.toContain(canary);
			}
			// This observes actual browser console traffic for the complete browser-
			// origin route journey; unlike a page-global probe it cannot silently pass
			// merely because production code never writes that probe.
			for (const canary of [REJECTED, REDACTED, ORDERED]) {
				expect(consoleMessages.join("\n")).not.toContain(canary);
			}

			await revoke(page, projectId, "result-filter");
			await revoke(page, projectId, "competing-result-filter");
			await page.reload({ waitUntil: "domcontentloaded" });
			const revoked = parse(await browserApi(page, { path: route, method: "POST", body: { toolCallId: "revoked", toolName: "fixture-tool", result: rawResult(REJECTED) } }));
			expect(revoked).toEqual(rawResult(REJECTED));
		} finally {
			page.off("console", collectConsole);
			if (sessionId) await deleteSession(sessionId);
		}
	});
});
