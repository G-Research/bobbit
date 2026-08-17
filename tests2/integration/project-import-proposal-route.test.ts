import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { projectImportApplicationKey, projectImportSnapshotSha256 } from "../../src/server/proposals/project-import-proposal-application.ts";
import { proposalDraftOwnerId } from "../../src/server/proposals/proposal-seed-service.ts";
import { readSnapshot } from "../../src/server/proposals/proposal-files.ts";
import type { ProjectContext } from "../../src/server/agent/project-context.ts";
function auditRows(stateDir: string, projectId: string, importId: string): Array<{ auditKey?: string }> {
	const file = path.join(stateDir, "session-context-trace", "project-import", projectId, `${importId}.jsonl`);
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { auditKey?: string }) : [];
}

const PACK_ID = `project-import-route-proof-${process.pid}-${Date.now()}`;
const EFFECTS = [
	["goal", { title: "Route import goal", spec: "Created by the project-import accept route.", workflow: { id: "route-import-goal", name: "Route import goal", gates: [{ id: "implementation", name: "Implementation", verify: [] }] } }],
	["project", { name: "Route import project", config: { build_command: "echo route-import" } }],
	["workflow", { id: "route-import-workflow", name: "Route import workflow", gates: [{ id: "implementation", name: "Implementation", verify: [] }] }],
	["role", { name: "route-import-role", label: "Route import role", prompt: "Created by the canonical import route." }],
	["tool", { tool: "route-import-tool", action: "create", content: "name: route-import-tool\ndescription: A route-import tool\ngroup: import-route\nparams: []\n" }],
	["staff", { name: "route-import-staff", prompt: "Created by the canonical import route.", role: "route-staff-prerequisite" }],
] as const;
type EffectType = typeof EFFECTS[number][0];

function writePack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_ID);
	fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), `sourceUrl: test\nsourceRef: local\ncommit: fixture\npackName: ${PACK_ID}\nversion: 1.0.0\ninstalledAt: '2026-01-01T00:00:00.000Z'\nupdatedAt: '2026-01-01T00:00:00.000Z'\nscope: server\n`);
	fs.writeFileSync(path.join(packDir, "pack.yaml"), `schema: 2\nname: ${PACK_ID}\ndescription: Real import proposal route proof\nversion: 1.0.0\ncontents:\n  roles: []\n  tools: []\n  skills: []\n  entrypoints: []\n  providers: []\n  hooks: [${EFFECTS.map(([type]) => `route-${type}`).join(", ")}]\n  mcp: []\n  pi-extensions: []\n  runtimes: []\n  workflows: []\n`);
	for (const [type, args] of EFFECTS) {
		const hookId = `route-${type}`;
		fs.writeFileSync(path.join(packDir, "hooks", `${hookId}.yaml`), `id: ${hookId}\nmodule: ../lib/${hookId}.mjs\nevents: [projectImported]\nmode: decide\ncapabilities: []\nbudget: { maxTokens: 64, timeoutMs: 1000 }\n`);
		fs.writeFileSync(path.join(packDir, "lib", `${hookId}.mjs`), `
const deadline = () => new Date(Date.now() + 10 * 60_000).toISOString();
export default { decide(ctx) {
  return { kind: "request", request: {
    version: 1, key: ${JSON.stringify(`route-${type}`)}, title: ${JSON.stringify(`Route ${type}`)}, question: ${JSON.stringify(`ROUTE_IMPORT_${type}`)},
    options: [{ value: "apply", label: "Apply" }, { value: "skip", label: "Skip" }], other: { maxLength: 16 }, requestedClass: "consent-required",
    scope: "project", deadlineAt: deadline(), effect: { kind: "proposal", proposals: {
      apply: { proposalType: ${JSON.stringify(type)}, args: ${JSON.stringify(type === "project" ? { ...args, projectId: "__PROJECT__" } : args)} }
    }, noEffectValues: ["skip", "other"] },
  } };
} };
`.replace('"__PROJECT__"', "ctx.projectId"));
	}
	return packDir;
}

async function json<T>(response: Response): Promise<T> {
	const body = await response.text();
	if (!body) throw new Error(`Expected JSON, got ${response.status}`);
	return JSON.parse(body) as T;
}

async function operatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" } });
	const values = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie")!] : []);
	const cookie = values.map(value => value.split(";", 1)[0]).find(value => value.startsWith("bobbit_session="));
	if (!cookie) throw new Error("route proof could not mint prompt-operator cookie");
	return cookie;
}

async function proposals(projectId: string, cookie: string): Promise<Array<{ requestId: string; proposalType: EffectType; rev: number }>> {
	const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals`, { headers: { Cookie: cookie } });
	expect(response.status, await response.clone().text()).toBe(200);
	return (await json<{ proposals: Array<{ requestId: string; proposalType: EffectType; rev: number }> }>(response)).proposals;
}

test.describe("project-import proposal route — canonical effects", () => {
	let packDir = "";
	let order: string[] = [];

	test.beforeAll(async ({ gateway }) => {
		order = (await json<{ order: string[] }>(await apiFetch("/api/marketplace/pack-order?scope=server"))).order;
		packDir = writePack(gateway.bobbitDir);
		expect((await apiFetch("/api/marketplace/pack-order", { method: "PUT", body: JSON.stringify({ scope: "server", order }) })).status).toBe(200);
		expect((await apiFetch("/api/marketplace/pack-activation", { method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { hooks: [] } }) })).status).toBe(200);
	});

	test.afterAll(async () => {
		await apiFetch("/api/marketplace/pack-activation", { method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }) }).catch(() => {});
		if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
		await apiFetch("/api/marketplace/pack-order", { method: "PUT", body: JSON.stringify({ scope: "server", order }) }).catch(() => {});
	});

	test("projects all six types then accepts them through the authenticated HTTP route exactly once", async ({ gateway }) => {
		const roots: string[] = [];
		const projectIds: string[] = [];
		const cookie = await operatorCookie();
		try {
			for (const [type] of EFFECTS) {
				const root = path.join(gateway.bobbitDir, `route-proof-${type}-${Date.now()}`);
				roots.push(root);
				fs.mkdirSync(root, { recursive: true });
				const created = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ name: `route-proof-${type}`, rootPath: root, components: [{ name: "app", repo: "." }], __e2e_seed_skip__: true }) });
				expect(created.status, await created.clone().text()).toBe(201);
				const projectId = (await json<{ id: string }>(created)).id;
				projectIds.push(projectId);
				const grant = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, { method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: `route-${type}`, capability: "decide" }) });
				expect(grant.status, await grant.clone().text()).toBe(200);
				const requests = await json<{ requests: Array<{ id: string }> }>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests?state=pending`));
				expect(requests.requests).toHaveLength(1);
				const answer = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(requests.requests[0]!.id)}/answer`, { method: "POST", body: JSON.stringify({ value: { kind: "option", value: "apply" } }) });
				expect(answer.status, await answer.clone().text()).toBe(200);
				const [draft] = await proposals(projectId, cookie);
				expect(draft).toMatchObject({ proposalType: type });
				const accept = () => apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft!.requestId)}/${type}/accept`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft!.rev }) });
				if (type === "goal") {
					const concurrent = await Promise.all([accept(), accept()]);
					const statuses = concurrent.map(response => response.status);
					expect(statuses).toContain(201);
					expect(statuses.every(status => status === 200 || status === 201 || status === 202)).toBe(true);
					expect((await accept()).status).toBe(200);
				} else if (type === "staff") {
					// A deterministic canonical rejection releases the durable claim.
					// The identical immutable snapshot succeeds once its real shared-owner
					// prerequisite is installed through the public role route.
					expect((await accept()).status).toBe(404);
					expect((await apiFetch("/api/roles", { method: "POST", body: JSON.stringify({ projectId, name: "route-staff-prerequisite", label: "Staff prerequisite", promptTemplate: "A role installed after the first accept." }) })).status).toBe(201);
					expect((await accept()).status).toBe(201);
				} else expect((await accept()).status).toBe(201);
				const context = gateway.projectContextManager.getOrCreate(projectId)!;
				if (type === "goal") expect(context.goalManager.listGoals().filter((item: any) => item.title === "Route import goal")).toHaveLength(1);
				if (type === "workflow") expect(context.workflowStore.get("route-import-workflow")).toMatchObject({ name: "Route import workflow" });
				if (type === "role") expect(context.roleStore.get("route-import-role")).toMatchObject({ label: "Route import role" });
				if (type === "tool") expect(context.toolManager.getLocalTools()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "route-import-tool" })]));
				if (type === "staff") expect((await json<{ staff: Array<{ name: string }> }>(await apiFetch(`/api/staff?projectId=${encodeURIComponent(projectId)}`))).staff).toEqual(expect.arrayContaining([expect.objectContaining({ name: "route-import-staff" })]));
				if (type === "project") expect((await json<{ name: string }>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`))).name).toBe("Route import project");
				expect(await proposals(projectId, cookie)).toEqual([]);
			}
		} finally {
			await Promise.all(projectIds.map(projectId => apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {})));
			for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("crash-restart adopts an exact applying import claim once without context warmup", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `route-recovery-${Date.now()}`);
		fs.mkdirSync(root, { recursive: true });
		let projectId = "";
		try {
			const created = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ name: "route-recovery", rootPath: root, components: [{ name: "app", repo: "." }], __e2e_seed_skip__: true }) });
			expect(created.status, await created.clone().text()).toBe(201);
			projectId = (await json<{ id: string }>(created)).id;
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, { method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: "route-role", capability: "decide" }) })).status).toBe(200);
			const requests = await json<{ requests: Array<{ id: string }> }>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests?state=pending`));
			const requestId = requests.requests.find(item => item.id)?.id;
			expect(requestId).toBeTruthy();
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(requestId!)}/answer`, { method: "POST", body: JSON.stringify({ value: { kind: "option", value: "apply" } }) })).status).toBe(200);
			const cookie = await operatorCookie();
			const [draft] = await proposals(projectId, cookie);
			expect(draft).toMatchObject({ requestId, proposalType: "role" });
			// Claim through the real project owner, then terminate before the canonical effect.
			const context = gateway.projectContextManager.getOrCreate(projectId)!;
			const record = context.decisionRequestStore.get(requestId!);
			const importId = record.delivery.importId;
			const owner = proposalDraftOwnerId({ kind: "project-import", projectId, importId, requestId: requestId! });
			const snapshot = await readSnapshot(path.join(gateway.bobbitDir, "state"), owner, "role", draft!.rev);
			expect(snapshot).toBeTruthy();
			const identity = { projectId, importId, requestId: requestId!, type: "role" as const, rev: draft!.rev, snapshotSha256: projectImportSnapshotSha256(snapshot!), key: projectImportApplicationKey({ projectId, importId, requestId: requestId!, type: "role", rev: draft!.rev, snapshot: snapshot! }) };
			expect(context.decisionRequestStore.claimImportProposal(identity, new Date().toISOString()).claimed).toBe(true);
			await gateway.crash();
			await gateway.restart();
			// No route or getOrCreate call may warm this context: boot replay itself must
			// open the durable owner. all() is the public non-creating observation.
			const restarted = Array.from(gateway.projectContextManager.all() as Iterable<ProjectContext>).find(candidate => candidate.project.id === projectId);
			expect(restarted).toBeTruthy();
			const settled = restarted!.decisionRequestStore.get(requestId!);
			if (!settled || settled.proposal?.status !== "accepted") {
				throw new Error(`Expected startup replay to settle accepted proposal ${requestId}`);
			}
			expect(settled.proposal.application).toMatchObject({ key: identity.key });
			expect(settled.proposal.auditedAt).toEqual(expect.any(String));
			expect(restarted!.roleStore.get("route-import-role")).toMatchObject({ label: "Route import role" });
			expect(auditRows(path.join(gateway.bobbitDir, "state"), projectId, importId).filter(entry => entry.auditKey === identity.key)).toHaveLength(1);
			await gateway.crash();
			await gateway.restart();
			const again = Array.from(gateway.projectContextManager.all() as Iterable<ProjectContext>).find(candidate => candidate.project.id === projectId);
			expect(again).toBeTruthy();
			expect(again!.roleStore.get("route-import-role")).toMatchObject({ label: "Route import role" });
			expect(auditRows(path.join(gateway.bobbitDir, "state"), projectId, importId).filter(entry => entry.auditKey === identity.key)).toHaveLength(1);
		} finally {
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test("startup replay fences audited proposals but reconciles an accepted unaudited record once", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `route-audit-fence-${Date.now()}`);
		fs.mkdirSync(root, { recursive: true });
		let projectId = "";
		try {
			const created = await apiFetch("/api/projects", { method: "POST", body: JSON.stringify({ name: "route-audit-fence", rootPath: root, components: [{ name: "app", repo: "." }], __e2e_seed_skip__: true }) });
			expect(created.status, await created.clone().text()).toBe(201);
			projectId = (await json<{ id: string }>(created)).id;
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, { method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: "route-role", capability: "decide" }) })).status).toBe(200);
			const requests = await json<{ requests: Array<{ id: string }> }>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests?state=pending`));
			const requestId = requests.requests[0]?.id;
			expect(requestId).toBeTruthy();
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(requestId!)}/answer`, { method: "POST", body: JSON.stringify({ value: { kind: "option", value: "apply" } }) })).status).toBe(200);
			const cookie = await operatorCookie();
			const [draft] = await proposals(projectId, cookie);
			expect(draft).toMatchObject({ requestId, proposalType: "role" });
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(requestId!)}/role/accept`, { method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft!.rev }) })).status).toBe(201);

			const context = gateway.projectContextManager.getOrCreate(projectId)!;
			const accepted = context.decisionRequestStore.get(requestId!);
			if (!accepted || accepted.delivery.kind !== "project-import" || accepted.proposal?.status !== "accepted" || !accepted.proposal.application || !accepted.proposal.auditedAt) throw new Error("Expected an accepted, audited import proposal");
			const { importId } = accepted.delivery;
			const auditKey = accepted.proposal.application.key;
			const tracePath = path.join(gateway.bobbitDir, "state", "session-context-trace", "project-import", projectId, `${importId}.jsonl`);

			// Simulate bounded trace rotation: the decision-store marker, not the
			// surviving trace keys, is authoritative for an already audited proposal.
			fs.writeFileSync(tracePath, "{}\n");
			await gateway.crash();
			await gateway.restart();
			const fenced = Array.from(gateway.projectContextManager.all() as Iterable<ProjectContext>).find(candidate => candidate.project.id === projectId)?.decisionRequestStore.get(requestId!);
			if (!fenced || fenced.proposal?.status !== "accepted") throw new Error("Expected startup replay to retain the accepted proposal");
			expect(fenced.proposal.auditedAt).toEqual(accepted.proposal.auditedAt);
			expect(auditRows(path.join(gateway.bobbitDir, "state"), projectId, importId).filter(entry => entry.auditKey === auditKey)).toHaveLength(0);

			// Historical crash recovery keeps accepted-but-unmarked records eligible.
			// Remove only the durable fence while the gateway is down; boot must append
			// the keyed activity and restore the marker exactly once.
			await gateway.crash();
			const storePath = path.join(root, ".bobbit", "state", "extension-decision-requests.json");
			const state = JSON.parse(fs.readFileSync(storePath, "utf8")) as { requests: Record<string, { proposal?: { auditedAt?: string } }> };
			delete state.requests[requestId!]?.proposal?.auditedAt;
			fs.writeFileSync(storePath, JSON.stringify(state, null, 2));
			await gateway.restart();
			const reconciled = Array.from(gateway.projectContextManager.all() as Iterable<ProjectContext>).find(candidate => candidate.project.id === projectId)?.decisionRequestStore.get(requestId!);
			if (!reconciled || reconciled.proposal?.status !== "accepted") throw new Error("Expected startup replay to retain the accepted proposal");
			expect(reconciled.proposal.auditedAt).toEqual(expect.any(String));
			expect(auditRows(path.join(gateway.bobbitDir, "state"), projectId, importId).filter(entry => entry.auditKey === auditKey)).toHaveLength(1);
			await gateway.crash();
			await gateway.restart();
			expect(auditRows(path.join(gateway.bobbitDir, "state"), projectId, importId).filter(entry => entry.auditKey === auditKey)).toHaveLength(1);
		} finally {
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
