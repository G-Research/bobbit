#!/usr/bin/env node
/**
 * QA Seed Script — generates realistic fixture data for ephemeral QA environments.
 *
 * Usage: node scripts/qa-seed/seed.mjs <WORK_DIR>
 *
 * Writes projects.json, sessions.json, goals.json, gates.json, tasks.json,
 * team-state.json, project.yaml, and JSONL message files into $WORK_DIR/.bobbit/.
 */

import fs from "node:fs";
import path from "node:path";

if (!process.argv[2]) {
	console.error("Usage: node scripts/qa-seed/seed.mjs <WORK_DIR>");
	console.error("Error: WORK_DIR argument is required");
	process.exit(1);
}
const workDir = path.resolve(process.argv[2]);

// ── Fixed IDs ──────────────────────────────────────────────────────────────
const PROJECT_ID = "qa-seed-proj-0001-0001-0001-000000000001";
const GOAL_ID = "qa-seed-goal-0001-0001-0001-000000000001";
const SESS_GOAL = "qa-seed-sess-0001-0001-0001-000000000001";
const SESS_CODER = "qa-seed-sess-0002-0002-0002-000000000002";
const SESS_REVIEWER = "qa-seed-sess-0003-0003-0003-000000000003";
const TASK_1 = "qa-seed-task-0001";
const TASK_2 = "qa-seed-task-0002";
const TASK_3 = "qa-seed-task-0003";
const SIGNAL_1 = "qa-seed-signal-0001";
const SIGNAL_2 = "qa-seed-signal-0002";

// Use recent timestamps so archived sessions survive the 7-day purge on server startup.
// Offset by -1 hour from current time to look realistic.
const BASE_TS = Date.now() - 3600000;

// ── Directories ────────────────────────────────────────────────────────────
const stateDir = path.join(workDir, ".bobbit", "state");
const messagesDir = path.join(stateDir, "messages");
const configDir = path.join(workDir, ".bobbit", "config");

fs.mkdirSync(messagesDir, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

// ── Helper ─────────────────────────────────────────────────────────────────
function writeJSON(filePath, data) {
	fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

// ── project.yaml ───────────────────────────────────────────────────────────
fs.writeFileSync(
	path.join(configDir, "project.yaml"),
	"name: QA Seed Project\n",
);

// ── projects.json ──────────────────────────────────────────────────────────
writeJSON(path.join(stateDir, "projects.json"), [
	{
		id: PROJECT_ID,
		name: "QA Seed Project",
		rootPath: workDir,
		colorLight: "oklch(0.45 0.03 260)",
		colorDark: "oklch(0.65 0.03 260)",
		createdAt: BASE_TS,
	},
]);

// ── Frozen feature workflow snapshot (camelCase TS format) ─────────────────
const frozenWorkflow = {
	id: "feature",
	name: "Feature",
	description:
		"Implement a new feature with design, implementation, and review",
	gates: [
		{
			id: "design-doc",
			name: "Design Document",
			dependsOn: [],
			content: true,
			injectDownstream: true,
			verify: [
				{
					name: "Design review",
					type: "llm-review",
					role: "architect",
					prompt: "Review this design document for structure, clarity, and completeness.",
				},
				{
					name: "Gap analysis",
					type: "llm-review",
					role: "spec-auditor",
					prompt: "Compare the goal specification to this design document.",
				},
			],
		},
		{
			id: "implementation",
			name: "Implementation",
			dependsOn: ["design-doc"],
			verify: [
				{ name: "Type check passes", type: "command", run: "npm run check" },
				{ name: "Unit tests", type: "command", run: "npm run test:unit" },
				{ name: "E2E tests", type: "command", run: "npm run test:e2e" },
				{
					name: "Gap analysis",
					type: "llm-review",
					role: "spec-auditor",
					phase: 1,
					prompt: "Compare the goal specification and design document to the actual implementation.",
				},
				{
					name: "Code quality review",
					type: "llm-review",
					role: "code-reviewer",
					phase: 1,
					prompt: "Review the code changes for quality.",
				},
				{
					name: "Security review",
					type: "llm-review",
					role: "security-reviewer",
					phase: 1,
					prompt: "Security review of changes.",
				},
			],
		},
		{
			id: "documentation",
			name: "Documentation",
			dependsOn: ["implementation"],
			verify: [
				{
					name: "Documentation coverage",
					type: "llm-review",
					prompt: "Review documentation for the changes.",
				},
			],
		},
		{
			id: "ready-to-merge",
			name: "Ready to Merge",
			dependsOn: ["documentation"],
			verify: [
				{
					name: "Branch pushed to remote",
					type: "command",
					run: "git push origin {{branch}}",
				},
				{
					name: "Master merged into branch",
					type: "command",
					run: "git fetch origin {{master}}",
				},
				{
					name: "PR raised",
					type: "command",
					run: "gh pr list --head {{branch}}",
				},
			],
		},
	],
	createdAt: BASE_TS,
	updatedAt: BASE_TS,
};

// ── goals.json ─────────────────────────────────────────────────────────────
writeJSON(path.join(stateDir, "goals.json"), [
	{
		id: GOAL_ID,
		title: "Add dark mode support",
		cwd: workDir,
		state: "in-progress",
		spec: "Add dark mode support with CSS custom properties. Implement a toggle switch in the header, persist preference to localStorage, and ensure all components respect the theme. Include prefers-color-scheme media query support.",
		createdAt: BASE_TS,
		updatedAt: BASE_TS + 100000,
		projectId: PROJECT_ID,
		team: true,
		setupStatus: "ready",
		workflowId: "feature",
		workflow: frozenWorkflow,
	},
]);

// ── sessions.json ──────────────────────────────────────────────────────────
const coderJsonl = path.join(messagesDir, "coder.jsonl");
const reviewerJsonl = path.join(messagesDir, "reviewer.jsonl");

writeJSON(path.join(stateDir, "sessions.json"), [
	{
		id: SESS_GOAL,
		title: "Goal: Add dark mode",
		cwd: workDir,
		agentSessionFile: "",
		createdAt: BASE_TS,
		lastActivity: BASE_TS + 100000,
		projectId: PROJECT_ID,
		goalId: GOAL_ID,
		assistantType: "goal",
		goalAssistant: true,
		archived: true,
		archivedAt: BASE_TS + 100000,
		sandboxed: false,
	},
	{
		id: SESS_CODER,
		title: "Coder: dark mode",
		cwd: workDir,
		agentSessionFile: coderJsonl,
		createdAt: BASE_TS,
		lastActivity: BASE_TS + 100000,
		projectId: PROJECT_ID,
		teamGoalId: GOAL_ID,
		role: "coder",
		modelProvider: "anthropic",
		modelId: "claude-sonnet-4-20250514",
		archived: true,
		archivedAt: BASE_TS + 100000,
		sandboxed: false,
	},
	{
		id: SESS_REVIEWER,
		title: "Reviewer: dark mode",
		cwd: workDir,
		agentSessionFile: reviewerJsonl,
		createdAt: BASE_TS,
		lastActivity: BASE_TS + 100000,
		projectId: PROJECT_ID,
		teamGoalId: GOAL_ID,
		role: "reviewer",
		modelProvider: "anthropic",
		modelId: "claude-sonnet-4-20250514",
		archived: true,
		archivedAt: BASE_TS + 100000,
		sandboxed: false,
	},
]);

// ── gates.json ─────────────────────────────────────────────────────────────
writeJSON(path.join(stateDir, "gates.json"), [
	{
		gateId: "design-doc",
		goalId: GOAL_ID,
		status: "passed",
		currentContent:
			"# Dark Mode Design\n\n## Overview\nAdd dark mode support using CSS custom properties.\n\n## Approach\n1. Define CSS custom properties for all colors in `:root`\n2. Add `[data-theme=\"dark\"]` selector overrides\n3. Implement toggle component in header\n4. Persist preference to localStorage\n5. Respect `prefers-color-scheme` media query\n\n## Files Changed\n- `src/styles/theme.css` — custom properties\n- `src/components/ThemeToggle.ts` — toggle button\n- `src/app/init.ts` — theme initialization\n\n## Acceptance Criteria\n- Toggle switches between light and dark mode\n- Preference persists across page reloads\n- System preference is respected on first visit",
		currentContentVersion: 1,
		signals: [
			{
				id: SIGNAL_1,
				gateId: "design-doc",
				goalId: GOAL_ID,
				sessionId: SESS_GOAL,
				timestamp: BASE_TS + 10000,
				commitSha: "abc1234def5678",
				content: "# Dark Mode Design\n\n## Overview\nAdd dark mode support using CSS custom properties.",
				contentVersion: 1,
				verification: {
					status: "passed",
					steps: [
						{
							name: "Design review",
							type: "llm-review",
							passed: true,
							output:
								"Design is clear, well-structured, and complete. Architecture is sound.",
							duration_ms: 12000,
						},
						{
							name: "Gap analysis",
							type: "llm-review",
							passed: true,
							output:
								"All requirements from the spec are addressed in the design. No gaps found.",
							duration_ms: 8000,
						},
					],
				},
			},
		],
		updatedAt: BASE_TS + 20000,
	},
	{
		gateId: "implementation",
		goalId: GOAL_ID,
		status: "passed",
		currentContent: "Implementation complete",
		currentContentVersion: 1,
		signals: [
			{
				id: SIGNAL_2,
				gateId: "implementation",
				goalId: GOAL_ID,
				sessionId: SESS_CODER,
				timestamp: BASE_TS + 50000,
				commitSha: "def5678abc1234",
				content: "Implementation complete",
				contentVersion: 1,
				verification: {
					status: "passed",
					steps: [
						{
							name: "Type check passes",
							type: "command",
							passed: true,
							output: "No errors found.",
							duration_ms: 5000,
						},
						{
							name: "Unit tests",
							type: "command",
							passed: true,
							output: "42 tests passed, 0 failed.",
							duration_ms: 15000,
						},
						{
							name: "E2E tests",
							type: "command",
							passed: true,
							output: "12 tests passed, 0 failed.",
							duration_ms: 45000,
						},
						{
							name: "Gap analysis",
							type: "llm-review",
							passed: true,
							output:
								"All acceptance criteria are met. Implementation matches the design.",
							duration_ms: 20000,
						},
						{
							name: "Code quality review",
							type: "llm-review",
							passed: true,
							output:
								"Code is clean, well-structured. No significant issues found.",
							duration_ms: 18000,
						},
						{
							name: "Security review",
							type: "llm-review",
							passed: true,
							output:
								"No security issues found. localStorage usage is safe for theme preferences.",
							duration_ms: 10000,
						},
					],
				},
			},
		],
		updatedAt: BASE_TS + 60000,
	},
	{
		gateId: "documentation",
		goalId: GOAL_ID,
		status: "pending",
		signals: [],
		updatedAt: BASE_TS,
	},
	{
		gateId: "ready-to-merge",
		goalId: GOAL_ID,
		status: "pending",
		signals: [],
		updatedAt: BASE_TS,
	},
]);

// ── tasks.json ─────────────────────────────────────────────────────────────
writeJSON(path.join(stateDir, "tasks.json"), [
	{
		id: TASK_1,
		goalId: GOAL_ID,
		title: "Write design document for dark mode",
		type: "custom",
		state: "complete",
		assignedSessionId: SESS_GOAL,
		createdAt: BASE_TS,
		updatedAt: BASE_TS + 10000,
		completedAt: BASE_TS + 10000,
	},
	{
		id: TASK_2,
		goalId: GOAL_ID,
		title: "Implement dark mode support",
		type: "implementation",
		state: "complete",
		assignedSessionId: SESS_CODER,
		createdAt: BASE_TS + 10000,
		updatedAt: BASE_TS + 50000,
		completedAt: BASE_TS + 50000,
		headSha: "def5678abc1234",
		branch: "goal/dark-mode",
		dependsOn: [TASK_1],
	},
	{
		id: TASK_3,
		goalId: GOAL_ID,
		title: "Review dark mode implementation",
		type: "code-review",
		state: "complete",
		assignedSessionId: SESS_REVIEWER,
		createdAt: BASE_TS + 50000,
		updatedAt: BASE_TS + 70000,
		completedAt: BASE_TS + 70000,
		dependsOn: [TASK_2],
	},
]);

// ── team-state.json ────────────────────────────────────────────────────────
writeJSON(path.join(stateDir, "team-state.json"), [
	{
		goalId: GOAL_ID,
		teamLeadSessionId: null,
		agents: [
			{
				sessionId: SESS_CODER,
				role: "coder",
				task: "Implement dark mode support",
				createdAt: BASE_TS,
			},
			{
				sessionId: SESS_REVIEWER,
				role: "reviewer",
				task: "Review dark mode implementation",
				createdAt: BASE_TS + 30000,
			},
		],
		maxConcurrent: 8,
	},
]);

// ── JSONL message files (pi-ai format) ─────────────────────────────────────
function jsonlLine(msg) {
	return JSON.stringify({ type: "message", message: msg });
}

function assistantMsg(content, opts = {}) {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "claude-sonnet-4-20250514",
		usage: { input: opts.inputTokens || 500, output: opts.outputTokens || 200 },
		stopReason: opts.stopReason || "toolUse",
		timestamp: opts.timestamp || BASE_TS,
	};
}

function toolResult(toolCallId, toolName, text, opts = {}) {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: opts.isError || false,
		timestamp: opts.timestamp || BASE_TS,
	};
}

// ── coder.jsonl ────────────────────────────────────────────────────────────
const coderLines = [
	// User prompt
	jsonlLine({
		role: "user",
		content: [
			{
				type: "text",
				text: "Implement dark mode support with CSS custom properties. Add a toggle in the header, persist to localStorage, and support prefers-color-scheme.",
			},
		],
		timestamp: BASE_TS + 10000,
	}),

	// Assistant: Read CSS file
	jsonlLine(
		assistantMsg(
			[
				{ type: "text", text: "I'll start by reading the current CSS theme file to understand the existing color scheme." },
				{
					type: "toolCall",
					id: "tc_read_1",
					name: "Read",
					arguments: { path: "src/styles/theme.css" },
				},
			],
			{ timestamp: BASE_TS + 11000 },
		),
	),
	jsonlLine(
		toolResult(
			"tc_read_1",
			"Read",
			":root {\n  --bg-primary: #ffffff;\n  --bg-secondary: #f5f5f5;\n  --text-primary: #1a1a1a;\n  --text-secondary: #666666;\n  --border-color: #e0e0e0;\n  --accent: #3b82f6;\n}",
			{ timestamp: BASE_TS + 12000 },
		),
	),

	// Assistant: Edit CSS file
	jsonlLine(
		assistantMsg(
			[
				{ type: "text", text: "Now I'll add the dark mode custom properties alongside the existing light theme." },
				{
					type: "toolCall",
					id: "tc_edit_1",
					name: "Edit",
					arguments: {
						path: "src/styles/theme.css",
						oldText: ":root {",
						newText:
							':root {\n  color-scheme: light dark;\n}\n\n[data-theme="light"], :root {',
					},
				},
			],
			{ timestamp: BASE_TS + 13000 },
		),
	),
	jsonlLine(
		toolResult("tc_edit_1", "Edit", "File edited successfully.", {
			timestamp: BASE_TS + 14000,
		}),
	),

	// Assistant: Run type check
	jsonlLine(
		assistantMsg(
			[
				{ type: "text", text: "Let me verify the changes compile correctly." },
				{
					type: "toolCall",
					id: "tc_bash_1",
					name: "Bash",
					arguments: { command: "npm run check" },
				},
			],
			{ timestamp: BASE_TS + 20000 },
		),
	),
	jsonlLine(
		toolResult("tc_bash_1", "Bash", "No errors found.\n\nExit code: 0", {
			timestamp: BASE_TS + 25000,
		}),
	),

	// Assistant: Signal gate
	jsonlLine(
		assistantMsg(
			[
				{ type: "text", text: "All changes are committed and tests pass. Signaling the implementation gate." },
				{
					type: "toolCall",
					id: "tc_gate_1",
					name: "gate_signal",
					arguments: {
						gate_id: "implementation",
						content: "Implementation complete",
					},
				},
			],
			{ timestamp: BASE_TS + 40000 },
		),
	),
	jsonlLine(
		toolResult(
			"tc_gate_1",
			"gate_signal",
			"Gate 'implementation' signaled successfully. Verification started.",
			{ timestamp: BASE_TS + 41000 },
		),
	),

	// Assistant: Update task
	jsonlLine(
		assistantMsg(
			[
				{ type: "text", text: "Updating the task to complete." },
				{
					type: "toolCall",
					id: "tc_task_1",
					name: "task_update",
					arguments: {
						task_id: TASK_2,
						state: "complete",
						head_sha: "def5678abc1234",
						result_summary:
							"Implemented dark mode with CSS custom properties, toggle component, and localStorage persistence.",
					},
				},
			],
			{ timestamp: BASE_TS + 42000 },
		),
	),
	jsonlLine(
		toolResult("tc_task_1", "task_update", "Task updated to complete.", {
			timestamp: BASE_TS + 43000,
		}),
	),

	// Assistant: Final message
	jsonlLine(
		assistantMsg(
			[
				{
					type: "text",
					text: "Implementation complete. All changes committed and pushed.\n\n**Summary of changes:**\n- Added CSS custom properties for dark mode in `theme.css`\n- Created `ThemeToggle.ts` component with sun/moon icons\n- Added theme initialization in `init.ts` with localStorage persistence\n- Added `prefers-color-scheme` media query support\n- All 42 unit tests and 12 E2E tests pass",
				},
			],
			{
				timestamp: BASE_TS + 50000,
				stopReason: "endTurn",
				inputTokens: 1200,
				outputTokens: 400,
			},
		),
	),
];

fs.writeFileSync(coderJsonl, coderLines.join("\n") + "\n");

// ── reviewer.jsonl ─────────────────────────────────────────────────────────
const reviewerLines = [
	// User prompt
	jsonlLine({
		role: "user",
		content: [
			{
				type: "text",
				text: "Review the dark mode implementation. Check the CSS custom properties, toggle component, and localStorage persistence for correctness and quality.",
			},
		],
		timestamp: BASE_TS + 60000,
	}),

	// Assistant: Read and review
	jsonlLine(
		assistantMsg(
			[
				{
					type: "text",
					text: "I'll review the implementation by reading the changed files.",
				},
				{
					type: "toolCall",
					id: "tc_read_r1",
					name: "Read",
					arguments: { path: "src/styles/theme.css" },
				},
			],
			{ timestamp: BASE_TS + 61000 },
		),
	),
	jsonlLine(
		toolResult(
			"tc_read_r1",
			"Read",
			':root {\n  color-scheme: light dark;\n}\n\n[data-theme="light"], :root {\n  --bg-primary: #ffffff;\n  --bg-secondary: #f5f5f5;\n  --text-primary: #1a1a1a;\n  --text-secondary: #666666;\n  --border-color: #e0e0e0;\n  --accent: #3b82f6;\n}\n\n[data-theme="dark"] {\n  --bg-primary: #1a1a2e;\n  --bg-secondary: #16213e;\n  --text-primary: #e0e0e0;\n  --text-secondary: #a0a0a0;\n  --border-color: #2d2d44;\n  --accent: #60a5fa;\n}',
			{ timestamp: BASE_TS + 62000 },
		),
	),

	// Assistant: Submit verification result
	jsonlLine(
		assistantMsg(
			[
				{
					type: "text",
					text: "The implementation looks solid. CSS custom properties are well-organized, the toggle component is clean, and localStorage persistence works correctly. Submitting my verification result.",
				},
				{
					type: "toolCall",
					id: "tc_vr",
					name: "verification_result",
					arguments: {
						verdict: "pass",
						summary:
							"All 5 scenarios passed. Dark mode toggle works correctly, theme persists across reloads, and prefers-color-scheme is respected.",
						report_html:
							'<!DOCTYPE html><html><head><title>QA Report</title></head><body><h1>QA Testing Report: Dark Mode</h1><h2>Summary</h2><p><strong>Passed:</strong> 5 | <strong>Failed:</strong> 0 | <strong>Skipped:</strong> 0</p><h2>Scenarios</h2><div><h3>1. Toggle switch</h3><p>PASS — Theme toggles between light and dark correctly.</p></div><div><h3>2. Persistence</h3><p>PASS — Theme preference persists after page reload.</p></div><div><h3>3. System preference</h3><p>PASS — Respects prefers-color-scheme on first visit.</p></div><div><h3>4. All components themed</h3><p>PASS — Sidebar, header, content area all respect the theme.</p></div><div><h3>5. Transition animation</h3><p>PASS — Smooth 200ms transition between themes.</p></div></body></html>',
					},
				},
			],
			{ timestamp: BASE_TS + 70000, inputTokens: 800, outputTokens: 400 },
		),
	),
	jsonlLine(
		toolResult(
			"tc_vr",
			"verification_result",
			"Verification result submitted successfully.",
			{ timestamp: BASE_TS + 71000 },
		),
	),
];

fs.writeFileSync(reviewerJsonl, reviewerLines.join("\n") + "\n");

// Done
const fileCount =
	2 + // project.yaml + projects.json
	1 + // sessions.json
	1 + // goals.json
	1 + // gates.json
	1 + // tasks.json
	1 + // team-state.json
	2; // JSONL files
console.log(`QA seed: wrote ${fileCount} files to ${workDir}`);
