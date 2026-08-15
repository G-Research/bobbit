import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, defaultProject } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";
import { resolveBudgetEnforcement } from "../../src/server/agent/budget-enforcement.js";
import { DecisionHookDispatcher, DecisionRequestManager } from "../../src/server/agent/decision-request-manager.js";
import type { AdvisoryThinkingConsumer } from "../../src/server/agent/advisory-thinking-consumer.js";
import type { ResolvedHook } from "../../src/server/agent/extension-grant-policy.js";
import type { PackContributionRegistry } from "../../src/server/extension-host/pack-contribution-registry.js";
import type { ModuleHost } from "../../src/server/extension-host/module-host-worker.js";

const PACK_NAME = `extension-grants-fixture-${Date.now()}`;
const DECIDE_HOOK = "decision.alpha";
const OTHER_DECIDE_HOOK = "decision.beta";
const OBSERVE_HOOK = "observe.audit";
const REPRO = "EXTENSION_CAPABILITY_GRANTS_API_REGRESSION";

let packDir = "";
let projectId = "";
let humanCookie = "";

function operatorHeaders(): Record<string, string> {
	return { Cookie: humanCookie };
}

function grantsPath(): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

function auditPath(): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grant-audit`;
}

function settingsPath(): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-settings`;
}

function writeFixturePack(headquartersDir: string): void {
	packDir = path.join(headquartersDir, "config", "market-packs", PACK_NAME);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: test",
		"sourceRef: local",
		"commit: fixture",
		`packName: ${PACK_NAME}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n", "utf-8");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2",
		`name: ${PACK_NAME}`,
		"description: Extension grants integration fixture",
		"version: 1.0.0",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: []",
		"  hooks: [decision-alpha, decision-beta, observe-audit]",
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
	].join("\n") + "\n", "utf-8");
	const hook = (id: string, mode: "decide" | "observe", capabilities: string[]) => [
		`id: ${id}`,
		"module: ../lib/inert-hook.mjs",
		"events: [beforePrompt]",
		`mode: ${mode}`,
		`capabilities: [${capabilities.join(", ")}]`,
	].join("\n") + "\n";
	fs.writeFileSync(path.join(packDir, "hooks", "decision-alpha.yaml"), hook(DECIDE_HOOK, "decide", ["store"]), "utf-8");
	fs.writeFileSync(path.join(packDir, "hooks", "decision-beta.yaml"), hook(OTHER_DECIDE_HOOK, "decide", []), "utf-8");
	fs.writeFileSync(path.join(packDir, "hooks", "observe-audit.yaml"), hook(OBSERVE_HOOK, "observe", ["store"]), "utf-8");
	// The contribution loader must never import this marker: hook declarations are metadata only.
	fs.writeFileSync(path.join(packDir, "lib", "inert-hook.mjs"), "throw new Error('fixture hook must stay inert');\n", "utf-8");
}

async function json(response: Response): Promise<any> {
	const text = await response.text();
	return text ? JSON.parse(text) : {};
}

function fixturePack(body: any): any {
	const pack = (body.packs ?? []).find((candidate: any) => candidate.packId === PACK_NAME);
	expect(pack, `${REPRO}: active fixture pack must appear in contribution projection`).toBeTruthy();
	return pack;
}

function hook(pack: any, id: string): any {
	const value = (pack.hooks ?? []).find((candidate: any) => candidate.id === id);
	expect(value, `${REPRO}: active hook ${id} must remain visible in the contribution projection`).toBeTruthy();
	return value;
}

test.describe("extension capability grants API", () => {
	test.beforeAll(async ({ gateway }) => {
		const project = await defaultProject();
		projectId = project.id;
		const cookieProbe = await apiFetch("/api/goals", {
			headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
		});
		const setCookies = (cookieProbe.headers as any).getSetCookie?.() as string[] | undefined
			?? (cookieProbe.headers.get("set-cookie") ? [cookieProbe.headers.get("set-cookie") as string] : []);
		humanCookie = setCookies.map(cookie => cookie.split(";")[0]).find(cookie => cookie.startsWith("bobbit_session=")) ?? "";
		expect(humanCookie, `${REPRO}: browser-signaled gateway principal must mint a signed operator cookie`).not.toBe("");
		writeFixturePack(gateway.bobbitDir);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
		});
		expect(activation.status, `${REPRO}: fixture activation refresh failed; body=${await activation.clone().text()}`).toBe(200);
	});

	test.afterAll(async () => {
		await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
		}).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
	});

	test("requires authentication and rejects client authority, wildcards, inactive hooks, and unsupported capabilities", async () => {
		const anonymous = await fetch(`${base()}${grantsPath()}`);
		expect(anonymous.status, `${REPRO}: grant administrative reads require the gateway principal`).toBe(401);

		for (const body of [
			{ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide", grantedBy: "attacker" },
			{ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide", grantedAt: "2000-01-01T00:00:00.000Z" },
			{ packId: "*", hookId: DECIDE_HOOK, capability: "decide" },
		]) {
			const response = await apiFetch(grantsPath(), { method: "PUT", headers: operatorHeaders(), body: JSON.stringify(body) });
			expect(response.status, `${REPRO}: client actor/timestamp and wildcard grant requests are never accepted`).toBe(400);
		}

		const inactive = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: "missing.hook", capability: "decide" }),
		});
		expect(inactive.status).toBe(404);
		expect((await json(inactive)).code).toBe("EXTENSION_HOOK_NOT_FOUND");

		const unsupported = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "mutate" }),
		});
		expect(unsupported.status, `${REPRO}: mutation is never implied by an active decision hook`).toBe(422);
		expect((await json(unsupported)).code).toBe("EXTENSION_CAPABILITY_UNSUPPORTED");

		for (const capability of ["service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all"]) {
			const packOnly = await apiFetch(grantsPath(), {
				method: "PUT", headers: operatorHeaders(),
				body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability }),
			});
			expect(packOnly.status, `${REPRO}: hook routes explicitly reject pack-only ${capability} authority`).toBe(422);
			expect((await json(packOnly)).code).toBe("EXTENSION_CAPABILITY_UNSUPPORTED");
		}
	});

	test("requires signed operator consent for exact active pack grants and revokes the pack tuple", async () => {
		const packGrant = { packId: PACK_NAME, principal: "pack", capability: "memory.read" };
		for (const capability of ["service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all"]) {
			const anonymousMutation = await apiFetch(grantsPath(), {
				method: "PUT", body: JSON.stringify({ packId: PACK_NAME, principal: "pack", capability }),
			});
			expect(anonymousMutation.status, `${REPRO}: every pack capability mutation requires a verified signed operator cookie`).toBe(403);
			expect((await json(anonymousMutation)).code).toBe("PROMPT_EXTENSION_OPERATOR_REQUIRED");
		}

		for (const body of [
			{ ...packGrant, hookId: DECIDE_HOOK },
			{ packId: PACK_NAME, principal: "pack", capability: "unknown.authority" },
			{ packId: PACK_NAME, principal: "pack", capability: "decide" },
		]) {
			const response = await apiFetch(grantsPath(), { method: "PUT", headers: operatorHeaders(), body: JSON.stringify(body) });
			expect(response.status, `${REPRO}: pack tuples admit only their exact closed principal/capability matrix`).toBe(body.capability === "decide" ? 422 : 400);
		}
		const absentPack = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(), body: JSON.stringify({ packId: "missing.pack", principal: "pack", capability: "memory.read" }),
		});
		expect(absentPack.status).toBe(404);
		expect((await json(absentPack)).code).toBe("EXTENSION_GRANT_PRINCIPAL_NOT_FOUND");

		const settingsBefore = await apiFetch(settingsPath());
		expect(settingsBefore.status).toBe(200);
		const packTargetBefore = (await json(settingsBefore)).targets.find((candidate: any) =>
			candidate.ref?.packId === PACK_NAME && candidate.ref?.kind === "pack",
		);
		expect(packTargetBefore, `${REPRO}: the existing Market Pack target must expose the server-owned pack grant projection`).toMatchObject({
			ref: { packId: PACK_NAME, kind: "pack", id: PACK_NAME },
			packGrant: {
				requestedCapabilities: ["service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all", "sandbox:build"],
				grants: [],
			},
		});

		const granted = await apiFetch(grantsPath(), { method: "PUT", headers: operatorHeaders(), body: JSON.stringify(packGrant) });
		expect(granted.status).toBe(200);
		expect((await json(granted)).grant).toMatchObject({ ...packGrant, grantedBy: "admin" });
		const projection = await apiFetch(grantsPath());
		const activePack = (await json(projection)).packs.find((candidate: any) => candidate.packId === PACK_NAME);
		expect(activePack).toMatchObject({ requestedCapabilities: expect.arrayContaining(["memory.read", "memory.read.all", "service.manage"]), grants: ["memory.read"] });
		const settingsAfterGrant = await apiFetch(settingsPath());
		const packTargetAfterGrant = (await json(settingsAfterGrant)).targets.find((candidate: any) =>
			candidate.ref?.packId === PACK_NAME && candidate.ref?.kind === "pack",
		);
		expect(packTargetAfterGrant?.packGrant?.grants).toEqual(["memory.read"]);

		const revoke = await apiFetch(`${grantsPath()}/${encodeURIComponent(PACK_NAME)}/principals/pack/memory.read`, { method: "DELETE", headers: operatorHeaders() });
		expect(revoke.status, `${REPRO}: pack principal revoke must target only its exact tuple`).toBe(200);
		expect((await json(revoke)).revoked).toBe(true);
		const settingsAfterRevoke = await apiFetch(settingsPath());
		const packTargetAfterRevoke = (await json(settingsAfterRevoke)).targets.find((candidate: any) =>
			candidate.ref?.packId === PACK_NAME && candidate.ref?.kind === "pack",
		);
		expect(packTargetAfterRevoke?.packGrant?.grants, `${REPRO}: the Pack target must re-read the live resolver after revocation`).toEqual([]);
	});

	test("projects inert hook state, grants one exact hook, invalidates contribution state, and revokes without restart", async () => {
		const before = await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`);
		expect(before.status).toBe(200);
		const beforePack = fixturePack(await json(before));
		expect(hook(beforePack, DECIDE_HOOK)).toMatchObject({ mode: "decide", requestedCapabilities: ["decide", "store"], grants: [], runnable: false, status: "grant-required" });
		expect(hook(beforePack, OTHER_DECIDE_HOOK)).toMatchObject({ mode: "decide", requestedCapabilities: ["decide"], grants: [], runnable: false, status: "grant-required" });
		expect(hook(beforePack, OBSERVE_HOOK)).toMatchObject({ mode: "observe", requestedCapabilities: ["store"], grants: [], runnable: false, status: "observe" });

		const grant = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		});
		expect(grant.status).toBe(200);
		const granted = await json(grant);
		expect(granted.grant).toMatchObject({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide", grantedBy: "admin" });
		expect(new Date(granted.grant.grantedAt).toISOString()).toBe(granted.grant.grantedAt);

		const afterGrant = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterGrant, DECIDE_HOOK)).toMatchObject({ grants: ["decide"], runnable: true, status: "granted" });
		expect(hook(afterGrant, OTHER_DECIDE_HOOK)).toMatchObject({ grants: [], runnable: false, status: "grant-required" });

		const observeGrant = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: OBSERVE_HOOK, capability: "store" }),
		});
		expect(observeGrant.status).toBe(200);
		const afterObserveGrant = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterObserveGrant, OBSERVE_HOOK)).toMatchObject({ grants: ["store"], runnable: false, status: "observe" });

		const revoke = await apiFetch(`${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`, { method: "DELETE", headers: operatorHeaders() });
		expect(revoke.status).toBe(200);
		expect((await json(revoke)).revoked).toBe(true);
		const afterRevoke = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterRevoke, DECIDE_HOOK)).toMatchObject({ grants: [], runnable: false, status: "grant-required" });

		const idempotent = await apiFetch(`${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`, { method: "DELETE", headers: operatorHeaders() });
		expect(idempotent.status).toBe(200);
		expect((await json(idempotent)).revoked, `${REPRO}: exact DELETE is idempotent after live revocation`).toBe(false);
	});

	test("denies simulated worker re-application after live grant revocation without a restart", async () => {
		const revokePath = `${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`;
		await apiFetch(revokePath, { method: "DELETE" });
		const grantedResponse = await apiFetch(grantsPath(), {
			method: "PUT",
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		});
		expect(grantedResponse.status).toBe(200);
		const granted = await json(grantedResponse);
		const activeHooks: ResolvedHook[] = [{ packId: PACK_NAME, hookId: DECIDE_HOOK, mode: "decide", capabilities: [] }];
		const request = { sessionId: "grant-journey", consumerId: "budget-consumer", operationId: "worker-result-1", fallback: "halt" as const };
		const workerResult = [{ source: { packId: PACK_NAME, hookId: DECIDE_HOOK }, proposal: { disposition: "allow", ruleId: "safe-rule" } }];

		expect(resolveBudgetEnforcement(request, activeHooks, [granted.grant], workerResult)).toMatchObject({
			disposition: "allow", permitsOperation: true, audit: { grantDenied: 0 },
		});
		const revoked = await apiFetch(revokePath, { method: "DELETE" });
		expect(revoked.status).toBe(200);
		expect((await json(revoked)).revoked).toBe(true);
		expect(resolveBudgetEnforcement(request, activeHooks, [], workerResult)).toMatchObject({
			disposition: "halt", permitsOperation: false, audit: { grantDenied: 1 },
		});
	});

	test("rechecks exact grants and the active registry before applying an in-flight advisory selection", async () => {
		const grantPath = grantsPath();
		const revokePath = `${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`;
		await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		const granted = await apiFetch(grantPath, {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		});
		expect(granted.status).toBe(200);
		let liveGrants = [(await json(granted)).grant];
		let active = true;
		let imports = 0;
		let applied = 0;
		let releaseWorker: (() => void) | undefined;
		let workerStarted: (() => void) | undefined;
		const workerStartedPromise = new Promise<void>((resolve) => { workerStarted = resolve; });
		const workerReleasePromise = new Promise<void>((resolve) => { releaseWorker = resolve; });
		const decisionHook = {
			id: DECIDE_HOOK, mode: "decide", events: ["afterTurn"], packRoot: `/packs/${PACK_NAME}`,
			sourceFile: `/packs/${PACK_NAME}/hooks/decision.yaml`, module: "decision.mjs", capabilities: [],
			budget: { timeoutMs: 100, maxTokens: 1 }, listName: "decision-alpha",
		};
		const registry = {
			list: () => active ? [{ packId: PACK_NAME, hooks: [decisionHook] }] : [],
			listHooks: () => active ? [decisionHook] : [],
		} as unknown as PackContributionRegistry;
		const moduleHost = {
			invoke: async () => {
				imports++;
				workerStarted!();
				await workerReleasePromise;
				return { kind: "selection", selection: { kind: "thinking", thinkingLevel: "low" } };
			},
		} as unknown as ModuleHost;
		const thinkingConsumer = {
			apply: async () => {
				applied++;
				return { status: "applied" as const, effectiveThinkingLevel: "low" as const };
			},
		} as unknown as AdvisoryThinkingConsumer;
		const dispatcher = new DecisionHookDispatcher({
			manager: new DecisionRequestManager({ storeForProject: () => undefined }),
			registry, moduleHost, grantsForProject: () => liveGrants,
			availabilityForProject: () => ({ models: [], thinkingLevels: ["low"], roles: [], workflows: [] }),
			thinkingConsumer,
		});
		const context = { projectId, sessionId: "selection-grant-session", cwd: "/work" };
		const inFlight = dispatcher.dispatch("afterTurn", context);
		await workerStartedPromise;
		const revoked = await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		expect(revoked.status).toBe(200);
		expect((await json(revoked)).revoked).toBe(true);
		liveGrants = [];
		releaseWorker!();
		await expect(inFlight).resolves.toMatchObject([{ outcome: "denied", reason: "Grant required", selectionKind: "thinking" }]);
		expect(applied, `${REPRO}: a revoked grant cannot apply a worker result already in flight`).toBe(0);

		// The same dispatcher must see the restored exact grant without a restart.
		const restored = await apiFetch(grantPath, {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		});
		expect(restored.status).toBe(200);
		liveGrants = [(await json(restored)).grant];
		const appliedAfterRestore = dispatcher.dispatch("afterTurn", context);
		await appliedAfterRestore;
		// The first invocation gate is intentionally released; a fresh dispatcher
		// run completes synchronously through the already-settled worker promise.
		expect(applied).toBe(1);

		const disabled = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { hooks: ["decision-alpha"] } }),
		});
		expect(disabled.status).toBe(200);
		active = false;
		await expect(dispatcher.dispatch("afterTurn", context)).resolves.toEqual([]);
		expect(imports).toBe(2);
		expect(applied, `${REPRO}: an activation-disabled hook is not imported or applied by an already-created dispatcher`).toBe(1);
		const reenabled = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: {} }),
		});
		expect(reenabled.status).toBe(200);
	});

	test("uses the current active-pack order to resolve advisory priority without a dispatcher restart", async () => {
		const hook = (packId: string, hookId: string) => ({
			id: hookId, mode: "decide", events: ["beforePrompt"], packRoot: `/packs/${packId}`,
			sourceFile: `/packs/${packId}/hooks/${hookId}.yaml`, module: "decision.mjs", capabilities: [],
			budget: { timeoutMs: 100, maxTokens: 1 }, listName: hookId,
		});
		const low = hook("priority-low", "decision.alpha");
		const high = hook("priority-high", "decision.beta");
		let packs = [{ packId: "priority-low", hooks: [low] }, { packId: "priority-high", hooks: [high] }];
		const registry = {
			list: () => packs,
			listHooks: () => packs.flatMap((pack) => pack.hooks),
		} as unknown as PackContributionRegistry;
		const dispatcher = new DecisionHookDispatcher({
			manager: new DecisionRequestManager({ storeForProject: () => undefined }),
			registry,
			moduleHost: { invoke: async () => ({ kind: "selection", selection: { kind: "role", roleName: "operator" } }) } as unknown as ModuleHost,
			grantsForProject: () => [
				{ packId: "priority-low", hookId: "decision.alpha", capability: "decide" as const, grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" },
				{ packId: "priority-high", hookId: "decision.beta", capability: "decide" as const, grantedAt: "2026-01-01T00:00:00.000Z", grantedBy: "admin" },
			],
			availabilityForProject: () => ({ models: [], thinkingLevels: [], roles: ["operator"], workflows: [] }),
		});
		const context = { projectId, sessionId: "priority-session", cwd: "/work" };
		const highWins = await dispatcher.dispatch("beforePrompt", context);
		expect(highWins).toEqual(expect.arrayContaining([
			expect.objectContaining({ packId: "priority-high", outcome: "advised", selectionKind: "role", selectionValue: "operator" }),
			expect.objectContaining({ packId: "priority-low", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "role" }),
		]));

		packs = [{ packId: "priority-high", hooks: [high] }, { packId: "priority-low", hooks: [low] }];
		const lowWinsAfterLivePriorityChange = await dispatcher.dispatch("beforePrompt", context);
		expect(lowWinsAfterLivePriorityChange).toEqual(expect.arrayContaining([
			expect.objectContaining({ packId: "priority-low", outcome: "advised", selectionKind: "role", selectionValue: "operator" }),
			expect.objectContaining({ packId: "priority-high", outcome: "superseded", reason: "Lower-priority selection", selectionKind: "role" }),
		]));
	});

	test("recovers a failed revoke audit through an exact retry without auditing no-op deletes", async () => {
		const revokePath = `${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`;
		// Make this test independent of the preceding journey's final state.
		await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		const grant = await apiFetch(grantsPath(), {
			method: "PUT", headers: operatorHeaders(),
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		});
		expect(grant.status).toBe(200);
		const before = (await json(await apiFetch(auditPath()))).entries
			.filter((entry: any) => entry.action === "revoked" && entry.packId === PACK_NAME && entry.hookId === DECIDE_HOOK && entry.capability === "decide");

		const originalAppend = fs.appendFileSync.bind(fs);
		let failOnce = true;
		fs.appendFileSync = ((...args: any[]) => {
			if (failOnce && String(args[0]).endsWith("extension-capability-audit.jsonl")) {
				failOnce = false;
				throw new Error("AUDIT_WRITE_SECRET=must-not-leak");
			}
			return (originalAppend as any)(...args);
		}) as typeof fs.appendFileSync;
		let failedRevoke: Response;
		try {
			failedRevoke = await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		} finally {
			fs.appendFileSync = originalAppend;
		}
		expect(failedRevoke!.status, `${REPRO}: revoke authority must be removed even when its audit append fails`).toBe(503);
		expect((await json(failedRevoke!))).toMatchObject({ code: "EXTENSION_GRANT_AUDIT_UNAVAILABLE", revoked: true });
		const afterFailedRevoke = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterFailedRevoke, DECIDE_HOOK)).toMatchObject({ grants: [], runnable: false, status: "grant-required" });

		const recovered = await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		expect(recovered.status, `${REPRO}: exact retry must drain the durable revoke-audit outbox`).toBe(200);
		expect((await json(recovered)).revoked).toBe(true);
		const afterRecovery = (await json(await apiFetch(auditPath()))).entries
			.filter((entry: any) => entry.action === "revoked" && entry.packId === PACK_NAME && entry.hookId === DECIDE_HOOK && entry.capability === "decide");
		expect(afterRecovery).toHaveLength(before.length + 1);
		expect(afterRecovery.at(-1)).toMatchObject({ action: "revoked", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" });
		expect(Object.keys(afterRecovery.at(-1)).sort()).toEqual(["action", "actor", "at", "capability", "hookId", "packId"]);

		const noOp = await apiFetch(revokePath, { method: "DELETE", headers: operatorHeaders() });
		expect(noOp.status).toBe(200);
		expect((await json(noOp)).revoked).toBe(false);
		const afterNoOp = (await json(await apiFetch(auditPath()))).entries
			.filter((entry: any) => entry.action === "revoked" && entry.packId === PACK_NAME && entry.hookId === DECIDE_HOOK && entry.capability === "decide");
		expect(afterNoOp).toHaveLength(afterRecovery.length);
	});

	test("keeps an append-only secret-free audit and excludes activation-disabled hooks", async () => {
		const audit = await apiFetch(auditPath());
		expect(audit.status).toBe(200);
		const entries = (await json(audit)).entries;
		expect(entries).toEqual(expect.arrayContaining([
			expect.objectContaining({ action: "granted", actor: "admin", packId: PACK_NAME, principal: "pack", capability: "memory.read" }),
			expect.objectContaining({ action: "revoked", actor: "admin", packId: PACK_NAME, principal: "pack", capability: "memory.read" }),
			expect.objectContaining({ action: "granted", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
			expect.objectContaining({ action: "granted", actor: "admin", packId: PACK_NAME, hookId: OBSERVE_HOOK, capability: "store" }),
			expect.objectContaining({ action: "revoked", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		]));
		for (const entry of entries) {
			expect(Object.keys(entry).sort(), `${REPRO}: audit rows must contain only the safe administrative tuple`).toEqual(
				entry.principal === "pack"
					? ["action", "actor", "at", "capability", "packId", "principal"]
					: ["action", "actor", "at", "capability", "hookId", "packId"],
			);
			expect(new Date(entry.at).toISOString()).toBe(entry.at);
		}
		expect(JSON.stringify(entries)).not.toContain("attacker");
		expect(JSON.stringify(entries)).not.toContain("2000-01-01");

		const disable = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT",
			body: JSON.stringify({ scope: "server", packName: PACK_NAME, disabled: { hooks: ["decision-alpha"] } }),
		});
		expect(disable.status).toBe(200);
		const afterDisable = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect((afterDisable.hooks ?? []).some((candidate: any) => candidate.id === DECIDE_HOOK), `${REPRO}: activation remains a ceiling and removes disabled hook metadata`).toBe(false);
		expect(hook(afterDisable, OTHER_DECIDE_HOOK)).toBeTruthy();
	});
});
