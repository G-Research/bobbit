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
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
 * Seed a proposal file by POSTing to /api/sessions/:id/proposal/:type/seed.
 * Failures are non-fatal — the existing in-flight `_checkToolProposals`
 * streaming path still delivers the partial to the UI. We log to stderr
 * so a regression is visible in the agent log without breaking the turn.
 */
async function seedProposal(type: ProposalType, args: unknown): Promise<void> {
	const sid = sessionId();
	if (!sid) {
		console.error(`[proposal-tools] BOBBIT_SESSION_ID not set; cannot seed ${type} proposal`);
		return;
	}
	try {
		const { status, bodyText } = await callGateway(
			`/api/sessions/${encodeURIComponent(sid)}/proposal/${type}/seed`,
			"POST",
			{ args },
		);
		if (status < 200 || status >= 300) {
			console.error(`[proposal-tools] seed ${type} failed: HTTP ${status} ${bodyText.slice(0, 500)}`);
		}
	} catch (err) {
		console.error(`[proposal-tools] seed ${type} threw:`, (err as Error)?.message ?? err);
	}
}

const PROPOSAL_TYPE_ENUM = Type.Union([
	Type.Literal("goal"),
	Type.Literal("project"),
	Type.Literal("workflow"),
	Type.Literal("role"),
	Type.Literal("tool"),
	Type.Literal("staff"),
], { description: "Proposal type" });

export default function (pi: ExtensionAPI) {
	function ack() {
		return {
			content: [{ type: "text" as const, text: "Proposal submitted. Waiting for user response." }],
			details: undefined,
		};
	}

	// ── propose_goal ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_goal",
		label: "Propose Goal",
		description: "Submit a goal proposal for user review. Call this when you have gathered enough information to propose a goal.",
		promptSnippet: "Propose a goal with title, spec, workflow, and optional fields.",
		parameters: Type.Object({
			title: Type.String({ description: "Short 2-5 word title (must be under 29 characters)" }),
			spec: Type.String({ description: "Markdown spec content. Include: brief description, key requirements, constraints, technical approach" }),
			cwd: Type.Optional(Type.String({ description: "Working directory override path" })),
			workflow: Type.Optional(Type.String({ description: "Workflow ID (e.g. \"general\", \"feature\", \"bug-fix\")" })),
			options: Type.Optional(Type.String({ description: "Comma-separated step names for optional steps (e.g. \"QA testing\")" })),
		}),
		async execute(_id, args) { await seedProposal("goal", args); return ack(); },
	});

	// ── propose_role ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_role",
		label: "Propose Role",
		description: "Submit a role proposal for user review. Call this when you have designed a custom agent role.",
		promptSnippet: "Propose a role with name, label, prompt, and optional fields.",
		parameters: Type.Object({
			name: Type.String({ description: "Role identifier (lowercase, hyphens)" }),
			label: Type.String({ description: "Human-readable display name" }),
			prompt: Type.String({ description: "System prompt for the role" }),
			tools: Type.Optional(Type.String({ description: "Comma-separated list of allowed tools" })),
			accessory: Type.Optional(Type.String({ description: "Accessory configuration" })),
		}),
		async execute(_id, args) { await seedProposal("role", args); return ack(); },
	});

	// ── propose_tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_tool",
		label: "Propose Tool",
		description: "Submit a tool proposal for user review. Call this when you have designed a custom tool.",
		promptSnippet: "Propose a tool with tool name, action, and content.",
		parameters: Type.Object({
			tool: Type.String({ description: "Tool name" }),
			action: Type.String({ description: "Action type (e.g. \"create\", \"update\")" }),
			content: Type.String({ description: "Tool definition content (YAML)" }),
		}),
		async execute(_id, args) { await seedProposal("tool", args); return ack(); },
	});

	// ── propose_staff ─────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_staff",
		label: "Propose Staff",
		description: "Submit a staff member proposal for user review. Call this when you have designed a custom staff configuration.",
		promptSnippet: "Propose a staff member with name, prompt, and optional fields.",
		parameters: Type.Object({
			name: Type.String({ description: "Staff member name" }),
			description: Type.Optional(Type.String({ description: "Short description of the staff member" })),
			prompt: Type.String({ description: "System prompt for the staff member" }),
			triggers: Type.Optional(Type.String({ description: "Trigger conditions" })),
			cwd: Type.Optional(Type.String({ description: "Working directory" })),
		}),
		async execute(_id, args) { await seedProposal("staff", args); return ack(); },
	});

	// ── propose_workflow ──────────────────────────────────────────────
	pi.registerTool({
		name: "propose_workflow",
		label: "Propose Workflow",
		description: "Submit a workflow proposal for user review. Call this when you have designed a custom workflow.",
		promptSnippet: "Propose a workflow with id, name, description, and gates.",
		parameters: Type.Object({
			id: Type.String({ description: "Workflow ID (lowercase, hyphens)" }),
			name: Type.String({ description: "Human-readable workflow name" }),
			description: Type.Optional(Type.String({ description: "Workflow description" })),
			gates: Type.Optional(Type.String({ description: "Gate definitions (YAML or JSON string)" })),
		}),
		async execute(_id, args) { await seedProposal("workflow", args); return ack(); },
	});

	// ── propose_project ───────────────────────────────────────────────
	pi.registerTool({
		name: "propose_project",
		label: "Propose Project",
		description: "Submit a project proposal for user review. Call this when you have detected or configured a project.",
		promptSnippet: "Propose a project with name, root_path, and optional command fields.",
		parameters: Type.Object({
			name: Type.String({ description: "Project name" }),
			root_path: Type.String({ description: "Root path of the project directory" }),
			build_command: Type.Optional(Type.String({ description: "Build command" })),
			test_command: Type.Optional(Type.String({ description: "Test command" })),
			typecheck_command: Type.Optional(Type.String({ description: "Type-check command" })),
			test_unit_command: Type.Optional(Type.String({ description: "Unit test command" })),
			test_e2e_command: Type.Optional(Type.String({ description: "E2E test command" })),
			worktree_setup_command: Type.Optional(Type.String({ description: "Worktree setup command" })),
			qa_start_command: Type.Optional(Type.String({ description: "QA start command" })),
			sandbox: Type.Optional(Type.String({ description: "Sandbox mode (e.g. 'docker')" })),
			session_model: Type.Optional(Type.String({ description: "Default session model (provider/model-id)" })),
			review_model: Type.Optional(Type.String({ description: "Reviewer model (provider/model-id)" })),
			naming_model: Type.Optional(Type.String({ description: "Naming model (provider/model-id)" })),
			worktree_root: Type.Optional(Type.String({ description: "Custom parent dir for worktrees (absolute or relative to root_path). Default: <rootPath>-wt/" })),
			components: Type.Optional(Type.Array(Type.Object({
				name: Type.String({ description: "Component name (unique within project)" }),
				repo: Type.String({ description: "\".\" for single-repo, else a subfolder of rootPath" }),
				relative_path: Type.Optional(Type.String({ description: "Optional sub-path inside the repo" })),
				worktree_setup_command: Type.Optional(Type.String({ description: "Per-component setup hook" })),
				commands: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Flat name → shell. Absent ⇒ data-only." })),
			}), { description: "Project components. Single-repo: one component with repo='.'." })),
			workflows: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Inline workflows keyed by id; structurally validated server-side." })),
			config_directories: Type.Optional(Type.Array(Type.Object({
				path: Type.String(),
				types: Type.Array(Type.String()),
			}), { description: "Custom config directories scanned for skills/mcp/tools/agents." })),
			qa_env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Environment-variable overrides for the QA harness." })),
			sandbox_tokens: Type.Optional(Type.Array(Type.Object({
				key: Type.String(),
				enabled: Type.Boolean(),
				value: Type.Optional(Type.String()),
			}), { description: "Sandbox token list. Server strips `value` to SecretsStore on PUT." })),
			qa_max_duration_minutes: Type.Optional(Type.Number({ description: "Max QA session duration in minutes." })),
			qa_max_scenarios: Type.Optional(Type.Number({ description: "Max number of QA scenarios to run." })),
		}),
		async execute(_id, args) { await seedProposal("project", args); return ack(); },
	});

	// ── view_proposal ─────────────────────────────────────────────────
	pi.registerTool({
		name: "view_proposal",
		label: "View Proposal",
		description: "Read the current draft of a proposal file for the active session.",
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
		description: "Surgically edit the current proposal draft via exact-string replacement. Same semantics as the builtin edit tool.",
		promptSnippet: "Edit a proposal draft by replacing old_text with new_text (exact, unique match).",
		parameters: Type.Object({
			type: PROPOSAL_TYPE_ENUM,
			old_text: Type.String({ description: "Exact text to find in the draft. Must match uniquely." }),
			new_text: Type.String({ description: "Replacement text. Empty string deletes the matched span." }),
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
				const text = bodyJson !== undefined ? JSON.stringify(bodyJson, null, 2) : bodyText;
				const isError = status < 200 || status >= 300;
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

	console.log("[proposal-tools] Registered 8 proposal tools");
}
