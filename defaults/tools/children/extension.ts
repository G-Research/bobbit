/**
 * Children (nested-goal) tool extensions for Bobbit — Phase 4 of nested
 * goals. See SUBGOALS-SPEC §2 / §5.
 *
 * Registers the team-lead-only tools that drive the parent ↔ child goal
 * lifecycle: spawn, plan propose, plan status, merge, pause/resume,
 * archive, mutation-decision, set-policy. Calls the gateway REST API
 * directly — same pattern as the team/extension.ts.
 *
 * Tool group: `Children` — only `team-lead.yaml` declares `always-allow`
 * for these; every contributor role declares `never`. The
 * tool-group-policy default is `ask` so projects that override the
 * cascade get a prompt rather than a silent allow.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		return;
	}

	let token: string;
	let baseUrl: string;
	const envToken = process.env.BOBBIT_TOKEN;
	const envUrl = process.env.BOBBIT_GATEWAY_URL;
	if (envToken && envUrl) {
		token = envToken;
		baseUrl = envUrl.replace(/\/+$/, "");
	} else {
		try {
			const stateDir = process.env.BOBBIT_DIR
				? path.join(process.env.BOBBIT_DIR, "state")
				: path.join(homedir(), ".pi");
			const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
			const urlFile = process.env.BOBBIT_DIR ? "gateway-url" : "gateway-url";
			token = fs.readFileSync(path.join(stateDir, tokenFile), "utf-8").trim();
			baseUrl = fs.readFileSync(path.join(stateDir, urlFile), "utf-8").trim().replace(/\/+$/, "");
		} catch {
			console.error("[children-tools] Cannot read gateway credentials — tools not registered");
			return;
		}
	}

	// ── HTTP helper ───────────────────────────────────────────────────
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		const resp = await fetch(`${baseUrl}${urlPath}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				// Identifies the team-lead session that's calling — server
				// uses this on POST /spawn-child to stamp `spawnedBySessionId`
				// on the new child so the sidebar can render it nested under
				// this session (collapse-with-team-lead behaviour). Other
				// endpoints ignore it.
				"X-Bobbit-Spawning-Session": sessionId,
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let data: unknown;
		try { data = JSON.parse(text); } catch { data = text; }
		if (!resp.ok) {
			const msg = typeof data === "object" && data !== null && "error" in data
				? String((data as Record<string, unknown>).error)
				: `HTTP ${resp.status}: ${text}`;
			throw new Error(msg);
		}
		return data;
	}

	function ok(data: unknown) {
		return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], details: undefined };
	}
	function err(msg: string) {
		return { content: [{ type: "text" as const, text: msg }], details: undefined, isError: true };
	}

	// ── Tools ─────────────────────────────────────────────────────────

	pi.registerTool({
		name: "goal_spawn_child",
		label: "Spawn Child Goal",
		description: "Spawn a child goal under the current goal. Idempotent on planId — re-calling with the same planId returns the existing child id rather than creating a duplicate. The child branches off the parent's branch HEAD; on ready-to-merge, the child's branch merges LOCALLY into the parent (no remote PR). The child INHERITS the parent's `inlineRoles` snapshot automatically — to add child-specific ephemeral roles or override a parent's, pass `inlineRoles` here. Same applies to `inlineWorkflow` for one-off workflow definitions.",
		promptSnippet: "Spawn a child goal idempotently (keyed by planId). Inherits parent's inlineRoles; pass inlineRoles/inlineWorkflow to add child-specific ephemeral definitions.",
		parameters: Type.Object({
			planId: Type.String({ description: "Stable id for this plan node — used as spawnedFromPlanId on the child (Lesson 4.1)." }),
			title: Type.String({ description: "Child goal title — becomes the child's display title and branch slug." }),
			spec: Type.String({ description: "Markdown spec for the child goal." }),
			workflowId: Type.Optional(Type.String({ description: "Workflow id for the child (defaults to 'feature' on the server). Mutually exclusive with inlineWorkflow." })),
			suggestedRole: Type.Optional(Type.String({ description: "Suggested team-lead role for the child." })),
			inlineRoles: Type.Optional(Type.Record(Type.String(), Type.Object({
				name: Type.String(),
				label: Type.String(),
				promptTemplate: Type.String(),
				accessory: Type.Optional(Type.String()),
				toolPolicies: Type.Optional(Type.Record(Type.String(), Type.String())),
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(Type.String()),
			}), {
				description: "Per-child ephemeral roles. MERGED on top of the parent's inlineRoles snapshot — child entries with the same name override the parent's. Use this when the subgoal needs a different reviewer/QA role than the parent. Resolved BEFORE the project role cascade. For roles useful across many goals → propose_role (permanent) instead.",
			})),
			inlineWorkflow: Type.Optional(Type.Object({
				id: Type.String(),
				name: Type.String(),
				description: Type.Optional(Type.String()),
				gates: Type.Array(Type.Any()),
			}, { description: "Optional inline workflow snapshot for the child. When provided, snapshotted onto the child record and the project workflow store is bypassed for this child. Mutually exclusive with workflowId — if both are given, the inline workflow wins." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { planId: params.planId, title: params.title, spec: params.spec };
				if (params.workflowId !== undefined) body.workflowId = params.workflowId;
				if (params.suggestedRole !== undefined) body.suggestedRole = params.suggestedRole;
				if (params.inlineRoles !== undefined) body.inlineRoles = params.inlineRoles;
				if (params.inlineWorkflow !== undefined) body.workflow = params.inlineWorkflow;
				return ok(await api("POST", `/api/goals/${goalId}/spawn-child`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_plan_propose",
		label: "Propose Goal Plan",
		description: "Submit (or re-submit) a plan of subgoal-typed steps for this goal. " +
			"On a `parent`-workflow goal: the classifier compares against the frozen baseline " +
			"(noop / fix-up / expansion / restructure / criteria-drop), and the divergence-" +
			"policy decision matrix (SUBGOALS-SPEC §3.6) maps the kind to allow / require-" +
			"approval / 409. " +
			"On any other workflow (no `execution` gate to hold a frozen plan): the steps " +
			"are spawned directly as child goals via goal_spawn_child — same effect for the " +
			"user, just without the freeze/replan classifier. Idempotent on planId in both " +
			"paths. Returns either a classifier verdict or a `{ fallback: \"spawn-children-direct\", spawned: [...] }` block.",
		promptSnippet: "Propose a (re-)plan for the goal. Auto-falls-back to direct child spawn when the workflow has no execution gate.",
		parameters: Type.Object({
			steps: Type.Array(Type.Object({
				planId: Type.String(),
				title: Type.String(),
				spec: Type.String(),
				workflowId: Type.Optional(Type.String()),
				suggestedRole: Type.Optional(Type.String()),
				phase: Type.Optional(Type.Number()),
			}), { description: "Array of subgoal-typed plan steps." }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("PATCH", `/api/goals/${goalId}/plan`, { proposedSteps: params.steps }));
			} catch (e: any) {
				// Auto-fallback: when the goal's workflow has no execution gate
				// the classifier/freeze flow doesn't apply — but the user's
				// intent is plain (a list of subgoals to spawn). Loop
				// goal_spawn_child for each step, idempotent on planId.
				// Returning a shaped result instead of an error keeps the agent
				// flow uninterrupted: the team-lead sees `fallback: "spawn-
				// children-direct"` and knows the children were spawned but
				// the freeze/replan classifier is unavailable on this workflow.
				if (typeof e?.message === "string" && /NO_EXECUTION_GATE|no 'execution' gate/i.test(e.message)) {
					const spawned: Array<{ planId: string; childGoalId?: string; alreadyExists?: boolean; suggestedRole?: string; error?: string }> = [];
					for (const step of params.steps) {
						try {
							const result = await api("POST", `/api/goals/${goalId}/spawn-child`, {
								planId: step.planId,
								title: step.title,
								spec: step.spec,
								workflowId: step.workflowId,
								suggestedRole: step.suggestedRole,
							}) as { id?: string; alreadyExists?: boolean; suggestedRole?: string };
							spawned.push({
								planId: step.planId,
								childGoalId: result.id,
								alreadyExists: result.alreadyExists,
								suggestedRole: result.suggestedRole,
							});
						} catch (spawnErr: any) {
							spawned.push({ planId: step.planId, error: spawnErr?.message ?? String(spawnErr) });
						}
					}
					const failed = spawned.filter(s => s.error).length;
					return ok({
						fallback: "spawn-children-direct",
						note: "Goal's workflow has no execution gate, so the classifier/freeze flow was skipped. Each step was spawned via goal_spawn_child instead (idempotent on planId). To use the full plan/freeze/replan flow, recreate the goal with the 'parent' workflow.",
						spawned,
						spawnedCount: spawned.length - failed,
						failedCount: failed,
					});
				}
				return err(e.message);
			}
		},
	});

	pi.registerTool({
		name: "goal_plan_status",
		label: "Goal Plan Status",
		description: "Return the current frozen plan + a per-step projection of resolved childGoalId / state / archived. Cheap; pulls directly from the persisted store.",
		promptSnippet: "Read the current plan + each child's resolved state.",
		parameters: Type.Object({
			gateId: Type.Optional(Type.String({ description: "Gate to read steps from. Default 'execution'." })),
		}),
		async execute(_id, params) {
			try {
				const gid = params.gateId ?? "execution";
				return ok(await api("GET", `/api/goals/${goalId}/plan?gateId=${encodeURIComponent(gid)}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_merge_child",
		label: "Merge Child Goal",
		description: "Merge a child goal's branch locally into the parent. On clean merge: child auto-archived + team torn down. On conflict: 409 with truncated output; child stays live for manual recovery.",
		promptSnippet: "Local-merge a child's branch into the parent.",
		parameters: Type.Object({
			childGoalId: Type.String({ description: "Id of the child goal to merge." }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/integrate-child/${params.childGoalId}`, {}));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_pause",
		label: "Pause Goal",
		description: "Pause the current goal. Cascade=true also pauses all descendants. The cascade param is REQUIRED — server returns 422 if omitted (UI is the cascade-policy authority).",
		promptSnippet: "Pause the goal (cascade required).",
		parameters: Type.Object({
			cascade: Type.Boolean({ description: "Required. true = pause all descendants too." }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/pause`, { cascade: params.cascade }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_resume",
		label: "Resume Goal",
		description: "Resume the current goal. Cascade=true also resumes all descendants. Required cascade param.",
		promptSnippet: "Resume the goal (cascade required).",
		parameters: Type.Object({
			cascade: Type.Boolean({ description: "Required. true = resume all descendants too." }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/resume`, { cascade: params.cascade }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_archive_child",
		label: "Archive Child Goal",
		description: "Archive a child goal. Cascade=false → 409 if it has descendants (UI prompts for confirmation). Cascade=true → walks descendants deepest-first, archives each. Required cascade param.",
		promptSnippet: "Archive a child goal (cascade required).",
		parameters: Type.Object({
			childGoalId: Type.String({ description: "Id of the child to archive." }),
			cascade: Type.Boolean({ description: "Required. true = also archive descendants; false → 409 if descendants exist." }),
		}),
		async execute(_id, params) {
			try {
				const q = `?cascade=${params.cascade ? "true" : "false"}`;
				return ok(await api("DELETE", `/api/goals/${params.childGoalId}${q}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_decide_mutation",
		label: "Decide Plan Mutation",
		description: "Approve or reject a queued plan-mutation request raised by goal_plan_propose. Approve applies the proposed steps and increments replanCount (auto-pause beyond 5).",
		promptSnippet: "Approve or reject a pending plan-mutation request.",
		parameters: Type.Object({
			requestId: Type.String({ description: "requestId returned by goal_plan_propose." }),
			decision: Type.Union([Type.Literal("approve"), Type.Literal("reject")], { description: "Decision verb." }),
		}),
		async execute(_id, params) {
			try {
				return ok(await api("POST", `/api/goals/${goalId}/mutation/${params.requestId}/decision`, { decision: params.decision }));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_set_policy",
		label: "Set Goal Policy",
		description: "Set the goal's divergencePolicy (strict / balanced / autonomous) and/or maxConcurrentChildren (1..8). Concurrency is read on the root only.",
		promptSnippet: "Set divergencePolicy and/or maxConcurrentChildren on the goal.",
		parameters: Type.Object({
			divergencePolicy: Type.Optional(Type.Union([
				Type.Literal("strict"),
				Type.Literal("balanced"),
				Type.Literal("autonomous"),
			])),
			maxConcurrentChildren: Type.Optional(Type.Number({ description: "Clamped server-side to 1..8." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = {};
				if (params.divergencePolicy !== undefined) body.divergencePolicy = params.divergencePolicy;
				if (params.maxConcurrentChildren !== undefined) body.maxConcurrentChildren = params.maxConcurrentChildren;
				return ok(await api("PATCH", `/api/goals/${goalId}/policy`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	console.log(`[children-tools] Registered 9 children tools for session ${sessionId}, goal ${goalId}`);
}
