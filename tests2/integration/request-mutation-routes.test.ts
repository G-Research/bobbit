import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, createSession, defaultProject, deleteSession, rawApiFetch } from "./_e2e/e2e-setup.js";

const REPRO = "REQUEST_MUTATION_ROUTES";
const PACK_NAME = `request-mutation-routes-${process.pid}-${Date.now()}`;

function grantsPath(projectId: string): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

function route(sessionId: string, suffix: "prompt" | "tool-safety"): string {
	return `/api/sessions/${encodeURIComponent(sessionId)}/request-mutations/${suffix}`;
}

async function json(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

async function operatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	const cookie = cookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session=")) ?? "";
	expect(cookie, `${REPRO}: a browser-signaled operator request must mint a signed cookie`).not.toBe("");
	return cookie;
}

function writeFixturePack(headquartersDir: string): string {
	const dir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(dir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(dir, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${PACK_NAME}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "pack.yaml"), [
		"schema: 2", `name: ${PACK_NAME}`, "description: Request mutation route fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []",
		"  hooks: [request-mutation]", "  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "hooks", "request-mutation.yaml"), [
		"id: request.mutation", "module: ../lib/request-mutation.mjs", "events: [beforePrompt, beforeToolCall]",
		"mode: decide", "capabilities: [mutate]", "budget:", "  timeoutMs: 1000", "  maxTokens: 64",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(dir, "lib", "request-mutation.mjs"), `
export function decide(ctx) {
	if (ctx.event === "beforePrompt") {
		return { kind: "request-mutation", proposal: {
			kind: "prompt-shape", version: 1, intent: "redact",
			text: "Bearer route-after-secret-1234567890", reasonId: "fixture-prompt"
		} };
	}
	return { kind: "request-mutation", proposal: {
		kind: "tool-safety", version: 1,
		decision: ctx.tool?.name === "warn-tool" ? "warn" : "deny", tool: ctx.tool?.name,
		reasonId: "fixture-tool"
	} };
}
`, "utf-8");
	return dir;
}

test.describe("request mutation routes", () => {
	let packDir = "";
	let projectId = "";
	let sessionId = "";
	let cookie = "";

	test.beforeAll(async ({ gateway }) => {
		packDir = writeFixturePack(gateway.bobbitDir);
		projectId = (await defaultProject()).id;
		cookie = await operatorCookie();
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
		});
		expect(activation.status, `${REPRO}: fixture activation must refresh contributions`).toBe(200);
		const contributions = await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`));
		expect(contributions.packs?.find((pack: any) => pack.packId === PACK_NAME)?.hooks).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "request.mutation", mode: "decide", requestedCapabilities: expect.arrayContaining(["mutate"]) }),
		]));
	});

	test.beforeEach(async () => {
		sessionId = await createSession({ projectId });
	});

	test.afterAll(async () => {
		if (sessionId) await deleteSession(sessionId);
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
		}).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test("rejects malformed and oversized transient envelopes while ungranted hooks pass through", async () => {
		for (const body of [{}, { prompt: "" }, { prompt: "ok", systemPrompt: "must-not-be-accepted" }, { prompt: "x".repeat(32 * 1024 + 1) }]) {
			const response = await apiFetch(route(sessionId, "prompt"), { method: "POST", body: JSON.stringify(body) });
			expect(response.status, `${REPRO}: prompt envelope ${JSON.stringify(Object.keys(body))} must be bounded and closed`).toBe(400);
		}
		for (const body of [{}, { toolName: "has space" }, { toolName: "bash", arguments: { secret: "must-not-be-accepted" } }]) {
			const response = await apiFetch(route(sessionId, "tool-safety"), { method: "POST", body: JSON.stringify(body) });
			expect(response.status, `${REPRO}: tool envelope ${JSON.stringify(Object.keys(body))} must expose no arguments`).toBe(400);
		}

		const prompt = await apiFetch(route(sessionId, "prompt"), {
			method: "POST", body: JSON.stringify({ prompt: "password=route-before-secret-1234567890" }),
		});
		expect(prompt.status).toBe(200);
		expect(await json(prompt), `${REPRO}: missing exact mutate grant must not change the turn`).toEqual({ action: "pass" });
		const tool = await apiFetch(route(sessionId, "tool-safety"), { method: "POST", body: JSON.stringify({ toolName: "bash" }) });
		expect(tool.status).toBe(200);
		expect(await json(tool), `${REPRO}: missing exact mutate grant must not block tools`).toEqual({ action: "pass" });
	});

	test("requires a verified operator to grant or revoke mutation authority", async () => {
		const tuple = { packId: PACK_NAME, hookId: "request.mutation", capability: "mutate" };
		const unverifiedGrant = await rawApiFetch(grantsPath(projectId), { method: "PUT", body: JSON.stringify(tuple) });
		expect(unverifiedGrant.status, `${REPRO}: bearer transport alone must not grant per-turn mutation authority`).toBe(403);
		expect(await json(unverifiedGrant)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });

		const grant = await apiFetch(grantsPath(projectId), {
			method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify(tuple),
		});
		expect(grant.status, `${REPRO}: a verified operator may grant an active decide/mutate tuple`).toBe(200);

		const unverifiedRevoke = await rawApiFetch(`${grantsPath(projectId)}/${encodeURIComponent(PACK_NAME)}/request.mutation/mutate`, { method: "DELETE" });
		expect(unverifiedRevoke.status, `${REPRO}: bearer transport alone must not revoke mutation authority`).toBe(403);
		expect(await json(unverifiedRevoke)).toMatchObject({ code: "PROMPT_EXTENSION_OPERATOR_REQUIRED" });
		const preservedAuthority = await apiFetch(route(sessionId, "prompt"), {
			method: "POST", body: JSON.stringify({ prompt: "operator-only mutation authority" }),
		});
		expect(await json(preservedAuthority), `${REPRO}: a rejected revoke must leave the operator grant live`).toEqual({ action: "replace", text: "Bearer route-after-secret-1234567890" });

		const signedRevoke = await apiFetch(`${grantsPath(projectId)}/${encodeURIComponent(PACK_NAME)}/request.mutation/mutate`, {
			method: "DELETE", headers: { Cookie: cookie },
		});
		expect(signedRevoke.status, `${REPRO}: a verified operator may revoke mutation authority`).toBe(200);
		expect(await json(signedRevoke)).toMatchObject({ revoked: true });
		const revokedAuthority = await apiFetch(route(sessionId, "prompt"), {
			method: "POST", body: JSON.stringify({ prompt: "revoked mutation authority" }),
		});
		expect(await json(revokedAuthority), `${REPRO}: a signed revoke must immediately restore prompt pass-through`).toEqual({ action: "pass" });
	});

	test("returns only core prompt and tool decisions and exposes redacted audit rows to signed operators", async () => {
		const grant = await apiFetch(grantsPath(projectId), {
			method: "PUT", headers: { Cookie: cookie }, body: JSON.stringify({ packId: PACK_NAME, hookId: "request.mutation", capability: "mutate" }),
		});
		expect(grant.status, `${REPRO}: active decide/mutate declaration accepts its exact grant`).toBe(200);

		const prompt = await apiFetch(route(sessionId, "prompt"), {
			method: "POST", body: JSON.stringify({ prompt: "password=route-before-secret-1234567890" }),
		});
		expect(prompt.status).toBe(200);
		expect(await json(prompt)).toEqual({ action: "replace", text: "Bearer route-after-secret-1234567890" });

		const warning = await apiFetch(route(sessionId, "tool-safety"), { method: "POST", body: JSON.stringify({ toolName: "warn-tool" }) });
		expect(warning.status).toBe(200);
		expect(await json(warning), `${REPRO}: warnings remain non-blocking at the bridge boundary`).toEqual({ action: "pass" });
		const denied = await apiFetch(route(sessionId, "tool-safety"), { method: "POST", body: JSON.stringify({ toolName: "bash" }) });
		expect(denied.status).toBe(200);
		expect(await json(denied), `${REPRO}: a typed deny is the only blocking tool response`).toEqual({ action: "deny" });

		const unauthorized = await rawApiFetch(`/api/sessions/${sessionId}/request-mutation-audit`);
		expect(unauthorized.status, `${REPRO}: shared bearer transport authentication cannot read mutation evidence`).toBe(403);
		const audit = await apiFetch(`/api/sessions/${sessionId}/request-mutation-audit?limit=1`, { headers: { Cookie: cookie } });
		expect(audit.status).toBe(200);
		const entries = (await json(audit)).entries as Array<Record<string, unknown>>;
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ event: "beforeToolCall", outcome: "denied", reason: "Tool denied", toolName: "bash" });

		const promptAudit = await apiFetch(`/api/sessions/${sessionId}/request-mutation-audit?limit=200`, { headers: { Cookie: cookie } });
		const promptEntry = ((await json(promptAudit)).entries as Array<Record<string, unknown>>)
			.find(entry => entry.event === "beforePrompt" && entry.outcome === "applied");
		expect(promptEntry).toMatchObject({ reason: "Prompt shaped", before: expect.stringContaining("[REDACTED]"), after: expect.stringContaining("[REDACTED]") });
		expect(JSON.stringify(promptEntry)).not.toContain("route-before-secret-1234567890");
		expect(JSON.stringify(promptEntry)).not.toContain("route-after-secret-1234567890");
	});
});
