import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const apiSource = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8");

function section(start: string, end: string): string {
	const startIndex = apiSource.indexOf(start);
	assert.notEqual(startIndex, -1, `missing start marker: ${start}`);
	const endIndex = apiSource.indexOf(end, startIndex + start.length);
	assert.notEqual(endIndex, -1, `missing end marker: ${end}`);
	return apiSource.slice(startIndex, endIndex);
}

const refreshSessionsSource = section(
	"export async function refreshSessions(): Promise<void> {",
	"/** Check whether archived goals have been loaded",
);

const createGoalSource = section(
	"export async function createGoal(",
	"export async function updateGoal(",
);

const refreshAutoExpandLoop = refreshSessionsSource.match(
	/for \(const g of incoming\) \{\s*if \(!prevGoalIds\.has\(g\.id\) && !g\.parentGoalId && state\.gatewaySessions\.some\(\(s\) => s\.goalId === g\.id\)\) \{\s*expandSidebarTreeNode\(\{ kind: "goal", goalId: g\.id \}, \{ explicit: false \}\);\s*}\s*}/,
)?.[0];
assert.ok(refreshAutoExpandLoop, "refreshSessions auto-expand loop should keep the top-level/live-session guard");

const runRefreshAutoExpand = new Function(
	"incoming",
	"prevGoalIds",
	"state",
	"expandSidebarTreeNode",
	`${refreshAutoExpandLoop}`,
) as (
	incoming: Array<{ id: string; parentGoalId?: string }>,
	prevGoalIds: Set<string>,
	state: { gatewaySessions: Array<{ goalId?: string }> },
	expandSidebarTreeNode: (key: unknown, opts?: unknown) => void,
) => void;

const createGoalExpansionGuard = createGoalSource.match(
	/if \(!goal\.parentGoalId\) \{\s*expandSidebarTreeNode\(\{ kind: "goal", goalId: goal\.id \}\);\s*}/,
)?.[0];
assert.ok(createGoalExpansionGuard, "createGoal expansion should be guarded by !goal.parentGoalId");

const runCreateGoalExpansion = new Function(
	"goal",
	"expandSidebarTreeNode",
	`${createGoalExpansionGuard}`,
) as (
	goal: { id: string; parentGoalId?: string },
	expandSidebarTreeNode: (key: unknown, opts?: unknown) => void,
) => void;

describe("api sidebar expansion regression", () => {
	it("refreshSessions uses the unified sidebar tree API, not legacy expanded-goals persistence", () => {
		assert.match(apiSource, /import \{ expandSidebarTreeNode \} from "\.\/sidebar-tree-state\.js";/);
		assert.doesNotMatch(apiSource, /\bexpandedGoals\b/);
		assert.doesNotMatch(apiSource, /\bsaveExpandedGoals\b/);
	});

	it("refreshSessions auto-expands newly discovered top-level goals with live owning sessions as non-explicit", () => {
		const calls: Array<{ key: unknown; opts?: unknown }> = [];

		runRefreshAutoExpand(
			[{ id: "root" }],
			new Set(),
			{ gatewaySessions: [{ goalId: "root" }] },
			(key, opts) => calls.push({ key, opts }),
		);

		assert.deepEqual(calls, [
			{ key: { kind: "goal", goalId: "root" }, opts: { explicit: false } },
		]);
	});

	it("refreshSessions leaves a collapsed parent closed when a new child/sub-goal appears", () => {
		const calls: Array<{ key: unknown; opts?: unknown }> = [];

		runRefreshAutoExpand(
			[{ id: "child", parentGoalId: "collapsed-parent" }],
			new Set(["collapsed-parent"]),
			{ gatewaySessions: [{ goalId: "child" }] },
			(key, opts) => calls.push({ key, opts }),
		);

		assert.deepEqual(calls, []);
	});

	it("createGoal explicitly expands only newly created top-level goals", () => {
		const calls: Array<{ key: unknown; opts?: unknown }> = [];

		runCreateGoalExpansion({ id: "root" }, (key, opts) => calls.push({ key, opts }));
		runCreateGoalExpansion({ id: "child", parentGoalId: "collapsed-parent" }, (key, opts) => calls.push({ key, opts }));

		assert.deepEqual(calls, [
			{ key: { kind: "goal", goalId: "root" }, opts: undefined },
		]);
	});
});
