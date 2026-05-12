/**
 * POST /api/goals — workflow resolution.
 *
 * Pins the four-layer defence in src/server/server.ts that fixes the
 * "Workflow not found: general" crash described in the goal spec.
 *
 *   Layer 1  — cascade lookup for the requested workflowId.
 *   Layer 1b — cascade miss falls through to the project's workflowStore
 *              (eliminates the stale-cascade failure mode).
 *   Layer 2  — both cascade + store empty → auto-seed defaults.
 *   Layer 3  — store non-empty AND id genuinely unknown → 400
 *              { code: "WORKFLOW_NOT_FOUND", available: [...] }.
 *   Layer 4  — workflowId absent from body → undefined passed through
 *              to GoalManager.createGoal, whose "first workflow in store"
 *              fallback picks one (no magic-string "general" default).
 *
 * These tests reproduce the handler's resolution block as a local
 * helper (`resolveWorkflowForPost`) — the production block lives inline
 * in the POST /api/goals handler and exporting it would expand the
 * change surface beyond the bug fix. The helper here mirrors the
 * production logic line-for-line; if the production block drifts, both
 * must be updated together.
 *
 * Layer 4's "no workflowId" branch is also exercised against the real
 * GoalManager to verify the end-to-end fallback ("no workflowId,
 * non-empty store → first workflow") fires as expected.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "yaml";

import { GoalStore } from "../src/server/agent/goal-store.ts";
import { GoalManager } from "../src/server/agent/goal-manager.ts";
import { ProjectConfigStore } from "../src/server/agent/project-config-store.ts";
import { InlineWorkflowStore, type Workflow, type WorkflowStore } from "../src/server/agent/workflow-store.ts";

let tmpRoot: string;
let configDir: string;
let stateDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "api-goals-wf-not-found-"));
	configDir = path.join(tmpRoot, "config");
	stateDir = path.join(tmpRoot, "state");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(stateDir, { recursive: true });
	fs.writeFileSync(path.join(configDir, "project.yaml"), yaml.stringify({}));
});

function makeWorkflow(id: string): Workflow {
	return {
		id,
		name: `${id} workflow`,
		description: "",
		gates: [{ id: "g", name: "G", dependsOn: [] }],
		createdAt: 1,
		updatedAt: 1,
	};
}

function makeStore(items: Workflow[]): WorkflowStore {
	const cfg = new ProjectConfigStore(configDir);
	const store = new InlineWorkflowStore(cfg);
	store.setBuiltins(items);
	return store;
}

// ── Helper: mirrors the production resolution block in
//    src/server/server.ts POST /api/goals (the four-layer defence). ──
interface ResolveResult {
	ok: boolean;
	workflow?: Workflow;
	workflowId?: string;
	error?: {
		status: number;
		code: string;
		workflowId: string;
		available: string[];
		message: string;
	};
	autoSeeded?: boolean;
}

function resolveWorkflowForPost(opts: {
	workflowId: string | undefined;
	inlineWorkflow?: Workflow;
	cascadeWorkflows: Workflow[];
	store: WorkflowStore;
	seedDefaults?: () => void;
}): ResolveResult {
	let resolvedWorkflow: Workflow | undefined;
	let resolvedWorkflowId = opts.workflowId;
	let autoSeeded = false;
	if (opts.inlineWorkflow && typeof opts.inlineWorkflow === "object") {
		resolvedWorkflow = opts.inlineWorkflow;
		resolvedWorkflowId = opts.inlineWorkflow.id || opts.workflowId;
	} else if (opts.workflowId) {
		// Layer 1: cascade.
		resolvedWorkflow = opts.cascadeWorkflows.find(w => w.id === opts.workflowId);
		// Layer 1b: cascade miss → project store.
		if (!resolvedWorkflow) {
			resolvedWorkflow = opts.store.get(opts.workflowId);
		}
		// Layer 2: still missing AND store empty → auto-seed.
		if (!resolvedWorkflow && opts.store.getAll().length === 0 && opts.seedDefaults) {
			opts.seedDefaults();
			autoSeeded = true;
			resolvedWorkflow = opts.store.get(opts.workflowId);
		}
		// Layer 3: store non-empty, id unknown → friendly 400.
		if (!resolvedWorkflow && opts.store.getAll().length > 0) {
			const available = opts.store.getAll().map(w => w.id);
			return {
				ok: false,
				error: {
					status: 400,
					code: "WORKFLOW_NOT_FOUND",
					workflowId: opts.workflowId,
					available,
					message: `Workflow "${opts.workflowId}" not found. Available: ${available.join(", ")}`,
				},
			};
		}
	}
	return { ok: true, workflow: resolvedWorkflow, workflowId: resolvedWorkflowId, autoSeeded };
}

describe("POST /api/goals — workflow resolution (handler block)", () => {
	it("Layer 1 — cascade hit returns that workflow", () => {
		const feat = makeWorkflow("feature");
		const r = resolveWorkflowForPost({
			workflowId: "feature",
			cascadeWorkflows: [feat],
			store: makeStore([]),
		});
		assert.equal(r.ok, true);
		assert.equal(r.workflow?.id, "feature");
		assert.equal(r.workflowId, "feature");
	});

	it("Layer 1b — cascade miss + store hit succeeds (handles stale cascade)", () => {
		// The bug scenario: cascade is transiently empty after archive/create
		// but the project's workflowStore still has the workflow.
		const feat = makeWorkflow("feature");
		const r = resolveWorkflowForPost({
			workflowId: "feature",
			cascadeWorkflows: [],
			store: makeStore([feat]),
		});
		assert.equal(r.ok, true);
		assert.equal(r.workflow?.id, "feature");
		assert.equal(r.workflowId, "feature");
	});

	it("Layer 2 — empty cascade + empty store auto-seeds then resolves", () => {
		const store = makeStore([]);
		const r = resolveWorkflowForPost({
			workflowId: "feature",
			cascadeWorkflows: [],
			store,
			seedDefaults: () => {
				(store as InlineWorkflowStore).setBuiltins([makeWorkflow("feature")]);
			},
		});
		assert.equal(r.ok, true);
		assert.equal(r.autoSeeded, true);
		assert.equal(r.workflow?.id, "feature");
	});

	it("Layer 3 — cascade miss + store non-empty + id unknown → 400 WORKFLOW_NOT_FOUND with available list", () => {
		const r = resolveWorkflowForPost({
			workflowId: "nonexistent",
			cascadeWorkflows: [],
			store: makeStore([makeWorkflow("feature"), makeWorkflow("bug-fix")]),
		});
		assert.equal(r.ok, false);
		assert.equal(r.error?.status, 400);
		assert.equal(r.error?.code, "WORKFLOW_NOT_FOUND");
		assert.equal(r.error?.workflowId, "nonexistent");
		assert.deepEqual(r.error?.available, ["feature", "bug-fix"]);
		assert.match(r.error!.message, /not found.*feature.*bug-fix/);
	});

	it("Layer 4 — workflowId undefined → resolution leaves workflow undefined and lets createGoal fall back", () => {
		// The handler now passes resolvedWorkflowId=undefined through to
		// GoalManager.createGoal, whose existing "first workflow in store"
		// fallback handles it. No "general" magic-string default.
		const r = resolveWorkflowForPost({
			workflowId: undefined,
			cascadeWorkflows: [],
			store: makeStore([makeWorkflow("feature")]),
		});
		assert.equal(r.ok, true);
		assert.equal(r.workflowId, undefined);
		assert.equal(r.workflow, undefined,
			"handler does NOT pre-resolve when workflowId absent — createGoal picks first");
	});

	it("Layer 4 end-to-end — GoalManager.createGoal({workflowId: undefined}) picks the first workflow in the project store", async () => {
		const goalStore = new GoalStore(stateDir);
		const wf = makeStore([makeWorkflow("feature"), makeWorkflow("bug-fix")]);
		const gm = new GoalManager(goalStore, wf);
		const goal = await gm.createGoal("layer-4 goal", tmpRoot, {
			workflowStore: wf,
			// workflowId intentionally omitted — matches what the handler
			// now passes when the request body omits workflowId.
		});
		assert.equal(goal.workflowId, "feature", "first workflow in store order");
		assert.equal(goal.workflow?.id, "feature");
	});

	it("Regression — empty store + no workflowId still surfaces NO_WORKFLOWS_MSG from GoalManager", async () => {
		const goalStore = new GoalStore(stateDir);
		const wf = makeStore([]);
		const gm = new GoalManager(goalStore, wf);
		await assert.rejects(
			() => gm.createGoal("empty goal", tmpRoot, { workflowStore: wf }),
			(err: Error) => /no workflows configured/i.test(err.message),
		);
	});

	it("inline workflow overrides everything (handler short-circuit)", () => {
		// Pinning the existing inline-workflow branch — must remain
		// reachable after the four-layer restructure.
		const inline = makeWorkflow("inline-only");
		const r = resolveWorkflowForPost({
			workflowId: "feature",
			inlineWorkflow: inline,
			cascadeWorkflows: [makeWorkflow("feature")],
			store: makeStore([makeWorkflow("feature")]),
		});
		assert.equal(r.ok, true);
		assert.equal(r.workflow?.id, "inline-only");
		assert.equal(r.workflowId, "inline-only");
	});

	it("no `general` magic-string default — undefined input stays undefined", () => {
		// Direct guard for Layer 4: ensure the helper never substitutes the
		// literal id "general" when workflowId is absent. Mirrors the
		// production handler's removal of the `: "general"` fallback.
		const r = resolveWorkflowForPost({
			workflowId: undefined,
			cascadeWorkflows: [makeWorkflow("general")],
			store: makeStore([makeWorkflow("general")]),
		});
		assert.equal(r.ok, true);
		assert.equal(r.workflowId, undefined,
			"handler must NOT default to 'general' — that's the bug we're fixing");
		assert.equal(r.workflow, undefined);
	});
});
