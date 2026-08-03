import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, registerProject } from "./_e2e/e2e-setup.js";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
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

async function startHttpFixture(): Promise<{ endpoint: string; child: ChildProcess; cleanup: () => Promise<void> }> {
	const root = mkdtempSync(path.join(tmpdir(), "bobbit-adoption-http-"));
	const endpointFile = path.join(root, "endpoint.txt");
	const child = spawn(process.execPath, [HTTP_FIXTURE, endpointFile], { stdio: "ignore" });
	const endpoint = await new Promise<string>((resolve, reject) => {
		const deadline = Date.now() + 5_000;
		const poll = () => {
			try { return resolve(readFileSync(endpointFile, "utf8").trim()); }
			catch { /* fixture has not bound its ephemeral loopback port yet */ }
			if (Date.now() >= deadline) return reject(new Error("HTTP MCP fixture did not publish its endpoint"));
			setTimeout(poll, 20);
		};
		child.once("error", reject);
		child.once("exit", code => { if (code !== 0) reject(new Error(`HTTP MCP fixture exited (${code})`)); });
		poll();
	});
	return {
		endpoint,
		child,
		cleanup: async () => {
			if (child.exitCode === null && !child.killed) {
				await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
			}
			try { unlinkSync(endpointFile); } catch { /* already gone */ }
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test.describe("adopted extension runtime API", () => {
	test("adopts a stock stdio server idempotently with read-only-only exposure and sanitized negotiated provenance", async () => {
		let adoption: Adoption | undefined;
		try {
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
				conformance: {
					state: "loaded",
					mcp: {
						requestedProtocol: "2024-11-05",
						negotiatedProtocol: "2024-11-05",
						serverName: "stock-stdio-fixture",
						serverVersion: "1.2.3",
					},
				},
			});
			expect(adoption.operations).toEqual(expect.arrayContaining([
				{ name: "read_document", classification: "read-only-hint", selected: true },
				{ name: "unknown_lookup", classification: "unknown", selected: false },
				{ name: "write_document", classification: "mutation-or-contradictory", selected: false },
				{ name: "delete_document", classification: "mutation-or-contradictory", selected: false },
			]));
			expect(adoption.operations?.find(operation => operation.name === "malformed_schema")).toBeUndefined();
			expect(adoption.conformance.mcp?.loadedTools).toEqual(["read_document"]);
			expect(adoption.conformance.mcp?.rejectedTools).toEqual(expect.arrayContaining([
			{ name: "malformed_schema", reason: "invalid_operation_schema" },
		]));
			expect(JSON.stringify(adoption)).not.toContain("must-not-echo");

			const duplicate = await adopt(input);
			expect(duplicate.status).toBe(200);
			expect(duplicate.adoption.id).toBe(adoption.id);
			expect((await list()).filter(item => item.id === adoption!.id)).toHaveLength(1);
		} finally {
			if (adoption) await remove(adoption);
		}
	});

	test("uses streamable HTTP negotiation while unreachable and invalid stock sources remain isolated", async () => {
		const fixture = await startHttpFixture();
		let healthy: Adoption | undefined;
		let unreachable: Adoption | undefined;
		try {
			healthy = (await adopt({ kind: "mcp", scope: "server", source: { transport: "http", url: fixture.endpoint } })).adoption;
			expect(healthy).toMatchObject({
				provenance: { class: "adopted", sourceType: "http", sourceLocation: fixture.endpoint },
				conformance: { state: "loaded", mcp: { negotiatedProtocol: "2024-11-05", serverName: "stock-http-fixture", serverVersion: "4.5.6", loadedTools: ["list_records"] } },
			});
			expect(healthy.operations).toEqual(expect.arrayContaining([
				{ name: "list_records", classification: "read-only-hint", selected: true },
				{ name: "discover_records", classification: "unknown", selected: false },
				{ name: "create_record", classification: "mutation-or-contradictory", selected: false },
			]));
			expect(healthy.conformance.mcp?.rejectedTools).toEqual(expect.arrayContaining([{ name: "bad_schema", reason: "invalid_operation_schema" }]));

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
		const first = await registerProject({ name: `adopt-first-${Date.now()}`, rootPath: path.join(root, "first"), seedWorkflows: false });
		const second = await registerProject({ name: `adopt-second-${Date.now()}`, rootPath: path.join(root, "second"), seedWorkflows: false });
		let adoption: Adoption | undefined;
		try {
			adoption = (await adopt({ kind: "skills", scope: "project", projectId: first.id, source: { directory: SKILLS_FIXTURE } })).adoption;
			expect(adoption).toMatchObject({
				kind: "skills",
				scope: "project",
				projectId: first.id,
				provenance: { class: "adopted", sourceType: "claude-skills-directory", sourceLocation: SKILLS_FIXTURE },
				conformance: {
					state: "partial",
					skills: {
						loadedSkills: ["inspect", "summarize"],
						rejectedSkills: expect.arrayContaining([
							{ reason: "malformed_frontmatter" },
							{ reason: "duplicate_name" },
							{ reason: "missing_skill_file" },
						]),
					},
				},
			});
			const prefix = `adopt-${adoption.id}--`;
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
