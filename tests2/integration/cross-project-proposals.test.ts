/**
 * API integration — cross-project proposal seed resolver.
 *
 * Design: docs/design/cross-project-proposals.md §1, §2, §3, §6.
 *
 * A `propose_*` seed may target a DIFFERENT project than the session's via the
 * optional `projectId`. The seed endpoint resolves the TARGET uniformly for
 * goal/role/tool/staff:
 *   - omitted  → session's project (system → headquarters);
 *   - explicit → validated against the registry and stamped onto the draft;
 *   - unknown  → 422 UNKNOWN_PROJECT.
 *
 * `project` proposals are the intentional exception. Their seed fields remain
 * untouched: absent `fields.projectId` stays absent (create intent), while an
 * explicit id stays explicit so acceptance can edit a known project or reject
 * an unknown one. The source session's project is never stamped into that field.
 *
 * Coverage here:
 *   (a) omitted projectId → session project for goal/role/tool/staff
 *   (b) explicit valid cross-project accepted and stamped
 *   (c) explicit unknown → 422 UNKNOWN_PROJECT for goal/role/tool/staff
 *   (d) propose_project preserves absent/explicit projectId seed semantics
 *   (e) goal workflow validated against the TARGET project's workflows
 */
import fs from "node:fs";
import path from "node:path";
import { expect } from "./_e2e/in-process-harness.js";
import { afterAll, beforeAll, test } from "vitest";
import {
	apiFetch,
	createSession,
	deleteSession as deleteE2ESession,
	ensureGateway,
	rawApiFetch,
} from "./_e2e/e2e-setup.js";
import {
	MINIMAL_PROPOSAL_WORKFLOWS,
	TARGET_ONLY_WORKFLOWS,
	clearProposalDrafts,
	createProposalParent,
	proposalFields,
	registerProposalProject,
	releaseSharedProposalSession,
	sharedProposalSession,
	withProposalSessionSnapshot,
} from "./_proposal-project-fixture.js";

const HEADQUARTERS_PROJECT_ID = "headquarters";
const SYSTEM_PROJECT_ID = "system";

let operatorCookie: string | undefined;

async function authenticatedOperatorCookie(): Promise<string> {
	if (operatorCookie) return operatorCookie;
	const response = await rawApiFetch("/api/goals", {
		headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
	});
	const setCookies = (response.headers as any).getSetCookie?.() as string[] | undefined
		?? (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
	operatorCookie = setCookies.map(cookie => cookie.split(";")[0])
		.find(cookie => cookie.startsWith("bobbit_session="));
	if (!operatorCookie) throw new Error("same-origin bearer bootstrap did not mint a signed bobbit_session operator cookie");
	return operatorCookie;
}

async function seed(sid: string, type: string, args: Record<string, unknown>): Promise<Response> {
	return apiFetch(`/api/sessions/${sid}/proposal/${type}/seed`, {
		method: "POST",
		headers: { Cookie: await authenticatedOperatorCookie() },
		body: JSON.stringify({ args }),
	});
}

async function seededFields(sid: string, type: "goal" | "project" | "role" | "tool" | "staff"): Promise<Record<string, unknown> | undefined> {
	return proposalFields(gateway, sid, type);
}

const VALID_ARGS: Record<string, Record<string, unknown>> = {
	goal: { title: "X-Proj Goal", spec: "body\n", workflow: "target-only" },
	role: { name: "xproj-role", label: "X Role", prompt: "do things" },
	tool: { tool: "xproj-tool", action: "create", content: "name: xproj-tool\n" },
	staff: { name: "xproj-staff", prompt: "help out" },
};

let gateway: any;
let sourceProjectFixture: { id: string; rootPath: string };
let sourceProjectId: string;
let sourceSessionId: string;
let targetProjectId: string;
let targetProjectRoot: string;
let zeroWorkflowProjectId: string;
let injectTargetProjectId: string;

async function createSourceSession(): Promise<string> {
	return sourceSessionId;
}

async function deleteSession(_sessionId: string): Promise<void> {
	// Shared fixture sessions are gateway-owned and reset by draft-slot ownership.
}

async function clearSourceProposals(...types: Array<"goal" | "project" | "role" | "tool" | "staff">): Promise<void> {
	await clearProposalDrafts(gateway, sourceSessionId, ...types);
}

beforeAll(async () => {
	gateway = await ensureGateway();
	const source = registerProposalProject(gateway, {
		key: "validated",
		workflows: MINIMAL_PROPOSAL_WORKFLOWS,
	});
	sourceProjectFixture = source;
	sourceProjectId = source.id;
	sourceSessionId = await sharedProposalSession(gateway, sourceProjectId, () =>
		createSession({ projectId: sourceProjectId }));

	// The suite-owned target has a deliberately disjoint workflow store.
	const target = registerProposalProject(gateway, {
		key: "target-only",
		workflows: TARGET_ONLY_WORKFLOWS,
	});
	targetProjectId = target.id;
	targetProjectRoot = target.rootPath;
	zeroWorkflowProjectId = registerProposalProject(gateway, { key: "zero-workflows" }).id;
	injectTargetProjectId = target.id;
});

afterAll(async () => {
	await clearSourceProposals("goal", "project", "role", "tool", "staff");
	await releaseSharedProposalSession(gateway, sourceProjectId, deleteE2ESession);
});

test.describe("cross-project proposal seed @smoke", () => {
	// Each declaration clears the draft types it owns before reuse, preventing
	// proposal state from crossing boundaries without provisioning more sessions.
	// ── (a) omitted projectId → session's project ──────────────────────
	test("(a) omitted projectId stamps the session project for goal/role/tool/staff", async () => {
		await clearSourceProposals("goal", "role", "tool", "staff");
		const s = await createSourceSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const args = type === "goal" ? { title: "Def Goal", spec: "body\n", workflow: "feature" } : VALID_ARGS[type];
				const r = await seed(s, type, args);
				expect(r.status, `${type} omitted seed: ${await r.clone().text()}`).toBe(200);
				const fields = await seededFields(s, type);
				expect(fields?.projectId, `${type} default stamp`).toBe(sourceProjectId);
			}
		} finally {
			await deleteSession(s);
		}
	});

	// ── (a) system → headquarters default mapping ──────────────────────
	test("(a) system-scope session default maps to headquarters", async () => {
		// A role assistant created with a cwd outside any project resolves to the
		// synthetic `system` project (see role-assistant-session.test.ts). An
		// omitted-projectId seed must default to the user-facing headquarters
		// scope, never the hidden `system` id.
		await clearSourceProposals("role");
		await withProposalSessionSnapshot(gateway, sourceSessionId, { projectId: SYSTEM_PROJECT_ID }, async () => {
			const r = await seed(sourceSessionId, "role", VALID_ARGS.role);
			expect(r.status, `system-scope role seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(sourceSessionId, "role");
			expect(fields?.projectId).toBe(HEADQUARTERS_PROJECT_ID);
		});
	});

	// ── (b) explicit valid cross-project ───────────────────────────────
	test("(b) explicit valid cross-project projectId is accepted and stamped for goal/role/tool/staff", async () => {
		await clearSourceProposals("goal", "role", "tool", "staff");
		const s = await createSourceSession();
		try {
			for (const type of ["goal", "role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: targetProjectId });
				expect(r.status, `${type} cross-project seed: ${await r.clone().text()}`).toBe(200);
				const fields = await seededFields(s, type);
				expect(fields?.projectId, `${type} cross-project stamp`).toBe(targetProjectId);
			}
		} finally {
			await deleteSession(s);
		}
	});

	test("(b) explicit valid cross-project projectId is accepted for propose_project", async () => {
		await clearSourceProposals("project");
		const s = await createSourceSession();
		try {
			const r = await seed(s, "project", { name: "X-Proj Edit", root_path: "/tmp/xproj", projectId: targetProjectId });
			expect(r.status, `project cross-project seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe(targetProjectId);
		} finally {
			await deleteSession(s);
		}
	});

	// ── propose_project root_path is conditional (edit vs create) ──────
	// Requirement 4 / design §3: editing an existing registered project via an
	// explicit projectId does not require root_path (the server already knows
	// it); a brand-new CREATE (no projectId) still requires root_path.
	test("propose_project with explicit registered projectId seeds WITHOUT root_path (edit)", async () => {
		await clearSourceProposals("project");
		const s = await createSourceSession();
		try {
			const r = await seed(s, "project", { name: "Edit Existing", projectId: targetProjectId });
			expect(r.status, `project edit seed (no root_path): ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe(targetProjectId);
			expect(fields?.root_path).toBeUndefined();
		} finally {
			await deleteSession(s);
		}
	});

	test("propose_project with NO projectId and NO root_path is rejected (create requires root_path)", async () => {
		await clearSourceProposals("project");
		const s = await createSourceSession();
		try {
			const r = await seed(s, "project", { name: "New No Root" });
			// A missing required field is caught by writeProposalFile's serialize
			// validation and surfaced as a 500 (same as any other missing required
			// field at seed); the important invariant is that CREATE without
			// root_path never produces a valid draft.
			const text = await r.text();
			expect(r.status, `project create seed (no root_path) must fail: ${text}`).not.toBe(200);
			expect(text).toMatch(/root_path/);
			// And no valid draft was persisted.
			const fields = await seededFields(s, "project");
			expect(fields).toBeUndefined();
		} finally {
			await deleteSession(s);
		}
	});

	test("propose_project brand-new with name + root_path preserves absent projectId (create)", async () => {
		await clearSourceProposals("project");
		const s = await createSourceSession();
		try {
			const r = await seed(s, "project", { name: "Brand New Create", root_path: "/tmp/brand-new-create" });
			expect(r.status, `project create seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.root_path).toBe("/tmp/brand-new-create");
			expect(fields?.projectId, "project create seed must not inherit the registered source session project").toBeUndefined();
		} finally {
			await deleteSession(s);
		}
	});

	test("Headquarters propose_project with omitted projectId also preserves create intent", async () => {
		await clearSourceProposals("project");
		await withProposalSessionSnapshot(gateway, sourceSessionId, { projectId: HEADQUARTERS_PROJECT_ID }, async () => {
			const r = await seed(sourceSessionId, "project", { name: "HQ Brand New", root_path: "/tmp/hq-brand-new-create" });
			expect(r.status, `Headquarters project create seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(sourceSessionId, "project");
			expect(fields).toMatchObject({ name: "HQ Brand New", root_path: "/tmp/hq-brand-new-create" });
			expect(fields?.projectId, "Headquarters provenance must not be reinterpreted as the proposal target").toBeUndefined();
		});
	});

	// ── (c) explicit unknown target ────────────────────────────────────
	test("(c) goal uses canonical PROJECT_NOT_FOUND while other proposal types retain UNKNOWN_PROJECT", async () => {
		await clearSourceProposals("goal", "role", "tool", "staff");
		const s = await createSourceSession();
		try {
			const goal = await seed(s, "goal", { ...VALID_ARGS.goal, projectId: "does-not-exist-project" });
			expect(goal.status).toBe(404);
			expect(await goal.json()).toMatchObject({ ok: false, code: "PROJECT_NOT_FOUND" });
			expect(await seededFields(s, "goal")).toBeUndefined();

			for (const type of ["role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: "does-not-exist-project" });
				expect(r.status, `${type} unknown seed`).toBe(422);
				const body = await r.json();
				expect(body.ok).toBe(false);
				expect(body.code).toBe("UNKNOWN_PROJECT");
			}
		} finally {
			await deleteSession(s);
		}
	});

	test("goal seed rejects another project's checkout as user input", async () => {
		await clearSourceProposals("goal");
		const response = await seed(sourceSessionId, "goal", {
			title: "Foreign cwd",
			spec: "Another project's checkout cannot grant ambient proposal authority.",
			workflow: "feature",
			projectId: sourceProjectId,
			cwd: targetProjectRoot,
		});
		expect(response.status, await response.clone().text()).toBe(422);
		expect(await response.json()).toMatchObject({ ok: false, code: "CWD_OUTSIDE_PROJECT" });
		expect(await seededFields(sourceSessionId, "goal")).toBeUndefined();
	});

	// ── (c') explicit hidden/system target → canonical visibility error ─
	// The synthetic `system` project IS registered (hidden: true), but it is not
	// a user-facing cross-project target. The system→headquarters mapping is for
	// the OMITTED default only; an EXPLICIT `system` must be rejected.
	test("(c') explicit hidden `system` goal uses canonical PROJECT_NOT_VISIBLE", async () => {
		await clearSourceProposals("goal", "role", "tool", "staff");
		const s = await createSourceSession();
		try {
			const goal = await seed(s, "goal", { ...VALID_ARGS.goal, projectId: SYSTEM_PROJECT_ID });
			expect(goal.status).toBe(400);
			expect(await goal.json()).toMatchObject({ ok: false, code: "PROJECT_NOT_VISIBLE" });
			expect(await seededFields(s, "goal")).toBeUndefined();

			for (const type of ["role", "tool", "staff"] as const) {
				const r = await seed(s, type, { ...VALID_ARGS[type], projectId: SYSTEM_PROJECT_ID });
				expect(r.status, `${type} explicit system seed`).toBe(422);
				expect(await r.json()).toMatchObject({ ok: false, code: "UNKNOWN_PROJECT" });
				expect(await seededFields(s, type)).toBeUndefined();
			}
		} finally {
			await deleteSession(s);
		}
	});

	// ── (d) explicit projectId is preserved for acceptance resolution ─
	test("(d) unknown projectId stays explicit at seed for acceptance-time rejection", async () => {
		await clearSourceProposals("project");
		const s = await createSourceSession();
		try {
			const r = await seed(s, "project", { name: "Explicit Unknown", root_path: "/tmp/explicit-unknown", projectId: "not-registered-target" });
			expect(r.status, `project explicit-unknown seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(s, "project");
			expect(fields?.projectId).toBe("not-registered-target");
		} finally {
			await deleteSession(s);
		}
	});

	test("(d) id-addressed project mutation routes reject an unknown target with UNKNOWN_PROJECT", async () => {
		const unknownId = `unknown-project-${Date.now()}`;
		for (const request of [
			{ path: `/api/projects/${unknownId}`, method: "PUT", body: { name: "must-not-create" } },
			{ path: `/api/projects/${unknownId}/config`, method: "PUT", body: { test_command: "must-not-write" } },
			{ path: `/api/projects/${unknownId}/promote`, method: "POST", body: { name: "must-not-promote" } },
		]) {
			const response = await apiFetch(request.path, { method: request.method, body: JSON.stringify(request.body) });
			expect(response.status, `${request.method} ${request.path}`).toBe(422);
			expect(await response.json()).toMatchObject({ ok: false, code: "UNKNOWN_PROJECT" });
		}
	});

	// ── (e) goal workflow validated against the TARGET project ─────────
	test("canonical seed validation passively resolves a hidden workflow in an unopened project", async () => {
		await clearSourceProposals("goal");
		const contexts = gateway.sessionManager.getProjectContextManager();
		const registry = contexts.getRegistry();
		const rootPath = path.join(gateway.bobbitDir, "proposal-projects", `unopened-hidden-${Date.now()}`);
		fs.mkdirSync(rootPath, { recursive: true });
		const projectYaml = [
			"components:",
			"  - name: unopened-hidden",
			"    repo: .",
			"workflows:",
			"  feature:",
			"    name: Visible Feature",
			"    gates:",
			"      - id: implementation",
			"        name: Implementation",
			"  runtime-only:",
			"    name: Runtime Only",
			"    hidden: true",
			"    gates:",
			"      - id: implementation",
			"        name: Implementation",
			"        verify:",
			"          - name: Hidden QA",
			"            type: command",
			"            run: echo qa",
			"            optional: true",
			"            optionalLabel: Enable Hidden QA",
			"",
		].join("\n");
		const project = registry.register("proposal-unopened-hidden", rootPath, { acceptCanonical: true });
		const configDir = path.join(project.rootPath, ".bobbit", "config");
		const configFile = path.join(configDir, "project.yaml");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(configFile, projectYaml);
		const configFs = (contexts as any).options?.fsImpl;
		if (configFs && configFs !== fs) {
			configFs.mkdirSync(configDir, { recursive: true });
			configFs.writeFileSync(configFile, projectYaml);
		}
		const topologyBefore = [...contexts.all()].length;
		try {
			expect(contexts.getExisting(project.id)).toBeUndefined();
			expect(contexts.readConfigSnapshot(project.id)?.workflows.map((workflow: { id: string }) => workflow.id)).toEqual(["feature", "runtime-only"]);
			const rejected = await seed(sourceSessionId, "goal", {
				title: "Unopened invalid option",
				spec: "Canonical validation must remain passive.",
				projectId: project.id,
				workflow: "runtime-only",
				options: "Not optional",
			});
			expect(rejected.status, await rejected.clone().text()).toBe(400);
			expect(await rejected.json()).toMatchObject({ ok: false, code: "UNKNOWN_OPTIONAL_STEP" });
			expect(contexts.getExisting(project.id)).toBeUndefined();
			expect([...contexts.all()]).toHaveLength(topologyBefore);
			expect(await seededFields(sourceSessionId, "goal")).toBeUndefined();

			const accepted = await seed(sourceSessionId, "goal", {
				title: "Unopened hidden workflow",
				spec: "The exact creation-time lookup accepts the hidden runtime workflow.",
				projectId: project.id,
				workflow: "runtime-only",
				options: "Hidden QA",
			});
			expect(accepted.status, await accepted.clone().text()).toBe(200);
			expect(contexts.getExisting(project.id)).toBeUndefined();
			expect([...contexts.all()]).toHaveLength(topologyBefore);

			const created = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Unopened hidden workflow",
					spec: "Ordinary creation uses the same exact hidden workflow lookup.",
					projectId: project.id,
					workflowId: "runtime-only",
					enabledOptionalSteps: ["Hidden QA"],
					worktree: false,
					team: false,
					autoStartTeam: false,
				}),
			});
			expect(created.status, await created.clone().text()).toBe(201);
			expect(await created.json()).toMatchObject({ workflowId: "runtime-only", enabledOptionalSteps: ["Hidden QA"] });
		} finally {
			await clearSourceProposals("goal");
			await contexts.remove(project.id).catch(() => undefined);
			registry.remove(project.id);
			configFs?.rmSync(project.rootPath, { recursive: true, force: true });
			fs.rmSync(project.rootPath, { recursive: true, force: true });
			if (project.rootPath !== rootPath) fs.rmSync(rootPath, { recursive: true, force: true });
		}
	});

	test("ordinary creation revalidates optional steps after awaited sandbox provisioning", async () => {
		const context = gateway.sessionManager.getProjectContextManager().getOrCreate(sourceProjectId);
		const sandboxManager = gateway.sessionManager.getSandboxManager();
		expect(context).toBeTruthy();
		expect(sandboxManager).toBeTruthy();
		const workflowsBefore = context.projectConfigStore.getWorkflows();
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		const originalEnsure = sandboxManager.ensureForProject.bind(sandboxManager);
		const originalCreateGoal = context.goalManager.createGoalFromPreflight.bind(context.goalManager);
		let releaseSandbox!: () => void;
		let sandboxEntered!: () => void;
		const sandboxBlocker = new Promise<void>(resolve => { releaseSandbox = resolve; });
		const entered = new Promise<void>(resolve => { sandboxEntered = resolve; });
		let createGoalCalls = 0;
		sandboxManager.ensureForProject = async () => {
			sandboxEntered();
			await sandboxBlocker;
		};
		context.goalManager.createGoalFromPreflight = ((...args: unknown[]) => {
			createGoalCalls++;
			return originalCreateGoal(...args as Parameters<typeof originalCreateGoal>);
		}) as typeof context.goalManager.createGoalFromPreflight;
		try {
			const pending = apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Sandbox stale optional step",
					spec: "The workflow changes while sandbox provisioning is awaited.",
					projectId: sourceProjectId,
					workflowId: "feature",
					enabledOptionalSteps: ["QA testing"],
					sandboxed: true,
					worktree: false,
					team: false,
					autoStartTeam: false,
				}),
			});
			await entered;
			const changed = structuredClone(workflowsBefore ?? {});
			for (const gate of changed.feature?.gates ?? []) {
				for (const step of gate.verify ?? []) delete step.optional;
			}
			context.projectConfigStore.setWorkflows(changed);
			releaseSandbox();
			const rejected = await pending;
			expect(rejected.status, await rejected.clone().text()).toBe(400);
			expect(await rejected.json()).toMatchObject({ ok: false, code: "UNKNOWN_OPTIONAL_STEP" });
			expect(createGoalCalls).toBe(0);
			expect(context.goalStore.getAll()).toEqual(goalsBefore);
			expect(context.taskStore.getAll()).toEqual(tasksBefore);
			expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		} finally {
			releaseSandbox();
			sandboxManager.ensureForProject = originalEnsure;
			context.goalManager.createGoalFromPreflight = originalCreateGoal;
			context.projectConfigStore.setWorkflows(workflowsBefore ?? {});
		}
	});

	test("zero-workflow seed validates defaults without draft or workflow mutation", async () => {
		await clearSourceProposals("goal");
		const context = gateway.sessionManager.getProjectContextManager().getOrCreate(zeroWorkflowProjectId);
		expect(context.projectConfigStore.getWorkflows() ?? {}).toEqual({});

		for (const [args, code] of [
			[{ title: "Unknown default", spec: "Must fail before persistence.", workflow: "not-a-default" }, "UNKNOWN_WORKFLOW"],
			[{ title: "Unknown option", spec: "Must validate default options.", workflow: "feature", options: "Not optional" }, "UNKNOWN_OPTIONAL_STEP"],
		] as const) {
			const rejected = await seed(sourceSessionId, "goal", { ...args, projectId: zeroWorkflowProjectId });
			expect(rejected.status, await rejected.clone().text()).toBe(400);
			expect((await rejected.json()).code).toBe(code);
			expect(await seededFields(sourceSessionId, "goal")).toBeUndefined();
			expect(context.projectConfigStore.getWorkflows() ?? {}).toEqual({});
		}
	});

	test("ordinary acceptance rejects a draft made stale by an empty workflow store without mutation", async () => {
		await clearSourceProposals("goal");
		const context = gateway.sessionManager.getProjectContextManager().getOrCreate(zeroWorkflowProjectId);
		const customWorkflows = {
			custom: {
				name: "Custom",
				description: "Exists only while the draft is seeded.",
				gates: [{ id: "custom-gate", name: "Custom Gate", depends_on: [] }],
			},
		};
		context.projectConfigStore.setWorkflows(customWorkflows);
		const seeded = await seed(sourceSessionId, "goal", {
			title: "Empty stale ordinary",
			spec: "The custom workflow disappears before acceptance.",
			workflow: "custom",
			projectId: zeroWorkflowProjectId,
		});
		expect(seeded.status, await seeded.clone().text()).toBe(200);
		const draftBefore = await (await apiFetch(`/api/sessions/${sourceSessionId}/proposal/goal`)).text();
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		context.projectConfigStore.setWorkflows({});

		const rejected = await apiFetch("/api/goals", {
			method: "POST",
			body: JSON.stringify({
				title: "Empty stale ordinary",
				spec: "The custom workflow disappears before acceptance.",
				workflowId: "custom",
				projectId: zeroWorkflowProjectId,
				worktree: false,
				autoStartTeam: false,
			}),
		});

		expect(rejected.status, await rejected.clone().text()).toBe(400);
		expect(await rejected.json()).toMatchObject({ ok: false, code: "UNKNOWN_WORKFLOW" });
		expect(context.projectConfigStore.getWorkflows() ?? {}).toEqual({});
		expect(context.goalStore.getAll()).toEqual(goalsBefore);
		expect(context.taskStore.getAll()).toEqual(tasksBefore);
		expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		expect(await (await apiFetch(`/api/sessions/${sourceSessionId}/proposal/goal`)).text()).toBe(draftBefore);
	});

	test("ordinary goal acceptance revalidates a stale proposal without partial state", async () => {
		await clearSourceProposals("goal");
		const seeded = await seed(sourceSessionId, "goal", {
			title: "Stale ordinary goal",
			spec: "The selected workflow will disappear before acceptance.",
			workflow: "target-only",
			projectId: targetProjectId,
		});
		expect(seeded.status, await seeded.clone().text()).toBe(200);
		const draftBefore = await (await apiFetch(`/api/sessions/${sourceSessionId}/proposal/goal`)).text();
		const context = gateway.sessionManager.getProjectContextManager().getOrCreate(targetProjectId);
		const workflowsBefore = context.projectConfigStore.getWorkflows();
		const goalsBefore = structuredClone(context.goalStore.getAll());
		const tasksBefore = structuredClone(context.taskStore.getAll());
		const gatesBefore = (context.gateStore as any).gates?.size ?? 0;
		const sessionsBefore = (await (await apiFetch("/api/sessions?include=archived")).json()).sessions.length;
		const replacementWorkflows = {
			replacement: {
				name: "Replacement",
				description: "Makes target-only stale.",
				gates: [{ id: "implementation", name: "Implementation", depends_on: [] }],
			},
		};

		let rejected: Response;
		let workflowsAfterReject: Record<string, unknown> | undefined;
		try {
			context.projectConfigStore.setWorkflows(replacementWorkflows);
			rejected = await apiFetch("/api/goals", {
				method: "POST",
				body: JSON.stringify({
					title: "Stale ordinary goal",
					spec: "The selected workflow will disappear before acceptance.",
					workflowId: "target-only",
					projectId: targetProjectId,
					worktree: false,
					autoStartTeam: false,
				}),
			});
			workflowsAfterReject = context.projectConfigStore.getWorkflows();
		} finally {
			context.projectConfigStore.setWorkflows(workflowsBefore ?? {});
		}

		expect(rejected!.status, await rejected!.clone().text()).toBe(400);
		expect(await rejected!.json()).toMatchObject({ ok: false, code: "UNKNOWN_WORKFLOW" });
		expect(context.goalStore.getAll()).toEqual(goalsBefore);
		expect(context.taskStore.getAll()).toEqual(tasksBefore);
		expect((context.gateStore as any).gates?.size ?? 0).toBe(gatesBefore);
		expect(workflowsAfterReject).toEqual(replacementWorkflows);
		expect((await (await apiFetch("/api/sessions?include=archived")).json()).sessions).toHaveLength(sessionsBefore);
		expect(await (await apiFetch(`/api/sessions/${sourceSessionId}/proposal/goal`)).text()).toBe(draftBefore);
	});

	test("(e) goal workflow is validated against the target project's workflows", async () => {
		await clearSourceProposals("goal");
		const s = await createSourceSession();
		try {
			// The target has `target-only` but NOT `feature`; the session's default
			// project has `feature` but NOT `target-only`.
			const okResp = await seed(s, "goal", { title: "Target WF", spec: "body\n", workflow: "target-only", projectId: targetProjectId });
			expect(okResp.status, `target workflow accepted: ${await okResp.clone().text()}`).toBe(200);
			expect((await seededFields(s, "goal"))?.projectId).toBe(targetProjectId);

			// `feature` is valid in the SESSION's project but unknown to the TARGET —
			// must be rejected, proving validation resolves against the target.
			const badResp = await seed(s, "goal", { title: "Session WF", spec: "body\n", workflow: "feature", projectId: targetProjectId });
			expect(badResp.status).toBe(400);
			const body = await badResp.json();
			expect(body.code).toBe("UNKNOWN_WORKFLOW");
			const ids = (body.availableWorkflows ?? []).map((w: { id?: string }) => w.id);
			expect(ids).toContain("target-only");
			expect(ids).not.toContain("feature");
		} finally {
			await deleteSession(s);
		}
	});
});

/**
 * PR #1005 (Bug hunt, high) — team-lead parent auto-injection must NOT fire for a
 * CROSS-PROJECT goal proposal.
 *
 * For a team-lead session whose current goal can spawn children, the seed handler
 * auto-injects `parentGoalId = teamGoalId` when the proposal omits one. That inject
 * runs AFTER §1 stamps the resolved TARGET project. If the target names a DIFFERENT
 * project, the injected parent belongs to the SOURCE project, so on accept
 * POST /api/goals rejects it with PARENT_CROSS_PROJECT. The fix guards the inject on
 * a same-project check (parent.projectId === enrichedArgs.projectId); cross-project
 * goals stay top-level. The same-project / no-explicit-target path is unchanged.
 */
test.describe("team-lead parent inject vs cross-project target (PR #1005) @smoke", () => {
	let parent: ReturnType<typeof createProposalParent>;

	beforeAll(() => {
		parent = createProposalParent(gateway, sourceProjectFixture);
		parent.record.subgoalsAllowed = true;
	});

	afterAll(() => {
		parent.remove();
	});

	test("(same-project) team-lead goal proposal STILL auto-injects the parent", async () => {
		await withProposalSessionSnapshot(gateway, sourceSessionId, { role: "team-lead", teamGoalId: parent.id }, async () => {
			const r = await seed(sourceSessionId, "goal", { title: "Same-Proj Child", spec: "body\n", workflow: "feature" });
			expect(r.status, `same-project team-lead seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(sourceSessionId, "goal");
			expect(fields?.parentGoalId, "same-project proposal must auto-inject the team-lead parent").toBe(parent.id);
		});
	});

	test("(cross-project) team-lead goal proposal stays TOP-LEVEL (no parent inject)", async () => {
		await withProposalSessionSnapshot(gateway, sourceSessionId, { role: "team-lead", teamGoalId: parent.id }, async () => {
			const r = await seed(sourceSessionId, "goal", { title: "Cross-Proj Child", spec: "body\n", workflow: "target-only", projectId: injectTargetProjectId });
			expect(r.status, `cross-project team-lead seed: ${await r.clone().text()}`).toBe(200);
			const fields = await seededFields(sourceSessionId, "goal");
			expect(fields?.projectId, "cross-project stamp").toBe(injectTargetProjectId);
			expect(
				fields?.parentGoalId,
				"cross-project proposal must NOT inject a source-project parent (would fail accept with PARENT_CROSS_PROJECT)",
			).toBeUndefined();
		});
	});
});
