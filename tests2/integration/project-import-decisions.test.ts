import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";

const PACK_ID = `project-import-decisions-${process.pid}-${Date.now()}`;
const QUESTION_HOOK = "import.question";
const PROPOSAL_HOOK = "import.proposal";
const PROJECT_PROPOSAL_HOOK = "import.project-proposal";
const QUESTION = "PROJECT_IMPORT_QUESTION_SECRET_choose_safe_mode";
const TRACE_SECRET = "PROJECT_IMPORT_TRACE_SECRET_must_be_redacted";

type ImportRequest = {
	id: string;
	status: string;
	decisionClass: "deferrable" | "consent-required";
	request: { question: string; options: Array<{ value: string; label: string }> };
};

type ImportStore = {
	requests: Record<string, { delivery: { kind: string; importId: string }; status: string; proposal?: { status: string; type: string } }>;
	importRuns: Record<string, { context: { components: unknown[] }; hooks: Record<string, { state: string; outcome?: string }> }>;
};

function writeFixturePack(headquartersDir: string): string {
	const packDir = path.join(headquartersDir, "config", "market-packs", PACK_ID);
	fs.mkdirSync(path.join(packDir, "hooks"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });
	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: test", "sourceRef: local", "commit: fixture", `packName: ${PACK_ID}`,
		"version: 1.0.0", "installedAt: '2026-01-01T00:00:00.000Z'", "updatedAt: '2026-01-01T00:00:00.000Z'", "scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		"schema: 2", `name: ${PACK_ID}`, "description: Project-import lifecycle fixture", "version: 1.0.0",
		"contents:", "  roles: []", "  tools: []", "  skills: []", "  entrypoints: []", "  providers: []",
		"  hooks: [import-question, import-proposal, import-project-proposal]", "  mcp: []", "  pi-extensions: []", "  runtimes: []", "  workflows: []",
	].join("\n") + "\n");
	for (const [file, id, module] of [["import-question", QUESTION_HOOK, "import-question.mjs"], ["import-proposal", PROPOSAL_HOOK, "import-proposal.mjs"], ["import-project-proposal", PROJECT_PROPOSAL_HOOK, "import-project-proposal.mjs"]] as const) {
		fs.writeFileSync(path.join(packDir, "hooks", `${file}.yaml`), [
			`id: ${id}`, `module: ../lib/${module}`, "events: [projectImported]", "mode: decide", "capabilities: []",
			"budget: { maxTokens: 64, timeoutMs: 1000 }",
		].join("\n") + "\n");
	}
	fs.writeFileSync(path.join(packDir, "lib", "import-question.mjs"), `
const deadline = () => new Date(Date.now() + 10 * 60_000).toISOString();
export default { decide(ctx) {
  if (ctx.event !== "projectImported" || ctx.components.length !== 1) throw new Error("components were not persisted before import dispatch");
  return { kind: "request", request: {
    version: 1, key: "import-safe-mode", title: "Import safe mode", question: ${JSON.stringify(QUESTION)},
    options: [{ value: "safe", label: "Safe mode" }, { value: "fast", label: "Fast mode" }],
    other: { maxLength: 40 }, default: { kind: "option", value: "safe" },
    scope: "project", deadlineAt: deadline(), effect: { kind: "none" },
  } };
} };
`);
	fs.writeFileSync(path.join(packDir, "lib", "import-proposal.mjs"), `
const deadline = () => new Date(Date.now() + 10 * 60_000).toISOString();
export default { decide(ctx) {
  return { kind: "request", request: {
    version: 1, key: "import-project-draft", title: "Draft import config", question: "${TRACE_SECRET}",
    options: [{ value: "draft", label: "Create draft" }, { value: "skip", label: "Skip" }], other: { maxLength: 40 },
    requestedClass: "consent-required", scope: "project", deadlineAt: deadline(),
    effect: { kind: "proposal", proposals: {
      draft: { proposalType: "role", args: { name: "imported-role", label: "Imported role", prompt: "A reviewed import role." } },
    }, noEffectValues: ["skip", "other"] },
  } };
} };
`);
	fs.writeFileSync(path.join(packDir, "lib", "import-project-proposal.mjs"), `
const deadline = () => new Date(Date.now() + 10 * 60_000).toISOString();
export default { decide(ctx) {
  return { kind: "request", request: {
    version: 1, key: "import-project-config-draft", title: "Draft project configuration", question: "Update imported config?",
    options: [{ value: "draft", label: "Create draft" }, { value: "skip", label: "Skip" }], other: { maxLength: 40 },
    requestedClass: "consent-required", scope: "project", deadlineAt: deadline(),
    effect: { kind: "proposal", proposals: {
      draft: { proposalType: "project", args: { projectId: ctx.projectId, name: "Updated import project", config: { build_command: "echo imported" } } },
    }, noEffectValues: ["skip", "other"] },
  } };
} };
`);
	return packDir;
}

async function readJson<T>(response: Response): Promise<T> {
	const text = await response.text();
	if (!text) throw new Error(`Expected JSON response, received ${response.status}`);
	return JSON.parse(text) as T;
}

async function mintOperatorCookie(): Promise<string> {
	const response = await apiFetch("/api/goals", { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" } });
	const cookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	const cookie = cookies.map(value => value.split(";")[0]).find(value => value.startsWith("bobbit_session=")) ?? "";
	expect(cookie).not.toBe("");
	return cookie;
}

async function notifyPackFilesystemMutation(order: string[]): Promise<void> {
	const response = await apiFetch("/api/marketplace/pack-order", {
		method: "PUT", body: JSON.stringify({ scope: "server", order }),
	});
	expect(response.status, await response.clone().text()).toBe(200);
}

async function importRequests(projectId: string, pending = true): Promise<ImportRequest[]> {
	const response = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests${pending ? "?state=pending" : ""}`);
	expect(response.status, await response.clone().text()).toBe(200);
	return (await readJson<{ requests: ImportRequest[] }>(response)).requests;
}

function decisionState(rootPath: string): ImportStore {
	return JSON.parse(fs.readFileSync(path.join(rootPath, ".bobbit", "state", "extension-decision-requests.json"), "utf8")) as ImportStore;
}

function checkoutGrant(): string {
	return [
		"extension_grants:", `  - packId: ${PACK_ID}`, `    hookId: ${QUESTION_HOOK}`, "    capability: decide",
			"    grantedAt: '2026-01-01T00:00:00.000Z'", "    grantedBy: checkout",
	].join("\n") + "\n";
}

function enterInteractiveDecisionMode(): () => void {
	const priorCi = process.env.CI;
	const priorHeadless = process.env.BOBBIT_HEADLESS;
	process.env.CI = "false";
	process.env.BOBBIT_HEADLESS = "0";
	return () => {
		if (priorCi === undefined) delete process.env.CI;
		else process.env.CI = priorCi;
		if (priorHeadless === undefined) delete process.env.BOBBIT_HEADLESS;
		else process.env.BOBBIT_HEADLESS = priorHeadless;
	};
}

test.describe("project import decisions — real gateway lifecycle", () => {
	let packDir = "";
	let originalPackOrder: string[] = [];
	let restoreDecisionMode = () => {};

	test.beforeAll(async ({ gateway }) => {
		restoreDecisionMode = enterInteractiveDecisionMode();
		originalPackOrder = (await readJson<{ order: string[] }>(await apiFetch("/api/marketplace/pack-order?scope=server"))).order;
		packDir = writeFixturePack(gateway.bobbitDir);
		await notifyPackFilesystemMutation(originalPackOrder);
		const activation = await apiFetch("/api/marketplace/pack-activation", {
			method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: { hooks: [] } }),
		});
		expect(activation.status, await activation.clone().text()).toBe(200);
	});

	test.afterAll(async () => {
		try {
			await apiFetch("/api/marketplace/pack-activation", {
				method: "PUT", body: JSON.stringify({ scope: "server", packName: PACK_ID, disabled: {} }),
			}).catch(() => {});
			if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
			await notifyPackFilesystemMutation(originalPackOrder).catch(() => {});
		} finally {
			restoreDecisionMode();
		}
	});

	test("POST persists components, keeps checkout grants inert, and explicitly grants one durable replay", async ({ gateway }) => {
		const rootPath = path.join(gateway.bobbitDir, `import-lifecycle-${Date.now()}`);
		fs.mkdirSync(path.join(rootPath, ".bobbit", "config"), { recursive: true });
		fs.writeFileSync(path.join(rootPath, ".bobbit", "config", "project.yaml"), checkoutGrant());
		let projectId = "";
		try {
			const created = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({
					name: `import-lifecycle-${Date.now()}`, rootPath,
					components: [{ name: "web", repo: ".", commands: { test: "echo test" } }],
					__e2e_seed_skip__: true,
				}),
			});
			expect(created.status, await created.clone().text()).toBe(201);
			const project = await readJson<any>(created);
			projectId = project.id;
			expect(project.importDecisionRun).toMatchObject({ version: 1, state: "ready" });

			// Checkout config is visible but is never runtime authority: no registry
			// binding exists until an authenticated grant route succeeds.
			expect(await importRequests(projectId)).toEqual([]);
			let state = decisionState(rootPath);
			const importId = project.importDecisionRun.id as string;
			expect(state.importRuns[importId].context.components).toHaveLength(1);
			expect(state.importRuns[importId].hooks[`${PACK_ID}:${QUESTION_HOOK}`]).toMatchObject({ state: "pending" });

			const grant = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
				method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: QUESTION_HOOK, capability: "decide" }),
			});
			expect(grant.status, await grant.clone().text()).toBe(200);
			const [question] = await importRequests(projectId);
			expect(question).toMatchObject({ decisionClass: "deferrable", request: { question: QUESTION } });

			const answer = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(question.id)}/answer`, {
				method: "POST", body: JSON.stringify({ value: { kind: "option", value: "safe" } }),
			});
			expect(answer.status, await answer.clone().text()).toBe(200);
			expect((await readJson<any>(answer)).request).toMatchObject({ status: "resolved", resolution: { value: { kind: "option", value: "safe" } } });

			// A registration retry uses the original import marker and cannot invoke
			// the completed hook or produce another decision.
			const retry = await apiFetch("/api/projects", {
				method: "POST", body: JSON.stringify({ name: "ignored", rootPath, upsert: true, components: [{ name: "web", repo: "." }] }),
			});
			expect(retry.status).toBe(200);
			expect((await readJson<any>(retry)).importDecisionRun.id).toBe(importId);
			expect(await importRequests(projectId)).toEqual([]);
			state = decisionState(rootPath);
			expect(Object.values(state.requests).filter(request => request.delivery.kind === "project-import")).toHaveLength(1);
			expect(state.importRuns[importId].hooks[`${PACK_ID}:${QUESTION_HOOK}`]).toMatchObject({ state: "completed", outcome: "applied" });
		} finally {
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("promotes a provisional Add Project run once, projects a proposal draft, and serves a bounded redacted trace", async ({ gateway }) => {
		const rootPath = path.join(gateway.bobbitDir, `import-provisional-${Date.now()}`);
		fs.mkdirSync(rootPath, { recursive: true });
		let projectId = "";
		let cookie = "";
		try {
			// This is the same gateway route Add Project uses to create its provisional
			// project assistant; avoid the e2e helper because it intentionally injects
			// a default project id for ordinary sessions.
			const assistant = await gateway.api("/api/sessions", {
				method: "POST", body: JSON.stringify({ assistantType: "project", cwd: rootPath, worktree: false }),
			});
			expect(assistant.status, await assistant.clone().text()).toBe(201);
			projectId = (await readJson<{ projectId: string }>(assistant)).projectId;
			expect((await readJson<any>(await apiFetch(`/api/projects/${projectId}`))).provisional).toBe(true);

			const persisted = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/config`, {
				method: "PUT", body: JSON.stringify({ components: [{ name: "web", repo: "." }] }),
			});
			expect(persisted.status, await persisted.clone().text()).toBe(200);
			const promoted = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/promote`, {
				method: "POST", body: JSON.stringify({ name: "Promoted import" }),
			});
			expect(promoted.status, await promoted.clone().text()).toBe(200);
			const promotedProject = await readJson<any>(promoted);
			expect(promotedProject.provisional).not.toBe(true);
			expect(promotedProject.importDecisionRun).toMatchObject({ state: "ready" });
			const importId = promotedProject.importDecisionRun.id as string;
			const state = decisionState(rootPath);
			expect(state.importRuns[importId].context.components).toHaveLength(1);
			expect(state.importRuns[importId].hooks[`${PACK_ID}:${PROPOSAL_HOOK}`]).toMatchObject({ state: "pending" });

			const grant = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
				method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: PROPOSAL_HOOK, capability: "decide" }),
			});
			expect(grant.status, await grant.clone().text()).toBe(200);
			const request = (await importRequests(projectId)).find(candidate => candidate.request.question === TRACE_SECRET);
			expect(request).toMatchObject({ decisionClass: "consent-required" });

			const answer = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(request!.id)}/answer`, {
				method: "POST", body: JSON.stringify({ value: { kind: "option", value: "draft" } }),
			});
			expect(answer.status, await answer.clone().text()).toBe(200);
			cookie = await mintOperatorCookie();
			const proposals = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals`, { headers: { Cookie: cookie } });
			expect(proposals.status, await proposals.clone().text()).toBe(200);
			const projected = (await readJson<{ proposals: Array<{ requestId: string; proposalType: string; rev: number; fields: Record<string, unknown> }> }>(proposals)).proposals;
			const draft = projected[0]!;
			expect(projected).toEqual([
				expect.objectContaining({ requestId: request!.id, proposalType: "role", rev: expect.any(Number), fields: expect.objectContaining({ projectId, name: "imported-role" }) }),
			]);
			// Review identities come only from the durable project/import/request tuple.
			// Neither a stale revision nor another project can apply this proposal.
			const stale = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft.requestId)}/role/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev + 1 }),
			});
			expect(stale.status).toBe(409);
			expect(await readJson<any>(stale)).toMatchObject({ code: "STALE_PROPOSAL" });
			const otherRoot = path.join(gateway.bobbitDir, `import-other-${Date.now()}`);
			fs.mkdirSync(otherRoot, { recursive: true });
			const other = await apiFetch("/api/projects", {
				method: "POST", body: JSON.stringify({ name: `import-other-${Date.now()}`, rootPath: otherRoot, __e2e_seed_skip__: true }),
			});
			const otherProject = await readJson<any>(other);
			try {
				const crossProject = await apiFetch(`/api/projects/${encodeURIComponent(otherProject.id)}/import-proposals/${encodeURIComponent(draft.requestId)}/role/accept`, {
					method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev }),
				});
				expect(crossProject.status).toBe(404);
			} finally {
				await apiFetch(`/api/projects/${encodeURIComponent(otherProject.id)}`, { method: "DELETE" }).catch(() => {});
				fs.rmSync(otherRoot, { recursive: true, force: true });
			}
			const accepted = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft.requestId)}/role/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev }),
			});
			expect(accepted.status, await accepted.clone().text()).toBe(201);
			// The import-proposal accept route returns the canonical mutation result
			// under `outcome`; role application identifies the created role by name.
			expect(await readJson<any>(accepted)).toMatchObject({ status: "accepted", outcome: { role: "imported-role" } });
			// A lost 201 response retries from the durable accepted application, not
			// from the deleted draft. It must never repeat the effect or keyed audit.
			const traceBeforeAcceptedRetry = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-trace?limit=10`, { headers: { Cookie: cookie } });
			const traceCountBeforeAcceptedRetry = (await readJson<{ entries: unknown[] }>(traceBeforeAcceptedRetry)).entries.length;
			const acceptedRetry = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft.requestId)}/role/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev }),
			});
			expect(acceptedRetry.status, await acceptedRetry.clone().text()).toBe(200);
			expect(await readJson<any>(acceptedRetry)).toMatchObject({ ok: true, status: "accepted", outcome: { role: "imported-role" } });
			const acceptedWrongType = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft.requestId)}/goal/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev }),
			});
			expect(acceptedWrongType.status).toBe(409);
			expect(await readJson<any>(acceptedWrongType)).toMatchObject({ code: "PROPOSAL_IDENTITY_MISMATCH" });
			const acceptedWrongRevision = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft.requestId)}/role/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft.rev + 1 }),
			});
			expect(acceptedWrongRevision.status).toBe(409);
			expect(await readJson<any>(acceptedWrongRevision)).toMatchObject({ code: "STALE_PROPOSAL" });
			const roles = await apiFetch(`/api/roles?projectId=${encodeURIComponent(projectId)}`);
			const importedRoles = (await readJson<any>(roles)).roles.filter((role: { name: string }) => role.name === "imported-role");
			expect(importedRoles).toEqual([expect.objectContaining({ name: "imported-role", label: "Imported role" })]);
			const traceAfterAcceptedRetry = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-trace?limit=10`, { headers: { Cookie: cookie } });
			expect((await readJson<{ entries: unknown[] }>(traceAfterAcceptedRetry)).entries).toHaveLength(traceCountBeforeAcceptedRetry);
			expect((await readJson<any>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals`, { headers: { Cookie: cookie } }))).proposals).toEqual([]);

			// A second independently registered import proves reject removes only its
			// own draft and never applies its proposed role.
			const rejectRoot = path.join(gateway.bobbitDir, `import-reject-${Date.now()}`);
			fs.mkdirSync(rejectRoot, { recursive: true });
			const rejecting = await apiFetch("/api/projects", {
				method: "POST", body: JSON.stringify({ name: `import-reject-${Date.now()}`, rootPath: rejectRoot, __e2e_seed_skip__: true }),
			});
			const rejectingProject = await readJson<any>(rejecting);
			try {
				expect((await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}/extension-grants`, {
					method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: PROPOSAL_HOOK, capability: "decide" }),
				})).status).toBe(200);
				const rejectRequest = (await importRequests(rejectingProject.id)).find(candidate => candidate.request.question === TRACE_SECRET)!;
				expect((await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}/import-decision-requests/${encodeURIComponent(rejectRequest.id)}/answer`, {
					method: "POST", body: JSON.stringify({ value: { kind: "option", value: "draft" } }),
				})).status).toBe(200);
				const rejectedDraft = (await readJson<any>(await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}/import-proposals`, { headers: { Cookie: cookie } }))).proposals[0];
				const rejected = await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}/import-proposals/${encodeURIComponent(rejectedDraft.requestId)}/role/reject`, {
					method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: rejectedDraft.rev }),
				});
				expect(rejected.status).toBe(200);
				expect(await readJson<any>(rejected)).toMatchObject({ status: "rejected" });
				const rejectedAcceptRetry = await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}/import-proposals/${encodeURIComponent(rejectedDraft.requestId)}/role/accept`, {
					method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: rejectedDraft.rev }),
				});
				expect(rejectedAcceptRetry.status).toBe(404);
				expect((await readJson<any>(await apiFetch(`/api/roles?projectId=${encodeURIComponent(rejectingProject.id)}`))).roles)
					.not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "imported-role" })]));
			} finally {
				await apiFetch(`/api/projects/${encodeURIComponent(rejectingProject.id)}`, { method: "DELETE" }).catch(() => {});
				fs.rmSync(rejectRoot, { recursive: true, force: true });
			}

			const trace = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-trace?limit=1`, { headers: { Cookie: cookie } });
			expect(trace.status, await trace.clone().text()).toBe(200);
			const entries = (await readJson<{ entries: unknown[] }>(trace)).entries;
			expect(entries).toHaveLength(1);
			expect(JSON.stringify(entries)).not.toContain(TRACE_SECRET);
			expect(JSON.stringify(entries)).not.toContain(rootPath);
		} finally {
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("maps typed project-config persistence errors and releases the exact import claim", async ({ gateway }) => {
		const rootPath = path.join(gateway.bobbitDir, `import-project-config-failure-${Date.now()}`);
		fs.mkdirSync(rootPath, { recursive: true });
		let projectId = "";
		let restoreFs: (() => void) | undefined;
		try {
			const created = await apiFetch("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `import-project-config-failure-${Date.now()}`, rootPath, __e2e_seed_skip__: true }),
			});
			expect(created.status, await created.clone().text()).toBe(201);
			projectId = (await readJson<any>(created)).id;
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/extension-grants`, {
				method: "PUT", body: JSON.stringify({ packId: PACK_ID, hookId: PROJECT_PROPOSAL_HOOK, capability: "decide" }),
			})).status).toBe(200);
			const request = (await importRequests(projectId)).find(candidate => candidate.request.question === "Update imported config?");
			expect(request).toBeTruthy();
			expect((await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-decision-requests/${encodeURIComponent(request!.id)}/answer`, {
				method: "POST", body: JSON.stringify({ value: { kind: "option", value: "draft" } }),
			})).status).toBe(200);
			const cookie = await mintOperatorCookie();
			const proposals = await readJson<{ proposals: Array<{ requestId: string; proposalType: string; rev: number }> }>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals`, { headers: { Cookie: cookie } }));
			const draft = proposals.proposals.find(candidate => candidate.proposalType === "project");
			expect(draft).toBeTruthy();

			const configStore = gateway.projectContextManager.getOrCreate(projectId)!.projectConfigStore as any;
			const originalFs = configStore.fs;
			const configFile = configStore.configFile as string;
			configStore.fs = new Proxy(originalFs, {
				get(target, property) {
					if (property === "writeFileSync") return (candidate: unknown, ...args: unknown[]) => {
						const candidatePath = String(candidate);
						if (candidatePath.startsWith(`${configFile}.`) && candidatePath.endsWith(".tmp")) throw new Error("injected import config persistence failure");
						return target.writeFileSync(candidate, ...args);
					};
					const value = Reflect.get(target, property);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
			restoreFs = () => { configStore.fs = originalFs; };

			const accepted = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft!.requestId)}/project/accept`, {
				method: "POST", headers: { Cookie: cookie }, body: JSON.stringify({ rev: draft!.rev }),
			});
			expect(accepted.status).toBeGreaterThanOrEqual(400);
			expect(await readJson<any>(accepted)).toMatchObject({ code: "PROJECT_CONFIG_PERSIST_FAILED" });
			const released = await readJson<any>(await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/import-proposals/${encodeURIComponent(draft!.requestId)}/project`, { headers: { Cookie: cookie } }));
			expect(released).toMatchObject({ status: "created" });
		} finally {
			restoreFs?.();
			if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => {});
			fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});
});
