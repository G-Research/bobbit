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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readGatewayCreds, apiCall } from "../_shared/gateway.js";

export default function (pi: ExtensionAPI) {
	// ── Config ────────────────────────────────────────────────────────
	const sessionId = process.env.BOBBIT_SESSION_ID;
	const goalId = process.env.BOBBIT_GOAL_ID;
	if (!sessionId || !goalId) {
		console.error("[children-tools] BOBBIT_GOAL_ID / BOBBIT_SESSION_ID missing — tools not registered");
		return;
	}

	const credsResult = readGatewayCreds();
	if ("error" in credsResult) {
		console.error(`[children-tools] Cannot read gateway credentials — tools not registered: ${credsResult.error}`);
		return;
	}
	const creds = credsResult;

	// ── HTTP helper ───────────────────────────────────────────────────
	// All children calls carry `X-Bobbit-Spawning-Session` so the server can
	// stamp `spawnedBySessionId` on POST /spawn-child (sidebar nesting
	// behaviour). Other endpoints ignore the header.
	async function api(method: string, urlPath: string, body?: unknown): Promise<unknown> {
		return apiCall(creds, method, urlPath, body, {
			extraHeaders: { "X-Bobbit-Spawning-Session": sessionId },
		});
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
		description: "Spawn a child goal under this one. The spec is injected into the child team-lead's first user message at spawn time — pass the complete task description now (\u226550 chars). Placeholder specs and PUT-after-spawn are rejected by the server. Idempotent on planId. Inherits parent inlineRoles + workflow by default.",
		promptSnippet: "Spawn a child goal idempotently (keyed by planId). Inherits parent's inlineRoles; inherits parent's workflow only for non-meta workflows. Keep spec focused on the child's own scope.",
		parameters: Type.Object({
			planId: Type.String({ description: "Stable plan-node id; stamped on the child as spawnedFromPlanId." }),
			title: Type.String({ description: "Child goal title (display + branch slug)." }),
			spec: Type.String({ description: "REQUIRED. The complete task spec the child team-lead will execute (≥50 chars). Injected into the child's first user message at spawn time. Do NOT pass 'placeholder' and PUT the real spec later — the child team-lead's first message is built from this spec at spawn time. Long markdown specs (>5 KB) are fine — there is no payload limit. Do not include parent or sibling work." }),
			workflowId: Type.Optional(Type.String({ description: "Workflow id. Omitted: inherit parent workflow (or 'feature')." })),
			suggestedRole: Type.Optional(Type.String({ description: "Suggested team-lead role for the child." })),
			inlineRoles: Type.Optional(Type.Record(Type.String(), Type.Object({
				name: Type.String(),
				label: Type.String(),
				promptTemplate: Type.String(),
				accessory: Type.Optional(Type.String()),
				toolPolicies: Type.Optional(Type.Record(Type.String(), Type.Union([
					Type.Literal("allow"),
					Type.Literal("ask"),
					Type.Literal("never"),
				]))),
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(Type.String()),
			}), {
				description: "Per-child ephemeral roles, merged over the parent's inlineRoles snapshot.",
			})),
			inlineWorkflow: Type.Optional(Type.Object({
				id: Type.String(),
				name: Type.String(),
				description: Type.Optional(Type.String()),
				gates: Type.Array(Type.Any()),
			}, { description: "Inline workflow snapshot; replaces the inherited parent workflow." })),
			dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Sibling planIds this child waits on. Enforces scheduling — child is created paused and auto-starts only when all deps have merged into the parent. Server validates self-dep / unknown / cycle." })),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { planId: params.planId, title: params.title, spec: params.spec };
				if (params.workflowId !== undefined) body.workflowId = params.workflowId;
				if (params.suggestedRole !== undefined) body.suggestedRole = params.suggestedRole;
				if (params.inlineRoles !== undefined) body.inlineRoles = params.inlineRoles;
				if (params.inlineWorkflow !== undefined) body.workflow = params.inlineWorkflow;
				if (params.dependsOn !== undefined) body.dependsOn = params.dependsOn;
				return ok(await api("POST", `/api/goals/${goalId}/spawn-child`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_plan_propose",
		label: "Propose Goal Plan",
		description: "Submit (or re-submit) a plan of subgoal steps. Falls back to direct spawn when the workflow has no execution gate.",
		promptSnippet: "Propose a (re-)plan for the goal. Auto-falls-back to direct child spawn when the workflow has no execution gate.",
		parameters: Type.Object({
			steps: Type.Array(Type.Object({
				planId: Type.String(),
				title: Type.String(),
				spec: Type.String(),
				workflowId: Type.Optional(Type.String()),
				suggestedRole: Type.Optional(Type.String()),
				phase: Type.Optional(Type.Number()),
				dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Sibling planIds this step depends on. Server validates cycles." })),
			}), { description: "Array of subgoal-typed plan steps." }),
			fallback: Type.Optional(Type.Literal("spawn-children-direct", { description: "Opt-in: spawn directly when the workflow has no execution gate." })),
		}),
		async execute(_id, params) {
			try {
				const proposedSteps = params.steps.map(s => {
					const out: Record<string, unknown> = {
						planId: s.planId,
						title: s.title,
						spec: s.spec,
					};
					if (s.workflowId !== undefined) out.workflowId = s.workflowId;
					if (s.suggestedRole !== undefined) out.suggestedRole = s.suggestedRole;
					if (s.phase !== undefined) out.phase = s.phase;
					if (s.dependsOn !== undefined) out.dependsOn = s.dependsOn;
					return out;
				});
				return ok(await api("PATCH", `/api/goals/${goalId}/plan`, { proposedSteps }));
			} catch (e: any) {
				// Auto-fallback (opt-in only): when the goal's workflow has no
				// execution gate the classifier/freeze flow doesn't apply.
				// Previously this swallowed the freeze classifier silently —
				// a goal that *intentionally* used a non-parent workflow would
				// get cycle-cascade-spawn behaviour without any signal. Now
				// the caller MUST pass `fallback: "spawn-children-direct"`
				// to opt in. Otherwise the original NO_EXECUTION_GATE error
				// is re-thrown unchanged so the team-lead sees and decides.
				if (typeof e?.message === "string" && /NO_EXECUTION_GATE|no 'execution' gate/i.test(e.message)) {
					if (params.fallback !== "spawn-children-direct") {
						return err(
							`${e.message}\n\n` +
							`This goal's workflow has no 'execution' gate, so the classifier/freeze flow is unavailable. ` +
							`To spawn the steps as child goals directly (skipping the freeze/replan classifier), ` +
							`re-call goal_plan_propose with fallback: "spawn-children-direct". ` +
							`To use the full freeze/replan flow, recreate the goal with the 'parent' workflow.`,
						);
					}
					const spawned: Array<{ planId: string; childGoalId?: string; alreadyExists?: boolean; suggestedRole?: string; error?: string }> = [];
					for (const step of params.steps) {
						try {
							const result = await api("POST", `/api/goals/${goalId}/spawn-child`, {
								planId: step.planId,
								title: step.title,
								spec: step.spec,
								workflowId: step.workflowId,
								suggestedRole: step.suggestedRole,
								...(step.dependsOn !== undefined ? { dependsOn: step.dependsOn } : {}),
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
		description: "Return the frozen plan plus per-step resolved childGoalId / state / archived.",
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
		description: "Merge a child's branch locally into the parent. Clean merge auto-archives the child; conflicts return 409.",
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
		description: "Pause the current goal. cascade is required (true also pauses descendants).",
		promptSnippet: "Pause the goal (cascade required).",
		parameters: Type.Object({
			cascade: Type.Boolean({ description: "Required. true = pause all descendants too." }),
			childGoalId: Type.Optional(Type.String({
				description: "If set, pause this specific direct child instead of the caller's own goal. Must be a direct child (parentGoalId === caller's goalId). Returns 403 if not."
			})),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { cascade: params.cascade };
				if (params.childGoalId !== undefined) body.childGoalId = params.childGoalId;
				return ok(await api("POST", `/api/goals/${goalId}/pause`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_resume",
		label: "Resume Goal",
		description: "Resume the current goal. cascade is required (true also resumes descendants).",
		promptSnippet: "Resume the goal (cascade required).",
		parameters: Type.Object({
			cascade: Type.Boolean({ description: "Required. true = resume all descendants too." }),
			childGoalId: Type.Optional(Type.String({
				description: "If set, resume this specific direct child instead of the caller's own goal. Must be a direct child. Returns 403 if not."
			})),
		}),
		async execute(_id, params) {
			try {
				const body: Record<string, unknown> = { cascade: params.cascade };
				if (params.childGoalId !== undefined) body.childGoalId = params.childGoalId;
				return ok(await api("POST", `/api/goals/${goalId}/resume`, body));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_archive_child",
		label: "Archive Child Goal",
		description: "Archive a child goal. cascade required; mergedManually=true reconciles state to complete.",
		promptSnippet: "Archive a child goal (cascade required).",
		parameters: Type.Object({
			childGoalId: Type.String({ description: "Id of the child to archive." }),
			cascade: Type.Boolean({ description: "Required. true also archives descendants; false → 409 if any exist." }),
			mergedManually: Type.Optional(Type.Boolean({
				description: "Set true after a manual merge to reconcile state='complete'.",
			})),
		}),
		async execute(_id, params) {
			try {
				let q = `?cascade=${params.cascade ? "true" : "false"}`;
				if (params.mergedManually === true) q += "&mergedManually=true";
				return ok(await api("DELETE", `/api/goals/${params.childGoalId}${q}`));
			} catch (e: any) { return err(e.message); }
		},
	});

	pi.registerTool({
		name: "goal_decide_mutation",
		label: "Decide Plan Mutation",
		description: "Approve or reject a queued plan-mutation request. Approve increments replanCount (auto-pause >5).",
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
		description: "Set divergencePolicy (strict / balanced / autonomous) and/or maxConcurrentChildren (1..8).",
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
