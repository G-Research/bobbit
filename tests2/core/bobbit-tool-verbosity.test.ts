// v2-native — bobbit gateway tool suite. Discovered from its `tests2/core` path.
//
// Acceptance coverage for compact-by-default Bobbit output, bounded verbose
// reads, and the projection catalogue's drift guard.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import * as Value from "typebox/value";
import { beforeAll, describe, expect, it } from "vitest";
import {
	BOBBIT_COMPACT_PROJECTIONS,
	COMPACT_TEXT_PREVIEW_CHARS,
	COMPACT_TRUNCATION_SUFFIX,
	projectBobbitResponse,
} from "../../defaults/tools/bobbit/compact-projection.ts";
import {
	BOBBIT_OPERATIONS,
	loadBobbitTools,
	stubFetch,
	type CapturedTool,
} from "./helpers/bobbit-harness.ts";

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

function resultText(result: any): string { return result?.content?.[0]?.text ?? ""; }
function resultJson(result: any): any { expect(result.isError).toBeFalsy(); return JSON.parse(resultText(result)); }
function longText(prefix: string): string { return `${prefix}${"x".repeat(COMPACT_TEXT_PREVIEW_CHARS + 40)}`; }
function preview(value: string): string { const chars = Array.from(value); return chars.length <= COMPACT_TEXT_PREVIEW_CHARS ? value : `${chars.slice(0, COMPACT_TEXT_PREVIEW_CHARS).join("")}${COMPACT_TRUNCATION_SUFFIX}`; }

describe("bobbit compact projections", () => {
	it("closes bobbit_read without removed flags", () => { const schema = tools.get("bobbit_read")!.parameters; expect(schema.additionalProperties).toBe(false);
		for (const flag of ["verbose", "include_tool_results", "includeToolResults", "raw_results", "rawResults"]) expect([schema.properties?.[flag], Value.Check(schema, { operation: "health", [flag]: true })]).toEqual([undefined, false]); });
	it("compacts list_goals while preserving identity, state, recency, and pagination", async () => {
		const spec = longText("goal spec: ");
		const goal = {
			id: "goal-1",
			title: "Ship compact output",
			state: "in-progress",
			projectId: "project-1", parentGoalId: "goal-parent", workflowId: "workflow-1",
			createdAt: "2026-07-16T10:00:00.000Z", updatedAt: "2026-07-17T10:00:00.000Z", spec,
			branch: "goal/compact",
			mergeTarget: "main",
			setupStatus: "ready",
			team: { status: "running", activeCount: 2 },
			paused: false,
			workflow: { id: "workflow-1", gates: [{ id: "design", verify: { prompt: longText("verify ") } }] },
			worktreePath: "/private/worktree",
			repoPath: "/private/repo",
			cwd: "/private/cwd",
			sandboxed: true,
			subgoalsAllowed: true,
			autoStartTeam: true,
			generation: 9,
			colorIndex: 3,
		};
		const archivedSession = {
			id: "archived-session-1",
			title: "Archived goal session",
			status: "archived",
			role: "coder",
			archived: true,
			cwd: "/hidden/archived-session",
			clientCount: 1,
		};
		stubFetch(() => ({
			body: {
				goals: [goal],
				archivedSessions: [archivedSession],
				total: 25,
				hasMore: true,
				nextCursor: "goal-cursor-1",
				providerMetadata: { requestId: "provider-only" }, filesystemPath: "/private/envelope", workflowSnapshot: { raw: "large snapshot" },
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "list_goals",
			archived: true,
			limit: 1,
		}));

		expect(data.goals).toHaveLength(1);
		expect(data.goals[0]).toMatchObject({ id: goal.id, title: goal.title, state: goal.state, projectId: goal.projectId,
			parentGoalId: goal.parentGoalId, workflowId: goal.workflowId, createdAt: goal.createdAt, updatedAt: goal.updatedAt });
		for (const dropped of ["spec", "branch", "mergeTarget", "setupStatus", "team", "paused", "workflow", "worktreePath", "repoPath", "cwd",
			"sandboxed", "subgoalsAllowed", "autoStartTeam", "generation", "colorIndex"]) expect(data.goals[0][dropped], dropped === "spec" ? "BOBBIT_READ_LIST_GOALS_MUST_OMIT_SPEC" : dropped).toBeUndefined();
		for (const dropped of ["providerMetadata", "filesystemPath", "workflowSnapshot"]) expect(data[dropped]).toBeUndefined();
		expect(data.archivedSessions).toBeUndefined();
		expect("archivedSessions" in data).toBe(false);
		expect(data.pagination).toMatchObject({
			limit: 1,
			total: 25,
			hasMore: true,
			nextCursor: "goal-cursor-1",
			mode: "cursor",
			itemKey: "goals",
		});
	});

	it("gives get_goal untruncated semantic detail and derives workflowId before dropping internals", async () => {
		const spec = longText("complete goal spec: ");
		stubFetch(() => ({
			body: {
				id: "goal-detail",
				title: "Goal detail",
				state: "todo",
				projectId: "project-1",
				spec,
				workflow: { id: "derived-workflow", gates: [{ id: "implementation", verify: { prompt: "hidden" } }] },
				cwd: "/hidden",
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "get_goal",
			goalId: "goal-detail",
		}));

		expect(data).toMatchObject({ id: "goal-detail", workflowId: "derived-workflow", spec });
		expect(data.spec).not.toContain(COMPACT_TRUNCATION_SUFFIX);
		expect(data.workflow).toBeUndefined();
		expect(data.cwd).toBeUndefined();
	});

	it("keeps session lists discovery-only with concise error indicators and cursor pagination", async () => {
		const session = {
			id: "session-1",
			title: "Implement compact output",
			status: "idle",
			assistantType: "goal",
			role: "coder",
			projectId: "project-1",
			goalId: "goal-1",
			createdAt: "2026-07-16T10:00:00.000Z",
			lastActivity: "2026-07-17T11:00:00.000Z",
			lastTurnErrored: true,
			consecutiveErrorTurns: 2,
			restoreError: "Bearer LIST_SESSION_SECRET_SENTINEL",
			completedTurnCount: 17,
			cwd: "/hidden",
			clientCount: 4,
			lastReadAt: 123,
			isCompacting: true,
			spawnPinnedModel: "provider/model",
			spawnPinnedThinkingLevel: "high",
			imageGenerationModel: "image-model",
			goalAssistant: true,
			roleAssistant: false,
			toolAssistant: false,
		};
		const archivedDelegate = {
			...session,
			id: "delegate-archived",
			title: "Archived delegate",
			archived: true,
			delegateOf: "session-1",
			cwd: "/also-hidden",
		};
		stubFetch(() => ({
			body: {
				sessions: [session],
				archivedDelegates: [archivedDelegate],
				total: 5,
				hasMore: true,
				nextCursor: "session-cursor-1",
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "list_sessions",
			include: "archived",
			limit: 1,
		}));

		expect(data.sessions[0]).toMatchObject({ id: session.id, title: session.title, status: session.status, assistantType: session.assistantType,
			role: session.role, projectId: session.projectId, goalId: session.goalId, createdAt: session.createdAt, lastActivity: session.lastActivity,
			lastTurnErrored: true, consecutiveErrorTurns: 2, restoreFailed: true });
		expect(data.sessions[0].restoreError).toBeUndefined(); expect(JSON.stringify(data.sessions[0])).not.toContain("LIST_SESSION_SECRET_SENTINEL");
		for (const dropped of ["completedTurnCount", "cwd", "clientCount", "lastReadAt", "isCompacting", "spawnPinnedModel", "spawnPinnedThinkingLevel", "imageGenerationModel", "goalAssistant", "roleAssistant", "toolAssistant"]) expect(data.sessions[0][dropped], dropped).toBeUndefined();
		expect(data.archivedDelegates[0]).toMatchObject({
			id: "delegate-archived",
			archived: true,
			delegateOf: "session-1",
		});
		expect(data.archivedDelegates[0].cwd).toBeUndefined();
		expect(data.pagination).toMatchObject({
			limit: 1,
			total: 5,
			hasMore: true,
			nextCursor: "session-cursor-1",
			mode: "cursor",
		});
	});
	it("gives get_session useful links and safe diagnostics without disclosing raw errors", async () => {
		const safe = { id: "session-detail", title: "Detailed session", status: "idle", assistantType: "goal", role: "tester", projectId: "project-1", goalId: "goal-1", teamGoalId: "team-goal-1", teamLeadSessionId: "lead-1", taskId: "task-1", staffId: "staff-1", parentSessionId: "parent-1", delegateOf: "delegator-1", createdAt: "2026-07-16T10:00:00Z", lastActivity: "2026-07-17T11:00:00Z", completedTurnCount: 17, lastTurnErrored: true, consecutiveErrorTurns: 3, manualRetryRequired: true, transientRetryAttempts: 2, recoverDrainAttempts: 1, condition: { kind: "model-selection-required", message: "Choose a supported model" } }, secret = String.raw`Bearer SECRET_SENTINEL at C:\private\session.ts`, omitted = ["restoreError", "lastTurnErrorMessage", "cwd", "worktreePath", "repoWorktrees", "draft", "preview", "sidePanelWorkspace", "storagePath", "model", "providerMetadata", "workflow"];
		stubFetch(() => ({ body: { ...safe, restoreError: { code: "PRIVATE_CODE", message: secret }, lastTurnErrorMessage: secret, ...Object.fromEntries(omitted.slice(2).map((field) => [field, "private"])) } }));
		const data = resultJson(await tools.get("bobbit_read")!.execute("id", { operation: "get_session", sessionId: safe.id }));
		expect(data).toMatchObject({ ...safe, restoreFailed: true }); for (const field of omitted) expect(data[field], field).toBeUndefined();
		expect(JSON.stringify(data)).not.toContain("SECRET_SENTINEL"); expect(typeof data.restoreFailed).toBe("boolean");
	});

	it("gives get_project semantic detail without filesystem or internal configuration", async () => {
		const safe = { id: "project-detail", name: "Detailed project", status: "active", primaryBranch: "main", description: "Useful project detail" }, omitted = ["rootPath", "config", "providerMetadata", "workflowSnapshot"];
		stubFetch(() => ({ body: { ...safe, ...Object.fromEntries(omitted.map((field) => [field, `PROJECT_SENTINEL_${field}`])) } }));
		const data = resultJson(await tools.get("bobbit_read")!.execute("id", { operation: "get_project", projectId: safe.id }));
		expect(data).toMatchObject(safe); for (const field of omitted) expect(data[field], field).toBeUndefined(); expect(JSON.stringify(data)).not.toContain("PROJECT_SENTINEL");
	});

	it("compacts search hits and truncates snippets without losing ranking or pagination", async () => {
		const snippet = longText("matching text: ");
		stubFetch(() => ({
			body: {
				results: [{
					id: "hit-1",
					type: "goal",
					title: "Matching goal",
					score: 0.98,
					projectId: "project-1",
					updatedAt: "2026-07-17T12:00:00.000Z",
					snippet,
					body: longText("indexed full body: "),
					sourceDocument: { raw: longText("raw source: ") },
				}],
				total: 12,
				hasMore: true,
				nextOffset: 6,
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "search",
			q: "matching",
			limit: 1,
			offset: 5,
		}));

		expect(data.results[0]).toMatchObject({
			id: "hit-1",
			type: "goal",
			title: "Matching goal",
			score: 0.98,
			projectId: "project-1",
			snippet: preview(snippet),
		});
		expect(data.results[0].body).toBeUndefined();
		expect(data.results[0].sourceDocument).toBeUndefined();
		expect(data.pagination).toMatchObject({ total: 12, hasMore: true, nextOffset: 6 });
	});

	it("keeps task lists discovery-only while retaining identity and action fields", async () => {
		const spec = longText("task spec: ");
		const resultSummary = longText("task result: ");
		stubFetch(() => ({
			body: {
				tasks: [{
					id: "task-1",
					goalId: "goal-1",
					title: "Test compact output",
					type: "testing",
					state: "in-progress",
					dependsOn: ["task-0"],
					assignedTo: "session-1",
					workflowGateId: "implementation",
					inputGateIds: ["design-doc"],
					branch: "goal/compact",
					headSha: "abc123",
					spec,
					resultSummary,
					verify: { prompt: longText("verify task: ") },
				}],
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "list_tasks",
			goalId: "goal-1",
			limit: 10,
		}));

		expect(data.tasks[0]).toMatchObject({
			id: "task-1",
			goalId: "goal-1",
			title: "Test compact output",
			type: "testing",
			state: "in-progress",
			dependsOn: ["task-0"],
			assignedTo: "session-1",
			workflowGateId: "implementation",
		});
		for (const field of ["spec", "resultSummary"]) expect(data.tasks[0][field]).toBeUndefined();
		expect(data.tasks[0].verify).toBeUndefined();
		expect(data.pagination).toMatchObject({ itemKey: "tasks", limit: 10, total: 1 });
	});

	it("compacts gates while retaining action and count fields and dropping content/output bodies", async () => {
		const content = longText("gate content: ");
		stubFetch(() => ({
			body: {
				gates: [{
					id: "gate-row-1",
					gateId: "implementation",
					goalId: "goal-1",
					name: "Implementation",
					type: "content",
					status: "pending",
					dependsOn: ["design-doc"],
					assignedTo: "session-1",
					signalCount: 2,
					hasContent: true,
					contentLength: content.length,
					updatedAt: "2026-07-17T12:00:00.000Z",
					currentContent: content,
					verify: { prompt: longText("verify gate: ") },
					verification: { output: longText("verification output: ") },
					signals: [{ content: longText("signal body: ") }],
				}],
				summary: { passed: 1, total: 2, runningGateIds: [] },
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", {
			operation: "list_gates",
			goalId: "goal-1",
			limit: 10,
		}));

		expect(data.gates[0]).toMatchObject({
			id: "gate-row-1",
			gateId: "implementation",
			goalId: "goal-1",
			name: "Implementation",
			type: "content",
			status: "pending",
			dependsOn: ["design-doc"],
			assignedTo: "session-1",
			signalCount: 2,
			hasContent: true,
			contentLength: content.length,
		});
		for (const field of ["currentContent", "content"]) expect(data.gates[0][field]).toBeUndefined();
		expect(data.gates[0].verify).toBeUndefined();
		expect(data.gates[0].verification).toBeUndefined();
		expect(data.gates[0].signals).toBeUndefined();
		expect(data.summary).toMatchObject({ passed: 1, total: 2 });
		expect(data.pagination).toMatchObject({ itemKey: "gates", limit: 10, total: 1 });
	});

	it("universally preserves successful error/code diagnostics", async () => {
		stubFetch(() => ({
			body: {
				id: "health-check-1",
				status: "degraded",
				error: longText("database unavailable: "),
				code: "DATABASE_UNAVAILABLE",
				generation: 44,
			},
		}));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", { operation: "health" }));
		expect(data).toMatchObject({
			id: "health-check-1",
			status: "degraded",
			code: "DATABASE_UNAVAILABLE",
		});
		// Error text is actionable and is therefore never truncated.
		expect(data.error).toBe(longText("database unavailable: "));
		expect(data.generation).toBeUndefined();
	});

	it("preserves legitimate generic verify data but omits verifier prompts from known profiles", () => {
		const shortSummary = "✅ signature verified";
		const nonBmpDetails = `${"🙂".repeat(COMPACT_TEXT_PREVIEW_CHARS)}🚀tail`;
		const genericDiagnostic = projectBobbitResponse("bobbit_read", "health", {
			status: "healthy",
			verify: { summary: shortSummary, details: nonBmpDetails },
		}) as any;

		expect(genericDiagnostic.verify).toEqual({
			summary: shortSummary,
			details: preview(nonBmpDetails),
		});
		expect(Array.from(genericDiagnostic.verify.details.slice(0, -COMPACT_TRUNCATION_SUFFIX.length))).toHaveLength(
			COMPACT_TEXT_PREVIEW_CHARS,
		);

		const task = projectBobbitResponse("bobbit_read", "get_task", {
			id: "task-verify",
			title: "Known task",
			verify: { prompt: longText("task verifier: ") },
		}) as any;
		const workflow = projectBobbitResponse("bobbit_read", "get_workflow", {
			id: "workflow-verify",
			name: "Known workflow",
			gates: [{ id: "gate-verify", name: "Known gate", verify: { prompt: longText("gate verifier: ") } }],
		}) as any;

		expect(task.verify).toBeUndefined();
		expect(workflow.gates[0].verify).toBeUndefined();
	});

	it.each([
		["goal_cost", { goalId: "goal-1" }],
		["session_cost", { sessionId: "session-1" }],
	] as const)("returns %s payloads structurally unchanged", async (operation, ids) => {
		const cost = {
			id: `${operation}-record`,
			totalCostUsd: 3.14,
			inputTokens: 1200,
			outputTokens: 300,
			byModel: { "provider/model": { inputTokens: 1200, outputTokens: 300, costUsd: 3.14 } },
		};
		stubFetch(() => ({ body: cost }));

		const data = resultJson(await tools.get("bobbit_read")!.execute("id", { operation, ...ids }));
		expect(data).toEqual(cost);
	});
});

describe("unaffected Bobbit mutation-tool verbose behavior", () => {
	it("projects orchestrate responses by default and permits full verbose JSON without limit", async () => {
		const spec = longText("created goal spec: ");
		const response = {
			id: "goal-created",
			title: "Created goal",
			state: "todo",
			projectId: "project-1",
			spec,
			workflow: { id: "workflow-created", gates: [{ id: "design", verify: { prompt: "hidden by default" } }] },
			cwd: "/created/cwd",
			generation: 2,
		};
		const calls = stubFetch(() => ({ body: response }));
		const tool = tools.get("bobbit_orchestrate")!;
		const baseParams = { operation: "create_goal", projectId: "project-1", title: "Created goal" };

		const compact = resultJson(await tool.execute("compact", baseParams));
		const verbose = resultJson(await tool.execute("verbose", { ...baseParams, verbose: true }));

		expect(calls).toHaveLength(2);
		expect(compact).toMatchObject({
			id: response.id,
			title: response.title,
			state: response.state,
			projectId: response.projectId,
			workflowId: "workflow-created",
			spec: preview(spec),
		});
		expect(compact.workflow).toBeUndefined();
		expect(compact.cwd).toBeUndefined();
		expect(compact.generation).toBeUndefined();
		expect(verbose).toEqual(response);
	});

	it("projects admin responses by default and permits full verbose JSON without limit", async () => {
		const description = longText("project description: ");
		const response = {
			id: "project-created",
			name: "Created project",
			status: "active",
			rootPath: "/workspace/project",
			description,
			components: [{ name: "app", repo: "." }],
			config: { secret: "full-config" },
			workflows: { general: { gates: [{ verify: { prompt: "full prompt" } }] } },
			generation: 3,
		};
		const calls = stubFetch(() => ({ body: response }));
		const tool = tools.get("bobbit_admin")!;
		const baseParams = { operation: "create_project", name: "Created project", rootPath: "/workspace/project" };

		const compact = resultJson(await tool.execute("compact", baseParams));
		const verbose = resultJson(await tool.execute("verbose", { ...baseParams, verbose: true }));

		expect(calls).toHaveLength(2);
		expect(compact).toMatchObject({
			id: response.id,
			name: response.name,
			status: response.status,
			rootPath: response.rootPath,
			description: preview(description),
		});
		expect(compact.components).toBeUndefined();
		expect(compact.config).toBeUndefined();
		expect(compact.workflows).toBeUndefined();
		expect(compact.generation).toBeUndefined();
		expect(verbose).toEqual(response);
	});
});

describe("bobbit compact projection catalogue", () => {
	it("pins the shared preview length", () => {
		expect(COMPACT_TEXT_PREVIEW_CHARS).toBe(200);
	});

	for (const toolName of Object.keys(BOBBIT_OPERATIONS) as Array<keyof typeof BOBBIT_OPERATIONS>) {
		it(`${toolName} has exactly one explicit projection entry per exported operation`, () => {
			expect(Object.keys(BOBBIT_COMPACT_PROJECTIONS[toolName]).sort()).toEqual(
				[...BOBBIT_OPERATIONS[toolName]].sort(),
			);
		});
	}
});
