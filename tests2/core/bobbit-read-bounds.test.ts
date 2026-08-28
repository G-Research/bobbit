// v2-native — focused bobbit_read response-bound regressions. Discovered from its `tests2/core` path.
import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import { beforeAll, describe, expect, it } from "vitest";
import { COMPACT_TEXT_PREVIEW_CHARS } from "../../defaults/tools/bobbit/compact-projection.ts";
import { loadBobbitTools, stubFetch, type CapturedTool, type FetchCall } from "./helpers/bobbit-harness.ts";

let tools: Map<string, CapturedTool>;

beforeAll(() => {
	process.env.BOBBIT_TOKEN = "tok";
	process.env.BOBBIT_GATEWAY_URL = "https://gw.test";
	tools = loadBobbitTools();
});

function json(result: any): any {
	expect(result.isError).toBeFalsy();
	return JSON.parse(result?.content?.[0]?.text ?? "");
}

async function read(params: Record<string, unknown>): Promise<any> {
	return json(await tools.get("bobbit_read")!.execute("bounds-test", params));
}

function query(call: FetchCall): URLSearchParams {
	return new URL(call.url).searchParams;
}

function occurrences(value: unknown, sentinel: string): number {
	return JSON.stringify(value).split(sentinel).length - 1;
}

describe("bobbit_read — bounded goal detail", () => {
	it("BOBBIT_READ_SUMMARY_BOUND: get_goal summary has only useful identity/status fields and no large detail", async () => {
		const largeSpec = `SPEC_BOUND_SENTINEL_${"s".repeat(8_000)}`;
		const largeWorkflow = `WORKFLOW_BOUND_SENTINEL_${"w".repeat(8_000)}`;
		const goal = {
			id: "goal-bounded",
			title: "Bound Bobbit reads",
			state: "in-progress",
			projectId: "project-1",
			workflowId: "workflow-1",
			parentGoalId: "parent-1",
			rootGoalId: "root-1",
			paused: true,
			archived: true,
			archivedAt: "2026-08-01T00:00:00.000Z",
			setupStatus: "failed",
			setupError: "Actionable setup failure",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-08-02T00:00:00.000Z",
			spec: largeSpec,
			workflow: { id: "workflow-1", raw: largeWorkflow, gates: [{ content: largeWorkflow }] },
			cwd: `C:/private/${largeWorkflow}`,
			worktreePath: largeWorkflow,
			config: { private: largeWorkflow },
			providerMetadata: { private: largeWorkflow },
			branch: `goal/${largeWorkflow}`,
			mergeTarget: "main",
			futureUnclassifiedDetail: largeWorkflow,
		};
		stubFetch(() => ({ body: goal }));

		const summary = await read({ operation: "get_goal", goalId: goal.id, view: "summary" });

		const allowedFields = [
			"id", "title", "state", "projectId", "workflowId", "parentGoalId", "rootGoalId",
			"paused", "archived", "archivedAt", "setupStatus", "setupError", "createdAt", "updatedAt",
		].sort();
		expect(
			Object.keys(summary).sort(),
			"BOBBIT_READ_SUMMARY_BOUND: summary must use the exhaustive identity/status allowlist",
		).toEqual(allowedFields);
		expect(summary).toMatchObject({
			id: goal.id, title: goal.title, state: goal.state, projectId: goal.projectId,
			workflowId: goal.workflowId, parentGoalId: goal.parentGoalId, rootGoalId: goal.rootGoalId,
			paused: goal.paused, archived: goal.archived, archivedAt: goal.archivedAt,
			setupStatus: goal.setupStatus, setupError: goal.setupError,
			createdAt: goal.createdAt, updatedAt: goal.updatedAt,
		});
		const serialized = JSON.stringify(summary);
		expect(serialized).not.toContain("SPEC_BOUND_SENTINEL");
		expect(serialized).not.toContain("WORKFLOW_BOUND_SENTINEL");
		expect(serialized.length).toBeLessThan(1_000);
	});

	it.each([
		["omitted view", undefined],
		["explicit full view", "full"],
	] as const)("keeps the untruncated goal spec for %s", async (_label, view) => {
		const spec = `FULL_SPEC_SENTINEL_${"x".repeat(COMPACT_TEXT_PREVIEW_CHARS + 2_000)}`;
		stubFetch(() => ({
			body: {
				id: "goal-full",
				title: "Full goal",
				state: "todo",
				projectId: "project-1",
				spec,
				workflow: { id: "derived-workflow" },
			},
		}));
		const params: Record<string, unknown> = { operation: "get_goal", goalId: "goal-full" };
		if (view !== undefined) params.view = view;

		const data = await read(params);

		expect(data).toMatchObject({ id: "goal-full", workflowId: "derived-workflow", spec });
		expect(data.spec).toHaveLength(spec.length);
	});
});

const gateRows = Array.from({ length: 3 }, (_, index) => ({
	id: `gate-row-${index + 1}`,
	gateId: `gate-${index + 1}`,
	goalId: "goal-gates",
	name: `Gate ${index + 1} ${"n".repeat(250)}`,
	type: "content",
	status: index === 0 ? "passed" : "pending",
	dependsOn: index === 0 ? [] : [`gate-${index}`],
	assignedTo: `session-${index + 1}`,
	signalCount: index + 1,
	hasContent: true,
	contentLength: 4_000 + index,
	phase: "delivery",
	updatedAt: `2026-08-0${index + 1}T00:00:00.000Z`,
	currentContent: `GATE_BODY_SENTINEL_${index}_${"c".repeat(4_000)}`,
}));

function gateEndpointFixture(url: string, rows = gateRows): { body: unknown } {
	const u = new URL(url);
	const limitParam = u.searchParams.get("limit");
	const offsetParam = u.searchParams.get("offset");
	const pagingEnabled = limitParam !== null || offsetParam !== null;
	const limit = Math.max(1, Number(limitParam ?? rows.length));
	const offset = Math.max(0, Number(offsetParam ?? 0));
	const page = pagingEnabled ? rows.slice(offset, offset + limit) : rows;
	const hasMore = offset + page.length < rows.length;
	return {
		body: {
			gates: page,
			...(pagingEnabled ? {
				total: rows.length,
				limit,
				offset,
				hasMore,
				...(hasMore ? { nextOffset: offset + page.length } : {}),
			} : {}),
			summary: {
				passed: 1,
				pending: rows.length - 1,
				running: 0,
				total: rows.length,
				gates: page,
			},
		},
	};
}

function expectCanonicalGatePage(data: any, expectedGateId: string, expectedOffset: number): void {
	expect(data.gates).toHaveLength(1);
	expect(data.gates[0]).toMatchObject({
		gateId: expectedGateId,
		goalId: "goal-gates",
		assignedTo: `session-${expectedOffset + 1}`,
		signalCount: expectedOffset + 1,
		hasContent: true,
		contentLength: 4_000 + expectedOffset,
		phase: "delivery",
	});
	expect(data.summary).toMatchObject({ passed: 1, pending: 2, running: 0, total: 3 });
	expect(data.summary.gates, "list_gates must expose only the canonical root gates collection").toBeUndefined();
	expect(occurrences(data, `\"gateId\":\"${expectedGateId}\"`)).toBeLessThanOrEqual(1);
}

describe("bobbit_read — bounded gate pages", () => {
	it.each([
		["omitted view", undefined],
		["summary view", "summary"],
		["full view", "full"],
	] as const)("honors limit=1 for %s and retains canonical paging plus legacy gate fields", async (_label, view) => {
		const calls = stubFetch((url) => gateEndpointFixture(url));
		const params: Record<string, unknown> = { operation: "list_gates", goalId: "goal-gates", limit: 1 };
		if (view !== undefined) params.view = view;

		const data = await read(params);

		expect(query(calls[0]).get("limit")).toBe("1");
		expect(query(calls[0]).get("offset")).toBe("0");
		if (view !== undefined) expect(query(calls[0]).get("view")).toBe(view);
		expectCanonicalGatePage(data, "gate-1", 0);
		expect(data.pagination).toMatchObject({
			limit: 1,
			offset: 0,
			total: 3,
			hasMore: true,
			nextOffset: 1,
			nextCursor: 1,
			mode: "offset",
			itemKey: "gates",
			pagedBy: "rest",
		});
		if (view === "summary") {
			expect(JSON.stringify(data)).not.toContain("GATE_BODY_SENTINEL");
			expect(JSON.stringify(data).length).toBeLessThan(1_500);
		}
	});

	it("supports non-overlapping offset continuation through a terminal page", async () => {
		const calls = stubFetch((url) => gateEndpointFixture(url));
		const first = await read({ operation: "list_gates", goalId: "goal-gates", limit: 1 });
		const second = await read({ operation: "list_gates", goalId: "goal-gates", limit: 1, offset: first.pagination.nextOffset });
		const terminal = await read({ operation: "list_gates", goalId: "goal-gates", limit: 1, offset: second.pagination.nextOffset });

		expect(first.gates[0].gateId).toBe("gate-1");
		expect(second.gates[0].gateId).toBe("gate-2");
		expect(terminal.gates[0].gateId).toBe("gate-3");
		expect(query(calls[1]).get("offset")).toBe("1");
		expect(query(calls[2]).get("offset")).toBe("2");
		expect(terminal.pagination).toMatchObject({ total: 3, hasMore: false, offset: 2, mode: "offset" });
		expect(terminal.pagination.nextOffset).toBeUndefined();
		expect(terminal.pagination.nextCursor).toBeUndefined();
	});

	it.each(["cursor", "after"] as const)("translates numeric %s continuation into REST offset paging", async (cursorParam) => {
		const calls = stubFetch((url) => gateEndpointFixture(url));
		const first = await read({ operation: "list_gates", goalId: "goal-gates", limit: 1 });
		const second = await read({
			operation: "list_gates",
			goalId: "goal-gates",
			limit: 1,
			[cursorParam]: first.pagination.nextCursor,
		});
		const terminal = await read({
			operation: "list_gates",
			goalId: "goal-gates",
			limit: 1,
			[cursorParam]: second.pagination.nextCursor,
		});

		expect(query(calls[1]).get("offset")).toBe("1");
		expect(query(calls[1]).has("cursor")).toBe(false);
		expect(query(calls[1]).has("after")).toBe(false);
		expect(second.gates[0].gateId).toBe("gate-2");
		expect(second.pagination).toMatchObject({
			limit: 1,
			total: 3,
			hasMore: true,
			cursor: 1,
			nextCursor: 2,
			mode: "cursor",
		});
		expect(second.pagination.nextOffset).toBeUndefined();
		expect(terminal.gates[0].gateId).toBe("gate-3");
		expect(terminal.pagination).toMatchObject({ total: 3, hasMore: false, cursor: 2, mode: "cursor" });
		expect(terminal.pagination.nextCursor).toBeUndefined();
		expect(terminal.pagination.nextOffset).toBeUndefined();
	});

	it("gives cursor precedence over after and offset", async () => {
		const calls = stubFetch((url) => gateEndpointFixture(url));

		const data = await read({
			operation: "list_gates",
			goalId: "goal-gates",
			limit: 1,
			offset: 0,
			after: 1,
			cursor: 2,
		});

		expect(query(calls[0]).get("offset")).toBe("2");
		expect(data.gates.map((gate: any) => gate.gateId)).toEqual(["gate-3"]);
		expect(data.pagination).toMatchObject({ mode: "cursor", cursor: 2, total: 3, hasMore: false });
	});

	it("applies the documented default bound even when paging controls are omitted", async () => {
		const manyRows = Array.from({ length: 55 }, (_, index) => ({
			...gateRows[index % gateRows.length],
			id: `default-row-${index}`,
			gateId: `default-gate-${index}`,
			assignedTo: `default-session-${index}`,
		}));
		const calls = stubFetch((url) => gateEndpointFixture(url, manyRows));

		const data = await read({ operation: "list_gates", goalId: "goal-gates" });

		expect(query(calls[0]).get("limit")).toBe("50");
		expect(query(calls[0]).get("offset")).toBe("0");
		expect(data.gates).toHaveLength(50);
		expect(data.gates[0]).toMatchObject({ assignedTo: "default-session-0", contentLength: 4_000 });
		expect(data.pagination).toMatchObject({ limit: 50, total: 55, hasMore: true, nextOffset: 50, nextCursor: 50 });
		expect(data.summary.gates).toBeUndefined();
	});
});

function gitResult(label: string, fileCount: number) {
	return {
		branch: `goal/${label}`,
		primaryBranch: "main",
		primaryRef: "origin/main",
		isOnPrimary: false,
		hasUpstream: true,
		ahead: 2,
		behind: 1,
		aheadOfPrimary: 3,
		behindPrimary: 0,
		mergedIntoPrimary: false,
		insertionsVsPrimary: 40,
		deletionsVsPrimary: 12,
		clean: false,
		unpushed: true,
		partial: false,
		untrackedIncluded: true,
		summary: `${label} changes`,
		status: Array.from({ length: fileCount }, (_, index) => ({
			file: `GIT_FILE_SENTINEL_${label}_${index}_${"f".repeat(180)}`,
			status: index % 2 === 0 ? "M" : "A",
		})),
	};
}

function gitEnvelope(repoCount: number) {
	const aggregate = gitResult(`aggregate-${repoCount}`, 24);
	const repos = Object.fromEntries(Array.from({ length: repoCount }, (_, index) => [
		`repo-${index + 1}`,
		gitResult(`repo-${index + 1}`, 12),
	]));
	return {
		...aggregate,
		aggregate,
		repos,
		data: { ...aggregate, aggregate, repos },
		observedAt: 1_786_000_000_500,
		refreshedAt: 1_786_000_000_000,
		stale: false,
		source: "repository",
		ageMs: 500,
		lastError: { kind: `transient-${"e".repeat(300)}`, observedAt: 1_785_999_000_000 },
	};
}

describe("bobbit_read — bounded git status summary", () => {
	it.each([
		["single-repo", 1],
		["multi-repo", 2],
	] as const)("returns one scalar aggregate with freshness for %s status", async (_label, repoCount) => {
		const fixture = gitEnvelope(repoCount);
		stubFetch(() => ({ body: fixture }));

		const data = await read({ operation: "goal_git_status", goalId: "goal-git", view: "summary" });
		const { status: _status, ...aggregateScalars } = fixture.aggregate;

		expect(data.aggregate).toEqual({ ...aggregateScalars, changedFiles: fixture.aggregate.status.length });
		expect(data).toMatchObject({
			observedAt: fixture.observedAt,
			refreshedAt: fixture.refreshedAt,
			stale: fixture.stale,
			source: fixture.source,
			ageMs: fixture.ageMs,
		});
		expect(Object.keys(data).sort()).toEqual([
			"ageMs", "aggregate", "lastError", "observedAt", "refreshedAt", "source", "stale",
		].sort());
		expect(data.aggregate.status).toBeUndefined();
		expect(data.status).toBeUndefined();
		expect(data.repos).toBeUndefined();
		expect(data.data).toBeUndefined();
		expect(JSON.stringify(data)).not.toContain("GIT_FILE_SENTINEL");
		expect(JSON.stringify(data).length).toBeLessThan(1_500);
	});

	it.each([
		["omitted view", undefined],
		["explicit full view", "full"],
	] as const)("preserves the legacy repeated git-status projection for %s", async (_label, view) => {
		const fixture = gitEnvelope(2);
		stubFetch(() => ({ body: fixture }));
		const params: Record<string, unknown> = { operation: "goal_git_status", goalId: "goal-git" };
		if (view !== undefined) params.view = view;

		const data = await read(params);

		expect(data.status).toHaveLength(fixture.status.length);
		expect(data.aggregate.status).toHaveLength(fixture.aggregate.status.length);
		expect(Object.keys(data.repos)).toEqual(["repo-1", "repo-2"]);
		expect(data.data.aggregate.status).toHaveLength(fixture.aggregate.status.length);
	});
});

describe("bobbit_read — adjacent bounded operations", () => {
	it("forwards goal_commits limit to the REST endpoint", async () => {
		const calls = stubFetch((url) => {
			const limit = Number(new URL(url).searchParams.get("limit") ?? 3);
			return { body: { commits: Array.from({ length: limit }, (_, index) => ({ sha: `sha-${index}`, subject: `Commit ${index}` })) } };
		});

		const data = await read({ operation: "goal_commits", goalId: "goal-commits", limit: 1 });

		expect(query(calls[0]).get("limit")).toBe("1");
		expect(data.commits).toHaveLength(1);
	});

	it("pages maintenance worktree inventory on canonical root items and preserves authoritative metadata", async () => {
		const counts = { total: 3, actionable: 2, troubleshooting: 1, byReason: { safe: 2, owned: 1 } };
		const calls = stubFetch(() => ({
			body: {
				items: Array.from({ length: 3 }, (_, index) => ({ id: `worktree-${index}`, path: `/wt/${index}`, classification: "archived-owned" })),
				counts,
				generatedAt: 1_786_100_000_000,
			},
		}));

		const data = await read({ operation: "maintenance_inspect", probe: "worktrees", limit: 1 });

		expect(calls[0].url).toContain("/api/maintenance/worktrees");
		expect(data.items).toEqual([{ id: "worktree-0", path: "/wt/0", classification: "archived-owned" }]);
		expect(data.counts).toEqual(counts);
		expect(data.generatedAt).toBe(1_786_100_000_000);
		expect(data.pagination).toMatchObject({ limit: 1, offset: 0, total: 3, hasMore: true, nextOffset: 1, itemKey: "items" });
	});

	it("pages archived-session worktrees on sole canonical items and removes nested aliases", async () => {
		const sentinel = "ARCHIVED_ITEM_SENTINEL_1";
		const items = Array.from({ length: 3 }, (_, index) => ({
			key: index === 0 ? sentinel : `archived-item-${index + 1}`,
			sessionId: index < 2 ? "archived-session-1" : "archived-session-2",
			path: `/archived/wt-${index + 1}`,
			status: "removable",
			disposition: "ready-to-clean",
		}));
		const calls = stubFetch(() => ({
			body: {
				items,
				sessions: [
					{ id: "archived-session-1", title: "First archived session", projectId: "project-1", worktrees: items.slice(0, 2) },
					{ id: "archived-session-2", title: "Second archived session", projectId: "project-1", worktrees: items.slice(2) },
				],
				counts: { archivedSessions: 2, totalItems: 3, removableWorktrees: 3 },
				groups: [{
					key: "ready-to-clean",
					label: "Ready to clean",
					description: "Safe archived worktrees",
					count: 3,
					hasMore: false,
					actionable: true,
					sampleKeys: items.map((item) => item.key),
					sampleItems: items,
				}],
				selectionPresets: [{ id: "all-removable", label: "All removable", count: 3, worktreeKeys: items.map((item) => item.key) }],
				generatedAt: 1_786_200_000_000,
			},
		}));

		const data = await read({ operation: "maintenance_inspect", probe: "archived_session_worktrees", limit: 1 });

		expect(calls[0].url).toContain("/api/maintenance/archived-session-worktrees");
		expect(data.items).toEqual([items[0]]);
		expect(data.worktrees).toBeUndefined();
		expect(data.pagination).toMatchObject({ limit: 1, offset: 0, total: 3, hasMore: true, nextOffset: 1, itemKey: "items" });
		expect(data.counts).toEqual({ archivedSessions: 2, totalItems: 3, removableWorktrees: 3 });
		expect(data.sessions).toEqual([
			{ id: "archived-session-1", title: "First archived session", projectId: "project-1" },
			{ id: "archived-session-2", title: "Second archived session", projectId: "project-1" },
		]);
		expect(data.groups[0]).toMatchObject({ key: "ready-to-clean", label: "Ready to clean", count: 3 });
		expect(data.groups[0].sampleKeys).toBeUndefined();
		expect(data.groups[0].sampleItems).toBeUndefined();
		expect(occurrences(data, sentinel), "a worktree key must occur only in the canonical root items page").toBe(1);
		expect(data.generatedAt).toBe(1_786_200_000_000);
	});
});
