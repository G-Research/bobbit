import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";
import os from "node:os";
import path from "node:path";

async function resetClaudeCodePrefs(): Promise<void> {
	await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({
			"claudeCode.executablePath": null,
			"claudeCode.defaultModel": null,
			"claudeCode.permissionMode": null,
			"claudeCode.allowBypassPermissions": null,
		}),
	});
}

test.describe("Claude Code status/model APIs", () => {
	test.afterEach(async () => {
		await resetClaudeCodePrefs().catch(() => {});
	});

	test("status endpoint and model registry expose unavailable local runtime cleanly", async () => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		const prefResp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": missing }),
		});
		expect(prefResp.status).toBe(200);

		const statusResp = await apiFetch("/api/claude-code/status");
		expect(statusResp.status).toBe(200);
		const status = await statusResp.json();
		expect(status).toMatchObject({
			available: false,
			authenticated: false,
			ready: false,
			executablePath: missing,
			reason: "Claude Code CLI not found",
		});

		const modelsResp = await apiFetch("/api/models");
		expect(modelsResp.status).toBe(200);
		const models = await modelsResp.json();
		const claudeCodeModels = models.filter((m: any) => m.provider === "claude-code");
		expect(claudeCodeModels.map((m: any) => m.id)).toEqual(["default", "sonnet", "opus"]);
		for (const model of claudeCodeModels) {
			expect(model).toMatchObject({
				api: "claude-code-runtime",
				runtime: "claude-code",
				localRuntime: true,
				runtimeLabel: "Claude Code (local)",
				authenticated: false,
				sessionSelectable: false,
				sessionUnavailableReason: "Claude Code CLI not found",
			});
		}
	});

	test("status refresh endpoint invalidates cache and re-probes", async () => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": missing }),
		});
		const first = await (await apiFetch("/api/claude-code/status")).json();
		expect(first.reason).toBe("Claude Code CLI not found");

		await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": process.execPath }),
		});
		const refreshResp = await apiFetch("/api/claude-code/status/refresh", { method: "POST" });
		expect(refreshResp.status).toBe(200);
		const refreshed = await refreshResp.json();
		expect(refreshed.available).toBe(true);
		expect(refreshed.ready).toBe(false);
		expect(refreshed.reason).toContain("authentication status unknown");
	});

	test("preferences validate Claude Code bypass permission opt-in", async () => {
		const rejected = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.permissionMode": "bypassPermissions" }),
		});
		expect(rejected.status).toBe(400);
		expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("requires") });

		const accepted = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({
				"claudeCode.allowBypassPermissions": true,
				"claudeCode.permissionMode": "bypassPermissions",
			}),
		});
		expect(accepted.status).toBe(200);
	});
});
