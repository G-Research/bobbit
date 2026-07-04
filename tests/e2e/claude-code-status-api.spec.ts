import { test, expect } from "./in-process-harness.js";
import { apiFetch, base, readE2EToken } from "./e2e-setup.js";
import os from "node:os";
import path from "node:path";


async function cookieFrom(resp: Response): Promise<string> {
	const setCookie = resp.headers.get("set-cookie");
	const cookie = setCookie?.split(";")[0];
	if (!cookie) throw new Error("cookie was not minted");
	return cookie;
}

async function bearerMintedCookie(pathname = "/api/preferences"): Promise<string> {
	return cookieFrom(await fetch(`${base()}${pathname}`, {
		headers: { Authorization: `Bearer ${readE2EToken()}` },
	}));
}

function setClaudeCodePrefs(gateway: any, patch: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(patch)) {
		if (value === null || value === undefined) gateway.preferencesStore.remove(key);
		else gateway.preferencesStore.set(key, value);
	}
}

async function resetClaudeCodePrefs(gateway: any): Promise<void> {
	setClaudeCodePrefs(gateway, {
		"claudeCode.executablePath": null,
		"claudeCode.defaultModel": null,
		"claudeCode.permissionMode": null,
		"claudeCode.allowBypassPermissions": null,
	});
	await apiFetch("/api/claude-code/status/refresh", { method: "POST" }).catch(() => undefined);
}

test.describe("Claude Code status/model APIs", () => {
	test.afterEach(async ({ gateway }) => {
		await resetClaudeCodePrefs(gateway).catch(() => {});
	});

	test("status endpoint and model registry expose unavailable local runtime cleanly", async ({ gateway }) => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		const directResp = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({ "claudeCode.executablePath": missing }),
		});
		expect(directResp.status).toBe(403);
		expect(await directResp.json()).toMatchObject({ confirmationRequired: true });

		setClaudeCodePrefs(gateway, { "claudeCode.executablePath": missing });
		await apiFetch("/api/claude-code/status/refresh", { method: "POST" });

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
		expect(claudeCodeModels.map((m: any) => m.id)).toEqual(["local-claude-opus-4-8", "local-claude-sonnet-4-6"]);
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

	test("status refresh endpoint invalidates cache and re-probes", async ({ gateway }) => {
		const missing = path.join(os.tmpdir(), `missing-claude-${process.pid}-${Date.now()}`);
		setClaudeCodePrefs(gateway, { "claudeCode.executablePath": missing });
		const first = await (await apiFetch("/api/claude-code/status")).json();
		expect(first.reason).toBe("Claude Code CLI not found");

		setClaudeCodePrefs(gateway, { "claudeCode.executablePath": process.execPath });
		const refreshResp = await apiFetch("/api/claude-code/status/refresh", { method: "POST" });
		expect(refreshResp.status).toBe(200);
		const refreshed = await refreshResp.json();
		expect(refreshed.available).toBe(true);
		expect(refreshed.ready).toBe(true);
		expect(refreshed.authenticationStatus).toBe("unknown");
		expect(refreshed.message).toContain("verified when a Claude Code session starts");
	});

	test("models and status ignore project-scoped Claude Code executable config", async ({ gateway }) => {
		const projectsResp = await apiFetch("/api/projects");
		expect(projectsResp.status).toBe(200);
		const projects = await projectsResp.json();
		const project = (Array.isArray(projects) ? projects : projects.projects)?.[0];
		expect(project?.id).toBeTruthy();
		const missing = path.join(os.tmpdir(), `missing-global-claude-${process.pid}-${Date.now()}`);
		setClaudeCodePrefs(gateway, { "claudeCode.executablePath": missing });
		await apiFetch("/api/claude-code/status/refresh", { method: "POST" });
		try {
			const projectConfigResp = await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ claudeCodeExecutablePath: process.execPath }),
			});
			expect(projectConfigResp.status).toBe(200);

			const globalModels = await (await apiFetch("/api/models")).json();
			expect(globalModels.find((m: any) => m.provider === "claude-code" && m.id === "local-claude-sonnet-4-6")?.sessionSelectable).toBe(false);

			const scopedStatus = await (await apiFetch(`/api/claude-code/status?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(scopedStatus.executablePath).toBe(missing);
			expect(scopedStatus.ready).toBe(false);
			expect(scopedStatus.reason).toBe("Claude Code CLI not found");
			const scopedModels = await (await apiFetch(`/api/models?projectId=${encodeURIComponent(project.id)}`)).json();
			expect(scopedModels.find((m: any) => m.provider === "claude-code" && m.id === "local-claude-sonnet-4-6")?.sessionSelectable).toBe(false);
			expect(scopedModels.find((m: any) => m.provider === "claude-code" && m.id === "local-claude-sonnet-4-6")?.sessionUnavailableReason).toBe("Claude Code CLI not found");
		} finally {
			await apiFetch(`/api/projects/${project.id}/config`, {
				method: "PUT",
				body: JSON.stringify({ claudeCodeExecutablePath: null }),
			}).catch(() => {});
		}
	});

	test("Claude Code confirmations reject bearer/API-minted cookie bypasses", async () => {
		const patch = { "claudeCode.executablePath": path.join(os.tmpdir(), `bearer-bypass-${process.pid}-${Date.now()}`) };
		const bearerCookie = await bearerMintedCookie();

		const mintedWithBearerCookie = await fetch(`${base()}/api/preferences/claude-code/confirmation`, {
			method: "POST",
			headers: { Cookie: bearerCookie, "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(mintedWithBearerCookie.status).toBe(403);

		const spoofedHealthCookie = await cookieFrom(await fetch(`${base()}/api/health`, {
			headers: {
				Authorization: `Bearer ${readE2EToken()}`,
				"Sec-Fetch-Site": "same-origin",
				"Sec-Fetch-Mode": "cors",
			},
		}));
		const mintWithSpoofedHealthCookie = await fetch(`${base()}/api/preferences/claude-code/confirmation`, {
			method: "POST",
			headers: { Cookie: spoofedHealthCookie, "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(mintWithSpoofedHealthCookie.status).toBe(403);

		const tokenQueryCookie = await cookieFrom(await fetch(`${base()}/api/health?token=${encodeURIComponent(readE2EToken())}`));
		const mintWithTokenQueryCookie = await fetch(`${base()}/api/preferences/claude-code/confirmation`, {
			method: "POST",
			headers: { Cookie: tokenQueryCookie, "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		expect(mintWithTokenQueryCookie.status).toBe(403);
	});

	test("preferences protect Claude Code host-runtime sensitive mutations", async ({ gateway }) => {
		const safe = await apiFetch("/api/preferences", {
			method: "PUT",
			body: JSON.stringify({
				"claudeCode.defaultModel": "local-claude-opus-4-8",
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

		setClaudeCodePrefs(gateway, { "claudeCode.allowBypassPermissions": true });
		const prefs = await (await apiFetch("/api/preferences")).json();
		expect(prefs["claudeCode.allowBypassPermissions"]).toBe(true);
	});
});
