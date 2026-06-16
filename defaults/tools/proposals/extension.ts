/**
 * Proposal tool extensions for Bobbit.
 *
 * Registers one tool per proposal type (goal, role, tool, staff,
 * workflow, project), plus view_proposal / edit_proposal. The propose_*
 * tools acknowledge the call AND seed a proposal file on disk via the
 * gateway REST endpoint (docs/design/editable-proposals.md §6.5).
 *
 * Loaded automatically via --extension for sessions with an assistantType.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getGatewayUrl, getGatewayToken } from "../_shared/gateway.ts";

type ProposalType = "goal" | "project" | "workflow" | "role" | "tool" | "staff";

/**
 * Module-private gateway helper. Returns parsed JSON or text on success;
 * throws on network error or non-2xx HTTP. For edit_proposal we want the
 * structured-error JSON body even on 4xx — callers handle that explicitly.
 */
async function callGateway(
	pathSuffix: string,
	method: "GET" | "POST" | "DELETE",
	body?: unknown,
): Promise<{ status: number; bodyText: string; bodyJson: unknown }> {
	const baseUrl = getGatewayUrl();
	const token = getGatewayToken();
	const init: RequestInit = {
		method,
		headers: {
			"Authorization": `Bearer ${token}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
	};
	const response = await fetch(`${baseUrl}${pathSuffix}`, init);
	const bodyText = await response.text();
	let bodyJson: unknown = undefined;
	try { bodyJson = bodyText ? JSON.parse(bodyText) : undefined; } catch { /* not json */ }
	return { status: response.status, bodyText, bodyJson };
}

function sessionId(): string | undefined {
	return process.env.BOBBIT_SESSION_ID;
}

/**
 * Result of seeding a proposal. `rev` is set on success; `errorMessage` carries
 * a server-provided validation message (e.g. unknown workflow) on a structured
 * 4xx. Most propose_* tools ignore `errorMessage` (log-and-ack), but propose_goal
 * surfaces it so the agent SEES the rejection and the corrective list.
 */
export interface SeedProposalResult {
	rev?: number;
	errorMessage?: string;
}

/**
 * Seed a proposal file by POSTing to /api/sessions/:id/proposal/:type/seed.
 * On non-2xx we return a structured `errorMessage` (the server's `message` when
 * present) AND log to stderr. The existing in-flight `_checkToolProposals`
 * streaming path still delivers any partial to the UI.
 */
export async function seedProposal(type: ProposalType, args: unknown): Promise<SeedProposalResult> {
	const sid = sessionId();
	if (!sid) {
		console.error(`[proposal-tools] BOBBIT_SESSION_ID not set; cannot seed ${type} proposal`);
		return {};
	}
	try {
		const { status, bodyText, bodyJson } = await callGateway(
			`/api/sessions/${encodeURIComponent(sid)}/proposal/${type}/seed`,
			"POST",
			{ args },
		);
		if (status < 200 || status >= 300) {
			const msg = (bodyJson && typeof bodyJson === "object" && "message" in bodyJson)
				? String((bodyJson as { message?: unknown }).message)
				: `seed ${type} failed: HTTP ${status} ${bodyText.slice(0, 500)}`;
			console.error(`[proposal-tools] seed ${type} failed: HTTP ${status} ${bodyText.slice(0, 500)}`);
			return { errorMessage: msg };
		}
		if (bodyJson && typeof bodyJson === "object" && typeof (bodyJson as any).rev === "number") {
			return { rev: (bodyJson as any).rev as number };
		}
		return {};
	} catch (err) {
		console.error(`[proposal-tools] seed ${type} threw:`, (err as Error)?.message ?? err);
		return {};
	}
}

const PROPOSAL_TYPE_ENUM = Type.Union([
	Type.Literal("goal"),
	Type.Literal("project"),
	Type.Literal("workflow"),
	Type.Literal("role"),
	Type.Literal("tool"),
	Type.Literal("staff"),
]);

export default function (pi: ExtensionAPI) {
	function ack(rev?: number) {
		const lines = ["Proposal submitted. Waiting for user response."];
		if (typeof rev === "number" && rev > 0) lines.push(`__proposal_rev_v1__:${rev}`);
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: undefined,
		};
	}

	// ── propose_goal ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_goal",
		label: "Propose Goal",
		description: "Submit a goal proposal. Prefer existing workflow/roles; inline only when needed.",
		promptSnippet: "Propose a goal with title, spec, workflow, and optional fields. Reuse existing workflow/roles by default.",
		parameters: Type.Object({
			title: Type.String({ description: "Short 2-5 word title, under 29 characters." }),
			spec: Type.String({ description: "Markdown spec: description, requirements, constraints, approach." }),
			cwd: Type.Optional(Type.String({ description: "Working directory override." })),
			workflow: Type.Optional(Type.String({ description: "Workflow ID, e.g. general, feature, bug-fix." })),
			options: Type.Optional(Type.String({ description: "Comma-separated optional step names." })),
			parentGoalId: Type.Optional(Type.String({ description: "Subgoal parent ID; team leads auto-fill only when child spawn is allowed." })),
			subgoalsAllowed: Type.Optional(Type.Boolean({ description: "Allow the team-lead to spawn sub-goals. Default off." })),
			maxNestingDepth: Type.Optional(Type.Integer({ minimum: 1, description: "Per-goal sub-goal nesting cap; clamped to the global ceiling." })),
			divergencePolicy: Type.Optional(Type.Union([Type.Literal("strict"), Type.Literal("balanced"), Type.Literal("autonomous")], { description: "Root-only plan-change autonomy (default balanced)." })),
			maxConcurrentChildren: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Root-only: max child teams running in parallel, 1-8 (default 5)." })),
			inlineRoles: Type.Optional(Type.Record(Type.String(), Type.Object({
				name: Type.String({ description: "Role id (kebab-case); must equal the map key." }),
				label: Type.String({ description: "Display name." }),
				promptTemplate: Type.String({ description: "System prompt; supports {{AGENT_ID}}, {{GOAL_BRANCH}}." }),
				accessory: Type.Optional(Type.String()),
				toolPolicies: Type.Optional(Type.Record(Type.String(), Type.String())),
				model: Type.Optional(Type.String()),
				thinkingLevel: Type.Optional(Type.String()),
			}), { description: "Per-goal ephemeral roles. Use propose_role for permanent ones." })),
			inlineWorkflow: Type.Optional(Type.Object({
				id: Type.String(),
				name: Type.String(),
				description: Type.Optional(Type.String()),
				gates: Type.Array(Type.Any()),
			}, { description: "Inline workflow snapshot frozen on the goal; may reference inlineRoles." })),
		}),
		async execute(_id, args) {
			// `workflow` (string id) and `inlineWorkflow` (full Workflow object)
			// are SEPARATE fields with different semantics — workflow is looked
			// up against the project's workflow store, inlineWorkflow is a
			// frozen snapshot that bypasses the store. Pass both through
			// untouched; the proposal serializer (proposal-types.ts goalPlugin)
			// preserves both YAML keys, and goal-proposal acceptance reads
			// inlineWorkflow → POST /api/goals body.workflow (the snapshot
			// path), or workflow → POST /api/goals body.workflowId (the
			// store-lookup path). Mixing one into the other corrupts the
			// type contract.
			const r = await seedProposal("goal", args);
			if (r.errorMessage) {
				return { content: [{ type: "text" as const, text: r.errorMessage }], isError: true } as any;
			}
			return ack(r.rev);
		},
	});

	// ── propose_role ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_role",
		label: "Propose Role",
		description: "Submit a custom agent role proposal for user review.",
		promptSnippet: "Propose a role with name, label, prompt, and optional fields.",
		parameters: Type.Object({
			name: Type.String({ description: "Role identifier, lowercase with hyphens." }),
			label: Type.String({ description: "Human-readable display name." }),
			prompt: Type.String(),
			tools: Type.Optional(Type.String({ description: "Comma-separated allowed tools." })),
			accessory: Type.Optional(Type.String()),
		}),
		async execute(_id, args) { const r = await seedProposal("role", args); return ack(r.rev); },
	});

	// ── propose_tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_tool",
		label: "Propose Tool",
		description: "Submit a custom tool proposal for user review.",
		promptSnippet: "Propose a tool with tool name, action, and content.",
		parameters: Type.Object({
			tool: Type.String(),
			action: Type.String({ description: "e.g. create, update." }),
			content: Type.String({ description: "Tool definition YAML." }),
		}),
		async execute(_id, args) { const r = await seedProposal("tool", args); return ack(r.rev); },
	});

	// ── propose_staff ─────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_staff",
		label: "Propose Staff",
		description: "Submit a staff member proposal for user review.",
		promptSnippet: "Propose a staff member with name, prompt, and optional fields.",
		parameters: Type.Object({
			name: Type.String(),
			description: Type.Optional(Type.String()),
			prompt: Type.String(),
			triggers: Type.Optional(Type.String()),
			cwd: Type.Optional(Type.String()),
			role: Type.Optional(Type.String({ description: "Role name to attach to the staff agent (optional)." })),
		}),
		async execute(_id, args) { const r = await seedProposal("staff", args); return ack(r.rev); },
	});

	// ── propose_project ───────────────────────────────────────────────
	pi.registerTool({
		name: "propose_project",
		label: "Propose Project",
		description: "Submit a project proposal for user review.",
		promptSnippet: "Propose a project with name, root_path, and optional command fields.",
		parameters: Type.Object({
			name: Type.String(),
			root_path: Type.String({ description: "Project root directory." }),
			build_command: Type.Optional(Type.String()),
			test_command: Type.Optional(Type.String()),
			typecheck_command: Type.Optional(Type.String()),
			test_unit_command: Type.Optional(Type.String()),
			test_e2e_command: Type.Optional(Type.String()),
			worktree_setup_command: Type.Optional(Type.String()),
			sandbox: Type.Optional(Type.String({ description: "e.g. 'docker'." })),
			session_model: Type.Optional(Type.String({ description: "provider/model-id." })),
			review_model: Type.Optional(Type.String({ description: "provider/model-id." })),
			naming_model: Type.Optional(Type.String({ description: "provider/model-id." })),
			worktree_root: Type.Optional(Type.String({ description: "Worktree parent dir. Default <rootPath>-wt/." })),
			components: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: "Unique within project." }),
				repo: Type.String({ description: "'.' for single-repo, else subfolder of rootPath." }),
				relative_path: Type.Optional(Type.String({ description: "Sub-path inside the repo." })),
				worktree_setup_command: Type.Optional(Type.String()),
				commands: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "name → shell. Absent ⇒ data-only." })),
				config: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Opaque key→string config, max 100 entries." })),
			}), { description: "Single-repo: one component with repo='.'." })),
			workflows: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Inline workflows keyed by id." })),
			config_directories: Type.Optional(Type.Array(Type.Object({
				path: Type.String(),
				types: Type.Array(Type.String()),
			}), { description: "Dirs scanned for skills/mcp/tools/agents." })),
			sandbox_tokens: Type.Optional(Type.Array(Type.Object({
				key: Type.String(),
				enabled: Type.Boolean(),
				value: Type.Optional(Type.String()),
			}), { description: "Server strips value to SecretsStore on PUT." })),
		}),
		async execute(_id, args) { const r = await seedProposal("project", args); return ack(r.rev); },
	});

	// ── view_proposal ─────────────────────────────────────────────────
	pi.registerTool({
		name: "view_proposal",
		label: "View Proposal",
		description: "Read the current proposal draft for the active session.",
		promptSnippet: "View the current proposal draft (markdown for goal, YAML for the rest).",
		parameters: Type.Object({
			type: PROPOSAL_TYPE_ENUM,
		}),
		async execute(_id, args) {
			const { type } = args as { type: ProposalType };
			const sid = sessionId();
			if (!sid) {
				return {
					content: [{ type: "text" as const, text: `view_proposal failed: BOBBIT_SESSION_ID not set.` }],
					isError: true,
				} as any;
			}
			try {
				const { status, bodyText, bodyJson } = await callGateway(
					`/api/sessions/${encodeURIComponent(sid)}/proposal/${type}`,
					"GET",
				);
				if (status === 404) {
					return {
						content: [{ type: "text" as const, text: `No ${type} proposal yet — call propose_${type} first.` }],
						isError: true,
					} as any;
				}
				if (status < 200 || status >= 300) {
					const msg = (bodyJson && typeof bodyJson === "object" && "message" in bodyJson)
						? String((bodyJson as { message?: unknown }).message)
						: bodyText.slice(0, 500);
					return {
						content: [{ type: "text" as const, text: `view_proposal failed (HTTP ${status}): ${msg}` }],
						isError: true,
					} as any;
				}
				return {
					content: [{ type: "text" as const, text: bodyText }],
					details: undefined,
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `view_proposal failed: ${(err as Error)?.message ?? err}` }],
					isError: true,
				} as any;
			}
		},
	});

	// ── edit_proposal ─────────────────────────────────────────────────
	pi.registerTool({
		name: "edit_proposal",
		label: "Edit Proposal",
		description: "Edit the current proposal draft via exact-string replacement.",
		promptSnippet: "Edit a proposal draft by replacing old_text with new_text (exact, unique match).",
		parameters: Type.Object({
			type: PROPOSAL_TYPE_ENUM,
			old_text: Type.String({ description: "Must match uniquely in the draft." }),
			new_text: Type.String({ description: "Empty string deletes the matched span." }),
		}),
		async execute(_id, args) {
			const { type, old_text, new_text } = args as { type: ProposalType; old_text: string; new_text: string };
			const sid = sessionId();
			if (!sid) {
				return {
					content: [{ type: "text" as const, text: `edit_proposal failed: BOBBIT_SESSION_ID not set.` }],
					isError: true,
				} as any;
			}
			try {
				const { status, bodyText, bodyJson } = await callGateway(
					`/api/sessions/${encodeURIComponent(sid)}/proposal/${type}/edit`,
					"POST",
					{ old_text, new_text },
				);
				// Server returns structured JSON for both success (200) and most
				// failure modes (400/404). Pass it through verbatim so the agent
				// sees `{ok, code, message, newContent?}` exactly as the spec lays out.
				let text = bodyJson !== undefined ? JSON.stringify(bodyJson, null, 2) : bodyText;
				const isError = status < 200 || status >= 300;
				if (!isError && bodyJson && typeof (bodyJson as any).rev === "number" && (bodyJson as any).rev > 0) {
					text += `\n__proposal_rev_v1__:${(bodyJson as any).rev}`;
				}
				return {
					content: [{ type: "text" as const, text }],
					...(isError ? { isError: true } : {}),
				} as any;
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `edit_proposal failed: ${(err as Error)?.message ?? err}` }],
					isError: true,
				} as any;
			}
		},
	});

	// ── view_goal_spec ───────────────────────────────────
	// Returns the live `goal.spec` content for the agent's current goal (or
	// any goal id passed explicitly). Used by team-leads who receive a
	// `goal_spec_changed` nudge: re-read the spec, decide whether the change
	// affects the plan, then act.
	pi.registerTool({
		name: "view_goal_spec",
		label: "View Goal Spec",
		description: "Read the current goal.spec for a goal. Use after goal_spec_changed; system-prompt copy is stale.",
		promptSnippet: "View the current goal.spec content (the spec injected at startup may be stale).",
		parameters: Type.Object({
			goal_id: Type.Optional(Type.String({ description: "Goal id. Defaults to the current session's goal (BOBBIT_GOAL_ID)." })),
		}),
		async execute(_id, args) {
			const { goal_id } = args as { goal_id?: string };
			const id = goal_id || process.env.BOBBIT_GOAL_ID;
			if (!id) {
				return {
					content: [{ type: "text" as const, text: `view_goal_spec failed: no goal_id provided and BOBBIT_GOAL_ID is not set (this session is not bound to a goal).` }],
					isError: true,
				} as any;
			}
			try {
				const { status, bodyText, bodyJson } = await callGateway(`/api/goals/${encodeURIComponent(id)}`, "GET");
				if (status === 404) {
					return {
						content: [{ type: "text" as const, text: `view_goal_spec failed: goal ${id} not found.` }],
						isError: true,
					} as any;
				}
				if (status < 200 || status >= 300) {
					return {
						content: [{ type: "text" as const, text: `view_goal_spec failed (HTTP ${status}): ${bodyText.slice(0, 500)}` }],
						isError: true,
					} as any;
				}
				const goal = bodyJson as { id?: string; title?: string; spec?: string; updatedAt?: number } | undefined;
				const spec = (goal && typeof goal.spec === "string") ? goal.spec : "";
				const header = `# Goal: ${goal?.title ?? id}\n# id: ${goal?.id ?? id}\n# updatedAt: ${goal?.updatedAt ? new Date(goal.updatedAt).toISOString() : "unknown"}\n# spec length: ${spec.length} chars\n\n`;
				return {
					content: [{ type: "text" as const, text: header + spec }],
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `view_goal_spec failed: ${(err as Error)?.message ?? err}` }],
					isError: true,
				} as any;
			}
		},
	});

	if (process.env.BOBBIT_DEBUG) console.log("[proposal-tools] Registered 9 proposal tools");
}
