import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const FIXTURES = fileURLToPath(new URL("../fixtures/adoptions/", import.meta.url));
const STDIO_FIXTURE = path.join(FIXTURES, "stock-mcp-stdio.mjs");
const HTTP_FIXTURE = path.join(FIXTURES, "stock-mcp-streamable-http.mjs");
const SKILLS_FIXTURE = path.join(FIXTURES, "skills");

type Adoption = {
	id: string;
	kind: "mcp" | "skills";
	scope: "server" | "global-user" | "project";
	projectId?: string;
	namespace: string;
	enabled: boolean;
	operations?: Array<{ name: string; classification: string; selected: boolean }>;
	provenance: { class: string; sourceType: string; sourceLocation: string };
	conformance: {
		state: string;
		mcp?: { requestedProtocol?: string; negotiatedProtocol?: string; serverName?: string; serverVersion?: string; loadedTools: string[]; rejectedTools: Array<{ name?: string; reason: string }> };
		skills?: { loadedSkills: string[]; rejectedSkills: Array<{ path: string; reason: string }> };
		failures: Array<{ code: string; message: string }>;
	};
};

async function responseJson<T>(response: Response, expected: number | number[]): Promise<T> {
	const statuses = Array.isArray(expected) ? expected : [expected];
	const body = await response.text();
	expect(statuses, body).toContain(response.status);
	return body ? JSON.parse(body) as T : undefined as T;
}

async function adopt(body: Record<string, unknown>): Promise<{ status: number; adoption: Adoption }> {
	const response = await apiFetch("/api/marketplace/adoptions", { method: "POST", body: JSON.stringify(body) });
	const parsed = await responseJson<{ adoption: Adoption }>(response, [200, 201]);
	return { status: response.status, adoption: parsed.adoption };
}

async function remove(adoption: Adoption): Promise<void> {
	const query = new URLSearchParams({ scope: adoption.scope });
	if (adoption.projectId) query.set("projectId", adoption.projectId);
	const response = await apiFetch(`/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}?${query}`, { method: "DELETE" });
	expect([200, 204]).toContain(response.status);
}

async function list(projectId?: string): Promise<Adoption[]> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return (await responseJson<{ adoptions: Adoption[] }>(await apiFetch(`/api/marketplace/adoptions${suffix}`), 200)).adoptions;
}

async function slashNames(projectId: string): Promise<string[]> {
	const response = await apiFetch(`/api/slash-skills?projectId=${encodeURIComponent(projectId)}`);
	const { skills } = await responseJson<{ skills: Array<{ name: string }> }>(response, 200);
	return skills.map(skill => skill.name);
}

async function startHttpFixture(): Promise<{ endpoint: string; cleanup: () => Promise<void> }> {
	// Import and bind the stock endpoint inside this process. Tier-1's spawn
	// fence intentionally prevents tests from launching arbitrary Node fixtures.
	const fixtureModule = await import(HTTP_FIXTURE) as {
		startStockHttpFixture: () => Promise<{ endpoint: string; close: () => Promise<void> }>;
	};
	const fixture = await fixtureModule.startStockHttpFixture();
	return { endpoint: fixture.endpoint, cleanup: fixture.close };
}

test.describe("adopted extension runtime API", () => {
	test("records a blocked stock stdio source idempotently without exposing its command arguments", async ({ gateway }) => {
		let adoption: Adoption | undefined;
		try {
			// Exercise the real resolver/manager path; only the test harness's
			// process fence prevents the stock command from starting.
			await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
			const input = {
				kind: "mcp",
				scope: "server",
				source: { transport: "stdio", command: process.execPath, args: [STDIO_FIXTURE, "--token=must-not-echo"] },
			};
			const first = await adopt(input);
			adoption = first.adoption;
			expect(first.status).toBe(201);
			expect(adoption).toMatchObject({
				kind: "mcp",
				namespace: `adopt_${adoption.id}`,
				provenance: { class: "adopted", sourceType: "stdio", sourceLocation: process.execPath },
				// The tier-1 process fence blocks stdio transport. The isolated adoption
				// remains durable and reports only the controlled public failure.
				conformance: {
					state: "unreachable",
					mcp: { loadedTools: [], rejectedTools: [] },
					failures: [{ code: "connection_failed", message: "The extension could not be reached." }],
				},
			});
			expect(JSON.stringify(adoption)).not.toContain("must-not-echo");

			const duplicate = await adopt(input);
			expect(duplicate.status).toBe(200);
			expect(duplicate.adoption.id).toBe(adoption.id);
			expect((await list()).filter(item => item.id === adoption!.id)).toHaveLength(1);
		} finally {
			if (adoption) await remove(adoption);
		}
	});

	test("requires an operator for adoption mutations even when localhost auth is otherwise skipped", async ({ gateway }) => {
		const input = JSON.stringify({ kind: "skills", scope: "server", source: { directory: SKILLS_FIXTURE } });
		const crossOrigin = await fetch(`${gateway.baseURL}/api/marketplace/adoptions`, {
			method: "POST",
			headers: { Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site", "Content-Type": "text/plain" },
			body: input,
		});
		expect(crossOrigin.status).toBe(401);
		expect(await crossOrigin.text()).not.toContain(SKILLS_FIXTURE);

		const bearerCreate = await fetch(`${gateway.baseURL}/api/marketplace/adoptions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${gateway.token}`, "Content-Type": "application/json" },
			body: input,
		});
		expect([200, 201]).toContain(bearerCreate.status);
		const adoption = (await bearerCreate.json() as { adoption: Adoption }).adoption;
		try {
			const cookieProbe = await fetch(`${gateway.baseURL}/api/goals`, {
				headers: { Authorization: `Bearer ${gateway.token}`, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
			});
			const setCookies = (cookieProbe.headers as any).getSetCookie?.() as string[] | undefined
				?? (cookieProbe.headers.get("set-cookie") ? [cookieProbe.headers.get("set-cookie") as string] : []);
			const cookie = setCookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session="));
			expect(cookie).toBeTruthy();
			const patchUrl = `${gateway.baseURL}/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}`;
			const patchBody = JSON.stringify({ scope: adoption.scope, enabled: false });
			const deniedHeaders: Array<Record<string, string>> = [
				{ Cookie: cookie!, "Content-Type": "application/json" },
				{ Cookie: cookie!, "Content-Type": "application/json", Origin: gateway.baseURL, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" },
				{ Cookie: cookie!, "Content-Type": "application/json", Origin: "https://attacker.invalid", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" },
			];
			for (const headers of deniedHeaders) {
				const denied = await fetch(patchUrl, { method: "PATCH", headers, body: patchBody });
				expect(denied.status).toBe(401);
			}
			const cookiePatch = await fetch(patchUrl, {
				method: "PATCH",
				headers: {
					Cookie: cookie!,
					"Content-Type": "application/json",
					Origin: gateway.baseURL,
					"Sec-Fetch-Site": "same-origin",
					"Sec-Fetch-Mode": "cors",
				},
				body: patchBody,
			});
			expect(cookiePatch.status).toBe(200);

			const sandboxToken = gateway.sessionManager.sandboxTokenStore.register(gateway.defaultProjectId);
			const sandboxMutation = await fetch(`${gateway.baseURL}/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}?scope=server`, {
				method: "DELETE",
				headers: { Authorization: `Bearer ${sandboxToken}` },
			});
			expect(sandboxMutation.status).toBe(403);
		} finally {
			await fetch(`${gateway.baseURL}/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}?scope=server`, {
				method: "DELETE", headers: { Authorization: `Bearer ${gateway.token}` },
			});
		}
	});

	test("uses streamable HTTP negotiation while unreachable and invalid stock sources remain isolated", async ({ gateway }) => {
		const fixture = await startHttpFixture();
		await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
		let healthy: Adoption | undefined;
		let unreachable: Adoption | undefined;
		try {
			healthy = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: fixture.endpoint } })).adoption;
			expect(healthy).toMatchObject({
				provenance: { class: "adopted", sourceType: "http", sourceLocation: fixture.endpoint },
				conformance: { state: "partial", mcp: { requestedProtocol: "2024-11-05", negotiatedProtocol: "2024-11-05", serverName: "stock-http-fixture", serverVersion: "4.5.6" } },
			});
			expect(healthy.operations).toEqual(expect.arrayContaining([
				{ name: "list_records", classification: "read-only-hint", selected: true },
				{ name: "discover_records", classification: "unknown", selected: false },
				{ name: "create_record", classification: "mutation-or-contradictory", selected: false },
			]));
			// Invalid schemas are removed before the route/operation list, while valid
			// unknown and mutation hints remain present but unselected.
			expect(healthy.operations?.some(operation => operation.name === "bad_schema")).toBe(false);
			expect(healthy.conformance.mcp?.loadedTools).toEqual(expect.arrayContaining(["list_records", "discover_records", "create_record"]));
			expect(healthy.conformance).toMatchObject({ state: "partial", mcp: { rejectedTools: [{ name: "bad_schema", reason: "invalid_operation_schema" }] } });
			const servers = await responseJson<Array<{ name: string; ownerContributions?: Array<{ contributionId?: string }> }>>(
				await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(gateway.defaultProjectId)}`),
				200,
			);
			const runtime = servers.find(server => server.name === healthy!.namespace);
			expect(runtime).toBeDefined();
			expect(runtime?.name).toMatch(/^adopt_[a-z0-9-]+$/);
			expect(runtime?.ownerContributions?.some(owner => owner.contributionId === `adopt:server:${healthy!.id}`)).toBe(true);

			unreachable = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: "http://127.0.0.1:1/mcp" } })).adoption;
			expect(unreachable.conformance).toMatchObject({ state: "unreachable", failures: [{ code: "connection_failed", message: expect.any(String) }] });
			expect(unreachable.conformance.failures[0]?.message).not.toMatch(/127\.0\.0\.1|token|ECONNREFUSED/i);
			expect((await list()).map(item => item.id)).toContain(healthy.id);

			const invalid = await apiFetch("/api/marketplace/adoptions", {
				method: "POST",
				body: JSON.stringify({ kind: "mcp", scope: "server", source: { transport: "stdio", command: "" } }),
			});
			expect(invalid.status).toBe(400);
			expect(JSON.stringify(await invalid.json())).not.toMatch(/token|environment|headers/i);
		} finally {
			if (unreachable) await remove(unreachable);
			if (healthy) await remove(healthy);
			await fixture.cleanup();
		}
	});

	test("loads valid adopted skill siblings with namespacing, persists project scope, and cleans up without crossing projects", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "bobbit-adoption-projects-"));
		const firstRoot = path.join(root, "first");
		const secondRoot = path.join(root, "second");
		mkdirSync(firstRoot, { recursive: true });
		mkdirSync(secondRoot, { recursive: true });
		const first = await registerProject({ name: `adopt-first-${Date.now()}`, rootPath: firstRoot, seedWorkflows: false });
		const second = await registerProject({ name: `adopt-second-${Date.now()}`, rootPath: secondRoot, seedWorkflows: false });
		let adoption: Adoption | undefined;
		try {
			adoption = (await adopt({ kind: "skills", scope: "project", projectId: first.id, source: { directory: SKILLS_FIXTURE } })).adoption;
			expect(adoption).toMatchObject({
				kind: "skills",
				scope: "project",
				projectId: first.id,
				provenance: { class: "adopted", sourceType: "claude-skills-directory", sourceLocation: SKILLS_FIXTURE },
				conformance: { state: "partial" },
			});
			const prefix = `adopt-${adoption.id}--`;
			expect(adoption.conformance.skills?.loadedSkills).toEqual([`${prefix}inspect`, `${prefix}summarize`]);
			expect(adoption.conformance.skills?.rejectedSkills.map(skill => skill.reason)).toEqual(expect.arrayContaining([
				"malformed_frontmatter", "duplicate_name", "missing_skill_file",
			]));
			expect(await slashNames(first.id)).toEqual(expect.arrayContaining([`${prefix}inspect`, `${prefix}summarize`]));
			expect(await slashNames(second.id)).not.toEqual(expect.arrayContaining([`${prefix}inspect`, `${prefix}summarize`]));

			// Re-read through the ordinary route after the project config store has been rebuilt.
			// This pins restart-stable ledger reconstruction rather than an in-memory-only cache.
			expect((await list(first.id)).find(item => item.id === adoption!.id)?.conformance.state).toBe("partial");
			expect((await list(second.id)).find(item => item.id === adoption!.id)).toBeUndefined();

			await remove(adoption);
			adoption = undefined;
			expect(await slashNames(first.id)).not.toEqual(expect.arrayContaining([`${prefix}inspect`, `${prefix}summarize`]));
			expect(await slashNames(second.id)).not.toEqual(expect.arrayContaining([`${prefix}inspect`, `${prefix}summarize`]));
		} finally {
			if (adoption) await remove(adoption);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
