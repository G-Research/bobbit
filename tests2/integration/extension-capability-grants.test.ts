import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch, base, defaultProject } from "./_e2e/e2e-setup.js";
import fs from "node:fs";
import path from "node:path";

const PACK_NAME = `extension-grants-fixture-${Date.now()}`;
const DECIDE_HOOK = "decision.alpha";
const OTHER_DECIDE_HOOK = "decision.beta";
const OBSERVE_HOOK = "observe.audit";
const REPRO = "EXTENSION_CAPABILITY_GRANTS_API_REGRESSION";

let packDir = "";
let projectId = "";

function grantsPath(): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grants`;
}

function auditPath(): string {
	return `/api/projects/${encodeURIComponent(projectId)}/extension-grant-audit`;
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
			const response = await apiFetch(grantsPath(), { method: "PUT", body: JSON.stringify(body) });
			expect(response.status, `${REPRO}: client actor/timestamp and wildcard grant requests are never accepted`).toBe(400);
		}

		const inactive = await apiFetch(grantsPath(), {
			method: "PUT",
			body: JSON.stringify({ packId: PACK_NAME, hookId: "missing.hook", capability: "decide" }),
		});
		expect(inactive.status).toBe(404);
		expect((await json(inactive)).code).toBe("EXTENSION_HOOK_NOT_FOUND");

		const unsupported = await apiFetch(grantsPath(), {
			method: "PUT",
			body: JSON.stringify({ packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "mutate" }),
		});
		expect(unsupported.status, `${REPRO}: mutation is never implied by an active decision hook`).toBe(422);
		expect((await json(unsupported)).code).toBe("EXTENSION_CAPABILITY_UNSUPPORTED");
	});

	test("projects inert hook state, grants one exact hook, invalidates contribution state, and revokes without restart", async () => {
		const before = await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`);
		expect(before.status).toBe(200);
		const beforePack = fixturePack(await json(before));
		expect(hook(beforePack, DECIDE_HOOK)).toMatchObject({ mode: "decide", requestedCapabilities: ["decide", "store"], grants: [], runnable: false, status: "grant-required" });
		expect(hook(beforePack, OTHER_DECIDE_HOOK)).toMatchObject({ mode: "decide", requestedCapabilities: ["decide"], grants: [], runnable: false, status: "grant-required" });
		expect(hook(beforePack, OBSERVE_HOOK)).toMatchObject({ mode: "observe", requestedCapabilities: ["store"], grants: [], runnable: false, status: "observe" });

		const grant = await apiFetch(grantsPath(), {
			method: "PUT",
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
			method: "PUT",
			body: JSON.stringify({ packId: PACK_NAME, hookId: OBSERVE_HOOK, capability: "store" }),
		});
		expect(observeGrant.status).toBe(200);
		const afterObserveGrant = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterObserveGrant, OBSERVE_HOOK)).toMatchObject({ grants: ["store"], runnable: false, status: "observe" });

		const revoke = await apiFetch(`${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`, { method: "DELETE" });
		expect(revoke.status).toBe(200);
		expect((await json(revoke)).revoked).toBe(true);
		const afterRevoke = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterRevoke, DECIDE_HOOK)).toMatchObject({ grants: [], runnable: false, status: "grant-required" });

		const idempotent = await apiFetch(`${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`, { method: "DELETE" });
		expect(idempotent.status).toBe(200);
		expect((await json(idempotent)).revoked, `${REPRO}: exact DELETE is idempotent after live revocation`).toBe(false);
	});

	test("recovers a failed revoke audit through an exact retry without auditing no-op deletes", async () => {
		const revokePath = `${grantsPath()}/${encodeURIComponent(PACK_NAME)}/${encodeURIComponent(DECIDE_HOOK)}/decide`;
		// Make this test independent of the preceding journey's final state.
		await apiFetch(revokePath, { method: "DELETE" });
		const grant = await apiFetch(grantsPath(), {
			method: "PUT",
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
			failedRevoke = await apiFetch(revokePath, { method: "DELETE" });
		} finally {
			fs.appendFileSync = originalAppend;
		}
		expect(failedRevoke!.status, `${REPRO}: revoke authority must be removed even when its audit append fails`).toBe(503);
		expect((await json(failedRevoke!))).toMatchObject({ code: "EXTENSION_GRANT_AUDIT_UNAVAILABLE", revoked: true });
		const afterFailedRevoke = fixturePack(await json(await apiFetch(`/api/ext/contributions?projectId=${encodeURIComponent(projectId)}`)));
		expect(hook(afterFailedRevoke, DECIDE_HOOK)).toMatchObject({ grants: [], runnable: false, status: "grant-required" });

		const recovered = await apiFetch(revokePath, { method: "DELETE" });
		expect(recovered.status, `${REPRO}: exact retry must drain the durable revoke-audit outbox`).toBe(200);
		expect((await json(recovered)).revoked).toBe(true);
		const afterRecovery = (await json(await apiFetch(auditPath()))).entries
			.filter((entry: any) => entry.action === "revoked" && entry.packId === PACK_NAME && entry.hookId === DECIDE_HOOK && entry.capability === "decide");
		expect(afterRecovery).toHaveLength(before.length + 1);
		expect(afterRecovery.at(-1)).toMatchObject({ action: "revoked", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" });
		expect(Object.keys(afterRecovery.at(-1)).sort()).toEqual(["action", "actor", "at", "capability", "hookId", "packId"]);

		const noOp = await apiFetch(revokePath, { method: "DELETE" });
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
			expect.objectContaining({ action: "granted", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
			expect.objectContaining({ action: "granted", actor: "admin", packId: PACK_NAME, hookId: OBSERVE_HOOK, capability: "store" }),
			expect.objectContaining({ action: "revoked", actor: "admin", packId: PACK_NAME, hookId: DECIDE_HOOK, capability: "decide" }),
		]));
		for (const entry of entries) {
			expect(Object.keys(entry).sort(), `${REPRO}: audit rows must contain only the safe administrative tuple`).toEqual(["action", "actor", "at", "capability", "hookId", "packId"]);
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
