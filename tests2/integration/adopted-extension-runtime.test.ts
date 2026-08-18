import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject, unregisterProject } from "./_e2e/e2e-setup.js";
import { fileURLToPath } from "node:url";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
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
	operations?: Array<{ name: string; classification: string; selected: boolean; selection?: "auto" | "explicit" }>;
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

async function patch(adoption: Adoption, body: Record<string, unknown>): Promise<Adoption> {
	const response = await apiFetch(`/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}`, {
		method: "PATCH",
		body: JSON.stringify({ scope: adoption.scope, ...(adoption.projectId ? { projectId: adoption.projectId } : {}), ...body }),
	});
	return (await responseJson<{ adoption: Adoption }>(response, 200)).adoption;
}

async function refresh(adoption: Adoption): Promise<Adoption> {
	const query = new URLSearchParams({ scope: adoption.scope });
	if (adoption.projectId) query.set("projectId", adoption.projectId);
	const response = await apiFetch(`/api/marketplace/adoptions/${encodeURIComponent(adoption.id)}/refresh?${query}`, { method: "POST" });
	return (await responseJson<{ adoption: Adoption }>(response, 200)).adoption;
}

async function list(projectId?: string): Promise<Adoption[]> {
	const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
	return (await responseJson<{ adoptions: Adoption[] }>(await apiFetch(`/api/marketplace/adoptions${suffix}`), 200)).adoptions;
}

function durableOperationSelections(gateway: any, adoption: Adoption): Array<{ name: string; selected: boolean; selection?: "auto" | "explicit" }> | undefined {
	// Server-scope adoptions belong to the headquarters store, which is shared
	// with its project context rather than the test's default project.
	const store = gateway.projectContextManager.getOrCreate("headquarters")?.projectConfigStore;
	const record = store?.getAdoptedExtensions("server")[adoption.id];
	return record?.operations?.map(({ name, selected, selection }: { name: string; selected: boolean; selection?: "auto" | "explicit" }) => ({ name, selected, selection }));
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

/** A stock-like endpoint whose service can fail and recover without changing its source identity. */
async function startToggleableHttpFixture(): Promise<{ endpoint: string; setAvailable: (available: boolean) => void; setListRecordsReadOnly: (readOnly: boolean) => void; cleanup: () => Promise<void> }> {
	let available = true;
	let listRecordsReadOnly = true;
	const tools = () => [
		{ name: "list_records", inputSchema: { type: "object", properties: {} }, annotations: listRecordsReadOnly ? { readOnlyHint: true } : {} },
		{ name: "discover_records", inputSchema: { type: "object", properties: {} } },
		{ name: "create_record", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: false } },
	];
	const server = createServer((req, res) => {
		if (!available) { res.writeHead(503).end(); return; }
		if (req.method !== "POST" || req.url !== "/mcp") { res.writeHead(404).end(); return; }
		let raw = "";
		req.on("data", chunk => { raw += chunk; });
		req.on("end", () => {
			const message = JSON.parse(raw) as { id?: string | number; method?: string };
			if (message.id === undefined) { res.writeHead(202).end(); return; }
			const result = message.method === "initialize"
				? { protocolVersion: "2024-11-05", serverInfo: { name: "toggleable-stock-http-fixture", version: "4.5.7" }, capabilities: { tools: {} } }
				: message.method === "tools/list" ? { tools: tools() } : { content: [{ type: "text", text: "ok" }] };
			res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "toggleable-stock-http-session" });
			res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
		});
	});
	server.on("connection", socket => socket.unref());
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	server.unref();
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Toggleable HTTP fixture did not bind a loopback port");
	return {
		endpoint: `http://127.0.0.1:${address.port}/mcp`,
		setAvailable: next => { available = next; },
		setListRecordsReadOnly: next => { listRecordsReadOnly = next; },
		cleanup: async () => {
			server.closeAllConnections();
			server.close();
		},
	};
}

test.describe("adopted extension runtime API", () => {
	test("records a blocked stock stdio source idempotently without exposing its command arguments", async ({ gateway }) => {
		let adoption: Adoption | undefined;
		try {
			// Exercise the real resolver/manager path; only the test harness's
			// process fence prevents the stock command from starting.
			await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
			const secretArg = "--token=must-not-echo";
			const input = {
				kind: "mcp",
				scope: "server",
				source: { transport: "stdio", command: process.execPath, args: [STDIO_FIXTURE, secretArg] },
			};
			const legacyPrivateDigest = createHash("sha256")
				.update(`server\0\0mcp\0${process.execPath}\0${STDIO_FIXTURE}\0${secretArg}`)
				.digest("hex").slice(0, 12);
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
			const wire = JSON.stringify(adoption);
			expect(wire).not.toContain("must-not-echo");
			expect(wire).not.toContain(legacyPrivateDigest);
			expect(adoption.id).not.toContain(legacyPrivateDigest);

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

	test("refreshing a disabled MCP adoption retains its prior operations without probing", async ({ gateway }) => {
		const fixture = await startHttpFixture();
		let adoption: Adoption | undefined;
		try {
			await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
			adoption = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: fixture.endpoint } })).adoption;
			const beforeDisable = adoption.operations;
			adoption = await patch(adoption, { enabled: false });
			const refreshed = await refresh(adoption);

			expect(refreshed.enabled).toBe(false);
			expect(refreshed.operations).toEqual(beforeDisable);
			expect(refreshed.conformance.state).toBe(adoption.conformance.state);
			expect(refreshed.conformance.failures).not.toEqual(expect.arrayContaining([
				expect.objectContaining({ code: "connection_failed" }),
			]));
			adoption = refreshed;
		} finally {
			if (adoption) await remove(adoption);
			await fixture.cleanup();
		}
	});

	test("outage and recovery retain explicit MCP operation selections", async ({ gateway }) => {
		const fixture = await startToggleableHttpFixture();
		let adoption: Adoption | undefined;
		try {
			await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
			adoption = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: fixture.endpoint } })).adoption;
			adoption = await patch(adoption, { operations: [{ name: "create_record", selected: true }] });
			const explicitSelection = adoption.operations?.map(({ name, selected }) => ({ name, selected }));
			const explicitDurableSelection = durableOperationSelections(gateway, adoption);
			expect(explicitDurableSelection).toEqual(expect.arrayContaining([
				{ name: "create_record", selected: true, selection: "explicit" },
			]));

			fixture.setAvailable(false);
			adoption = await patch(adoption, { enabled: false });
			adoption = await patch(adoption, { enabled: true });
			const unavailable = await refresh(adoption);
			expect(unavailable.conformance).toMatchObject({ state: "unreachable", failures: [{ code: "connection_failed" }] });
			expect(unavailable.operations?.map(({ name, selected }) => ({ name, selected }))).toEqual(explicitSelection);
			expect(durableOperationSelections(gateway, unavailable)).toEqual(explicitDurableSelection);

			fixture.setAvailable(true);
			adoption = await patch(unavailable, { enabled: false });
			adoption = await patch(adoption, { enabled: true });
			const recovered = await refresh(adoption);
			expect(recovered.conformance.state).toBe("loaded");
			expect(recovered.operations?.map(({ name, selected }) => ({ name, selected }))).toEqual(explicitSelection);
			expect(durableOperationSelections(gateway, recovered)).toEqual(explicitDurableSelection);
			adoption = recovered;
		} finally {
			if (adoption) await remove(adoption);
			await fixture.cleanup();
		}
	});

	test("authoritative refresh revokes auto selection when a live tool loses its read-only hint", async ({ gateway }) => {
		const fixture = await startToggleableHttpFixture();
		let adoption: Adoption | undefined;
		try {
			await gateway.sessionManager.initMcp(path.join(gateway.bobbitDir, "default-project"));
			adoption = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: fixture.endpoint } })).adoption;
			expect(adoption.operations).toEqual(expect.arrayContaining([
				{ name: "list_records", classification: "read-only-hint", selected: true },
			]));
			expect(durableOperationSelections(gateway, adoption)).toEqual(expect.arrayContaining([
				{ name: "list_records", selected: true, selection: "auto" },
			]));

			// The UI submits its full list. Changing another operation must not turn
			// this untouched read-only baseline into an explicit durable grant.
			adoption = await patch(adoption, {
				operations: adoption.operations!.map(operation => ({
					name: operation.name,
					selected: operation.name === "create_record" ? true : operation.selected,
				})),
			});
			expect(durableOperationSelections(gateway, adoption)).toEqual(expect.arrayContaining([
				{ name: "list_records", selected: true, selection: "auto" },
				{ name: "create_record", selected: true, selection: "explicit" },
			]));

			fixture.setListRecordsReadOnly(false);
			// Reconnect to obtain an authoritative tools/list snapshot for the same
			// source identity; an unavailable refresh deliberately retains history.
			adoption = await patch(adoption, { enabled: false });
			adoption = await patch(adoption, { enabled: true });
			adoption = await refresh(adoption);
			expect(adoption.operations).toEqual(expect.arrayContaining([
				{ name: "list_records", classification: "unknown", selected: false },
			]));
			expect(durableOperationSelections(gateway, adoption)).toEqual(expect.arrayContaining([
				{ name: "list_records", selected: false, selection: "auto" },
			]));

			const servers = await responseJson<Array<{ name: string; toolCount: number; tools: Array<{ op: string }> }>>(
				await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(gateway.defaultProjectId)}`),
				200,
			);
			const runtime = servers.find(server => server.name === adoption!.namespace);
			expect(runtime?.toolCount).toBe(1);
			expect(runtime?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ op: "create_record" })]));
			expect(runtime?.tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ op: "list_records" })]));
		} finally {
			if (adoption) await remove(adoption);
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
			await unregisterProject(first.id);
			await unregisterProject(second.id);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
