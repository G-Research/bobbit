import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../gateway-harness.js";
import { apiFetch, defaultProject, deleteSession } from "../e2e-setup.js";
import { createToolResultFilterAttemptToken } from "../../../src/server/agent/tool-result-filter-attempt-credentials.js";
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
type AttemptCredential = { runtimeGeneration: number; runtimeKey: string };
type FilterGateway = { sessionManager?: { toolResultFilterAttemptCredentials?: unknown } };

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

async function browserApi(page: Page, request: { path: string; method?: string; body?: unknown; headers?: Record<string, string> }): Promise<BrowserResponse> {
	return page.evaluate(async ({ path, method, body, headers }) => {
		const token = localStorage.getItem("gateway.token");
		const response = await fetch(path, {
			method: method ?? "GET", credentials: "include",
			headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		return { status: response.status, text: await response.text() };
	}, request);
}

/**
 * Read the credential installed by the real session replacement lifecycle.
 * The test never mints one: grant-after-start must restart the live runtime and
 * install this core-owned gate before the grant response succeeds.
 */
function installedFilterRuntime(gateway: FilterGateway, sessionId: string): AttemptCredential {
	const runtimes = (gateway.sessionManager?.toolResultFilterAttemptCredentials as any)?.runtimes as Map<string, AttemptCredential> | undefined;
	const credential = runtimes?.get(sessionId);
	expect(credential, "grant reconciliation must install the private gate runtime").toBeTruthy();
	return credential!;
}

async function invokeFilter(
	page: Page,
	route: string,
	credential: AttemptCredential,
	sessionId: string,
	toolCallId: string,
	result: Record<string, unknown>,
): Promise<BrowserResponse> {
	const attempt = createToolResultFilterAttemptToken(credential, sessionId, toolCallId, randomUUID());
	return browserApi(page, {
		path: route, method: "POST",
		headers: { "x-bobbit-tool-result-attempt": attempt },
		body: { toolCallId, toolName: "fixture-tool", result },
	});
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

	test("browser-origin grant, reject-wins, redact, revoke, and reload expose only safe result bytes", async ({ page, gateway }) => {
		const consoleMessages: string[] = [];
		const collectConsole = (message: { type(): string; text(): string }) => {
			consoleMessages.push(`[${message.type()}] ${message.text()}`);
		};
		page.on("console", collectConsole);
		try {
			await openApp(page);
			sessionId = await createSessionViaUI(page);
			const route = `/api/sessions/${encodeURIComponent(sessionId)}/tool-result-filter`;
			// Browser/cookie transport auth alone is deliberately insufficient: the
			// callback accepts only a one-use credential from the private Pi gate.
			const inert = parse(await browserApi(page, { path: route, method: "POST", body: { toolCallId: "inert", toolName: "fixture-tool", result: rawResult(REJECTED) } }));
			expect(inert).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });

			// The session started before a grant, so the grant route must replace its
			// live runtime with one that has the private result gate. No test helper
			// may begin a runtime: that would hide the lifecycle bug this journey pins.
			await grant(page, projectId, "result-filter");
			const credential = installedFilterRuntime(gateway, sessionId);
			await grant(page, projectId, "competing-result-filter");
			const rejected = parse(await invokeFilter(page, route, credential, sessionId, "reject", rawResult(ORDERED)));
			expect(rejected).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
			expect(JSON.stringify(rejected)).not.toContain(ORDERED);
			expect(JSON.stringify(rejected)).not.toContain("EP14_SAFE_COMPETING_REPLACEMENT");

			const redacted = parse(await invokeFilter(page, route, credential, sessionId, "redact", rawResult(REDACTED)));
			expect(redacted).toMatchObject({ isError: false, content: [{ type: "text", text: "EP14_SAFE_REDACTED_RESULT" }] });
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
			await expect(redactedRenderHost.getByText("EP14_SAFE_REDACTED_RESULT").first()).toBeVisible();
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
				expect(gateway.logs.ring.join("\n")).not.toContain(canary);
			}

			await revoke(page, projectId, "result-filter");
			await revoke(page, projectId, "competing-result-filter");
			await page.reload({ waitUntil: "domcontentloaded" });
			const revoked = parse(await invokeFilter(page, route, credential, sessionId, "revoked", rawResult(REJECTED)));
			expect(revoked).toMatchObject({ isError: false, content: [{ type: "text", text: REJECTED }] });

			// Re-granting restores the active snapshot: deny still beats the
			// competing replacement, with a fresh one-use credential for this call.
			await grant(page, projectId, "result-filter");
			await grant(page, projectId, "competing-result-filter");
			const regranted = parse(await invokeFilter(page, route, credential, sessionId, "regranted", rawResult(ORDERED)));
			expect(regranted).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/^Tool result withheld/) }] });
			expect(JSON.stringify(regranted)).not.toContain(ORDERED);
		} finally {
			page.off("console", collectConsole);
			if (sessionId) await deleteSession(sessionId);
		}
	});
});
