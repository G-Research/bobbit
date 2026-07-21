import assert from "node:assert/strict";
import type { Stats } from "node:fs";
import { describe, it, vi } from "vitest";
import {
	shouldKeepDespiteOrphan,
	type OrphanPreservationOptions,
} from "../../src/server/agent/orphan-cleanup.ts";
import type { PersistedSession } from "../../src/server/agent/session-store.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const NOW = 2_000_000_000_000;

type PolicyFs = NonNullable<OrphanPreservationOptions["fsImpl"]>;

function makePs(overrides: Partial<PersistedSession> = {}): PersistedSession {
	return {
		id: "s-test",
		title: "test",
		cwd: "/project",
		createdAt: NOW,
		lastActivity: NOW,
		worktreePath: "/worktrees/live",
		agentSessionFile: "/transcripts/live.jsonl",
		...overrides,
	} as PersistedSession;
}

function policyFixture(options: {
	accessError?: unknown;
	statError?: unknown;
	mtimeMs?: number;
	now?: number;
} = {}) {
	const access = vi.fn(async () => {
		if (options.accessError !== undefined) throw options.accessError;
	});
	const stat = vi.fn(async () => {
		if (options.statError !== undefined) throw options.statError;
		return { mtimeMs: options.mtimeMs ?? NOW } as Stats;
	});
	const now = vi.fn(() => options.now ?? NOW);
	const fsImpl = { promises: { access, stat } } as unknown as PolicyFs;
	return { access, stat, now, opts: { fsImpl, clock: { now } } satisfies OrphanPreservationOptions };
}

describe("shouldKeepDespiteOrphan", () => {
	it("returns false without both persisted paths and performs no I/O", async () => {
		for (const ps of [
			makePs({ worktreePath: undefined }),
			makePs({ agentSessionFile: undefined }),
		]) {
			const fixture = policyFixture();

			assert.equal(await shouldKeepDespiteOrphan(ps, fixture.opts), false);
			assert.equal(fixture.access.mock.calls.length, 0);
			assert.equal(fixture.stat.mock.calls.length, 0);
			assert.equal(fixture.now.mock.calls.length, 0);
		}
	});

	it("returns false and short-circuits transcript stat when worktree access fails", async () => {
		const fixture = policyFixture({ accessError: Object.assign(new Error("missing"), { code: "ENOENT" }) });
		const ps = makePs();

		assert.equal(await shouldKeepDespiteOrphan(ps, fixture.opts), false);
		assert.deepEqual(fixture.access.mock.calls, [[ps.worktreePath]]);
		assert.equal(fixture.stat.mock.calls.length, 0);
		assert.equal(fixture.now.mock.calls.length, 0);
	});

	it("treats non-missing worktree access errors as unsafe", async () => {
		const fixture = policyFixture({ accessError: new Error("permission denied") });

		assert.equal(await shouldKeepDespiteOrphan(makePs(), fixture.opts), false);
		assert.equal(fixture.stat.mock.calls.length, 0);
	});

	it("returns false when transcript stat fails after a live worktree", async () => {
		const fixture = policyFixture({ statError: new Error("stat failed") });
		const ps = makePs();

		assert.equal(await shouldKeepDespiteOrphan(ps, fixture.opts), false);
		assert.deepEqual(fixture.access.mock.calls, [[ps.worktreePath]]);
		assert.deepEqual(fixture.stat.mock.calls, [[ps.agentSessionFile]]);
		assert.equal(fixture.now.mock.calls.length, 0);
	});

	it("keeps only transcripts whose age is strictly less than 24 hours", async () => {
		const cases = [
			{ age: DAY_MS - 1, expected: true },
			{ age: DAY_MS, expected: false },
			{ age: DAY_MS + 1, expected: false },
		];

		for (const { age, expected } of cases) {
			const fixture = policyFixture({ mtimeMs: NOW - age });
			assert.equal(await shouldKeepDespiteOrphan(makePs(), fixture.opts), expected, `age=${age}`);
			assert.equal(fixture.now.mock.calls.length, 1);
		}
	});

	it("remains pending without blocking unrelated microtasks while worktree I/O is deferred", async () => {
		let releaseAccess!: () => void;
		const access = vi.fn(() => new Promise<void>((resolve) => { releaseAccess = resolve; }));
		const stat = vi.fn(async () => ({ mtimeMs: NOW } as Stats));
		const fsImpl = { promises: { access, stat } } as unknown as PolicyFs;
		const result = shouldKeepDespiteOrphan(makePs(), { fsImpl, clock: { now: () => NOW } });
		let unrelatedProgress = false;

		await Promise.resolve().then(() => { unrelatedProgress = true; });

		assert.equal(unrelatedProgress, true);
		assert.equal(stat.mock.calls.length, 0, "transcript stat must wait for worktree access");
		releaseAccess();
		assert.equal(await result, true);
		assert.equal(stat.mock.calls.length, 1);
	});
});
