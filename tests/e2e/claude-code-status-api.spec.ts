import { test, expect } from "./in-process-harness.js";
import { apiFetch, base, readE2EToken } from "./e2e-setup.js";
import os from "node:os";
import path from "node:path";


async function operatorCookie(): Promise<string> {
	const res = await fetch(`${base()}/api/preferences`, {
		headers: { Authorization: `Bearer ${readE2EToken()}` },
	});
	const setCookie = res.headers.get("set-cookie");
	const cookie = setCookie?.split(";")[0];
	if (!cookie) throw new Error("operator cookie was not minted");
	return cookie;
}

async function confirmedClaudeCodePrefs(patch: Record<string, unknown>): Promise<Response> {
	const cookie = await operatorCookie();
	const commonHeaders = {
		Authorization: `Bearer ${readE2EToken()}`,
		Cookie: cookie,
		"Content-Type": "application/json",
	};
	const confirmation = await fetch(`${base()}/api/preferences/claude-code/confirmation`, {
		method: "POST",
		headers: commonHeaders,
		body: JSON.stringify(patch),
	});
	expect(confirmation.status).toBe(200);
	const data = await confirmation.json();
	expect(data.confirmationToken).toBeTruthy();
	return fetch(`${base()}/api/preferences`, {
		method: "PUT",
		headers: { ...commonHeaders, "X-Bobbit-Operator-Confirmation": data.confirmationToken },
		body: JSON.stringify(patch),
	});
}

async function resetClaudeCodePrefs(): Promise<void> {
	await confirmedClaudeCodePrefs({
		"claudeCode.executablePath": null,
		"claudeCode.defaultModel": null,
		"claudeCode.permissionMode": null,
		"claudeCode.allowBypassPermissions": null,
	});
}

test.describe("Claude Code status/model APIs", () => {
	test.afterEach(async () => {
		await resetClaudeCodePrefs().catch(() => {});
	});

	test("status endpoint and model registry expose unavailable local runtime cleanly", async () => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		const directResp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": missing }),
		});
		expect(directResp.status).toBe(403);
		expect(await directResp.json()).toMatchObject({ confirmationRequired: true });

		const prefResp = await confirmedClaudeCodePrefs({ "claudeCode.executablePath": missing });
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
		expect(claudeCodeModels.map((m: any) => m.id)).toEqual(["claude-opus-4-8", "default", "sonnet", "opus"]);
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
		await confirmedClaudeCodePrefs({ "claudeCode.executablePath": missing });
		const first = await (await apiFetch("/api/claude-code/status")).json();
		expect(first.reason).toBe("Claude Code CLI not found");

		await confirmedClaudeCodePrefs({ "claudeCode.executablePath": process.execPath });
		const refreshResp = await apiFetch("/api/claude-code/status/refresh", { method: "POST" });
		expect(refreshResp.status).toBe(200);
		const refreshed = await refreshResp.json();
		expect(refreshed.available).toBe(true);
		expect(refreshed.ready).toBe(true);
		expect(refreshed.authenticationStatus).toBe("unknown");
		expect(refreshed.message).toContain("verified when a Claude Code session starts");
	});

	test("models and status ignore project-scoped Claude Code executable config", async () => {
		const projectsResp = await apiFetch("/api/projects");
		expect(projectsResp.status).toBe(200);
		const projects = await projectsResp.json();
		const project = (Array.isArray(projects) ? projects : projects.projects)?.[0];
		expect(project?.id).toBeTruthy();
		const missing = path.join(os.tmpdir(), `missing-global-claude-${process.pid}-${Date.now()}`);
		await confirmedClaudeCodePrefs({ "claudeCode.executablePath": missing });
		try {
			const projectConfigResp = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ claudeCodeExecutablePath: process.execPath }),
			});
			expect(projectConfigResp.status).toBe(200);

			const globalModels = await (await apiFetch("/api/models")).json();
			expect(globalModels.find((m: any) => m.provider === "claude-code" && m.id === "sonnet")?.sessionSelectable).toBe(false);

			const scopedStatus = await (await apiFetch(`/api/claude-code/status?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(scopedStatus.executablePath).toBe(missing);
			expect(scopedStatus.ready).toBe(false);
			expect(scopedStatus.reason).toBe("Claude Code CLI not found");
			const scopedModels = await (await apiFetch(`/api/models?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(scopedModels.find((m: any) => m.provider === "claude-code" && m.id === "sonnet")?.sessionSelectable).toBe(false);
			expect(scopedModels.find((m: any) => m.provider === "claude-code" && m.id === "sonnet")?.sessionUnavailableReason).toBe("Claude Code CLI not found");
		} finally {
			await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ claudeCodeExecutablePath: null }),
			}).catch(() => {});
		}
	});

	test("preferences protect Claude Code host-runtime sensitive mutations", async () => {
		const safe = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({
				"claudeCode.defaultModel": "opus",
				"claudeCode.permissionMode": "acceptEdits",
			}),
		});
		expect(safe.status).toBe(200);

		const rejectedReset = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": null }),
		});
		expect(rejectedReset.status).toBe(403);
		expect(await rejectedReset.json()).toMatchObject({ confirmationRequired: true, sensitiveKeys: ["claudeCode.executablePath"] });

		const rejectedBypass = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({
				"claudeCode.allowBypassPermissions": true,
				"claudeCode.permissionMode": "bypassPermissions",
			}),
		});
		expect(rejectedBypass.status).toBe(403);
		expect(await rejectedBypass.json()).toMatchObject({ confirmationRequired: true });

		const rejectedSessionBound = await confirmedClaudeCodePrefs({ "claudeCode.allowBypassPermissions": true });
		expect(rejectedSessionBound.status).toBe(200);
		const prefs = await (await apiFetch("/api/preferences")).json();
		expect(prefs["claudeCode.allowBypassPermissions"]).toBe(true);

		const accepted = await confirmedClaudeCodePrefs({
			"claudeCode.allowBypassPermissions": true,
			"claudeCode.permissionMode": "bypassPermissions",
		});
		expect(accepted.status).toBe(200);
	});
});
