/**
 * Proposal tool extensions for Bobbit.
 *
 * Registers one tool per proposal type (goal, role, tool, staff,
 * setup, workflow, project). Each tool simply acknowledges the call — the real
 * processing happens on the UI side when it sees the tool_use block in the
 * assistant message.
 *
 * Loaded automatically via --extension for sessions with an assistantType.
 */
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

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
		async execute() { return ack(); },
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
		async execute() { return ack(); },
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
		async execute() { return ack(); },
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
		async execute() { return ack(); },
	});

	// ── propose_setup ─────────────────────────────────────────────────
	pi.registerTool({
		name: "propose_setup",
		label: "Propose Setup",
		description: "Submit a project setup proposal for user review. Call this when you have determined the project configuration.",
		promptSnippet: "Propose setup with action and optional command/model fields.",
		parameters: Type.Object({
			action: Type.String({ description: "Setup action type" }),
			content: Type.Optional(Type.String({ description: "Setup content" })),
			language: Type.Optional(Type.String({ description: "Primary programming language" })),
			framework: Type.Optional(Type.String({ description: "Framework in use" })),
			testing: Type.Optional(Type.String({ description: "Testing framework" })),
			build_command: Type.Optional(Type.String({ description: "Build command" })),
			test_command: Type.Optional(Type.String({ description: "Test command" })),
			typecheck_command: Type.Optional(Type.String({ description: "Type-check command" })),
			test_unit_command: Type.Optional(Type.String({ description: "Unit test command" })),
			test_e2e_command: Type.Optional(Type.String({ description: "E2E test command" })),
			session_model: Type.Optional(Type.String({ description: "Session model ID" })),
			review_model: Type.Optional(Type.String({ description: "Review model ID" })),
			naming_model: Type.Optional(Type.String({ description: "Naming model ID" })),
		}),
		async execute() { return ack(); },
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
		async execute() { return ack(); },
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
		async execute() { return ack(); },
	});

	console.log("[proposal-tools] Registered 8 proposal tools");
}
