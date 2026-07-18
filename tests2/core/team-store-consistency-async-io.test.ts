import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { RECOVERY_IO_CONCURRENCY } from "../../src/server/agent/bounded-async-work.ts";
import {
	discoverAgentsForGoal,
	pickCanonicalTeamLeadJsonl,
	scanSlugDirForJsonlsAt,
	slugDirNameForCwd,
	type CandidateJsonl,
} from "../../src/server/agent/team-store-consistency.ts";
import {
	TeamRecoveryFsFake,
	basenamePosix,
	dirnamePosix,
	joinPosix,
	microtaskTurns,
	sessionHeader,
} from "./team-recovery-test-fake.ts";

const SESSIONS_ROOT = "/agent/sessions";
const TEAM_CWD = "/worktrees/goal-alpha";
const TEAM_SLUG_DIR = joinPosix(SESSIONS_ROOT, slugDirNameForCwd(TEAM_CWD));

function addCandidate(
	fs: TeamRecoveryFsFake,
	name: string,
	header: string,
	options: { size?: number; mtime?: Date; isFile?: boolean } = {},
): string {
	const path = joinPosix(TEAM_SLUG_DIR, name);
	fs.file(path, header, options);
	return path;
}

function agentSlug(teamLeadWorktreePath: string, role: string, id: string): { cwd: string; slug: string; dir: string; role: string } {
	const parent = dirnamePosix(teamLeadWorktreePath);
	const name = basenamePosix(teamLeadWorktreePath);
	const cwd = `${parent}/goal-${name}-${role}-${id}`;
	const slug = slugDirNameForCwd(cwd);
	return { cwd, slug, dir: joinPosix(SESSIONS_ROOT, slug), role };
}

async function releaseDeferredWaves(fs: TeamRecoveryFsFake, waves: number): Promise<void> {
	for (let wave = 0; wave < waves; wave++) {
		assert.ok(fs.pending.length > 0, `wave ${wave + 1} must have deferred work`);
		assert.ok(fs.pending.length <= RECOVERY_IO_CONCURRENCY);
		fs.release();
		if (wave + 1 < waves) await fs.waitForPending();
	}
}

describe("async team transcript scan", () => {
	it("preserves exact candidate descriptors, listing order, timestamp fallback, and bounded headers", async () => {
		const fs = new TeamRecoveryFsFake();
		const explicitMtime = new Date("2024-05-01T01:02:03.000Z");
		const fallbackMtime = new Date("2024-06-02T03:04:05.000Z");
		const closeMtime = new Date("2024-07-03T04:05:06.000Z");
		const explicit = addCandidate(fs, "first.jsonl", sessionHeader(TEAM_CWD, "agent-first", "2024-04-01T00:00:00.000Z"), { size: 111, mtime: explicitMtime });
		const fallback = addCandidate(fs, "second.jsonl", sessionHeader(TEAM_CWD, "agent-second"), { size: 222, mtime: fallbackMtime });
		const closeFailure = addCandidate(fs, "close-error.jsonl", sessionHeader(TEAM_CWD, "agent-close"), { size: 333, mtime: closeMtime });
		fs.fail("close", closeFailure);
		fs.dir(TEAM_SLUG_DIR, ["notes.txt", "first.jsonl", "second.jsonl", "close-error.jsonl"]);

		const candidates = await scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, fs, joinPosix);

		assert.deepEqual(candidates, [
			{
				jsonlPath: explicit,
				size: 111,
				mtime: explicitMtime.getTime(),
				agentSessionId: "agent-first",
				agentStartedAtIso: "2024-04-01T00:00:00.000Z",
			},
			{
				jsonlPath: fallback,
				size: 222,
				mtime: fallbackMtime.getTime(),
				agentSessionId: "agent-second",
				agentStartedAtIso: fallbackMtime.toISOString(),
			},
			{
				jsonlPath: closeFailure,
				size: 333,
				mtime: closeMtime.getTime(),
				agentSessionId: "agent-close",
				agentStartedAtIso: closeMtime.toISOString(),
			},
		]);
		assert.equal(fs.count("stat"), 3);
		assert.equal(fs.count("open"), 3);
		assert.equal(fs.count("close"), 3);
		assert.deepEqual(
			fs.calls.filter((call) => call.operation === "read").map((call) => ({ length: call.length, position: call.position })),
			Array.from({ length: 3 }, () => ({ length: 2048, position: 0 })),
		);
		assert.equal(fs.count("readFile"), 0, "headers must never use whole-file reads");
	});

	it("isolates invalid records and every per-item I/O failure without losing successful siblings", async () => {
		const fs = new TeamRecoveryFsFake();
		const names = [
			"good-before.jsonl",
			"wrong-type.jsonl",
			"wrong-cwd.jsonl",
			"missing-id.jsonl",
			"number-id.jsonl",
			"malformed.jsonl",
			"empty.jsonl",
			"truncated.jsonl",
			"stat-error.jsonl",
			"open-error.jsonl",
			"read-error.jsonl",
			"good-after.jsonl",
		];
		fs.dir(TEAM_SLUG_DIR, names);
		for (const name of names) addCandidate(fs, name, sessionHeader(TEAM_CWD, name));
		fs.file(joinPosix(TEAM_SLUG_DIR, "wrong-type.jsonl"), `${JSON.stringify({ type: "message", cwd: TEAM_CWD, id: "x" })}\n`);
		fs.file(joinPosix(TEAM_SLUG_DIR, "wrong-cwd.jsonl"), sessionHeader("/another/cwd", "x"));
		fs.file(joinPosix(TEAM_SLUG_DIR, "missing-id.jsonl"), `${JSON.stringify({ type: "session", cwd: TEAM_CWD })}\n`);
		fs.file(joinPosix(TEAM_SLUG_DIR, "number-id.jsonl"), `${JSON.stringify({ type: "session", cwd: TEAM_CWD, id: 42 })}\n`);
		fs.file(joinPosix(TEAM_SLUG_DIR, "malformed.jsonl"), "{ definitely not json\n");
		fs.file(joinPosix(TEAM_SLUG_DIR, "empty.jsonl"), "");
		fs.file(joinPosix(TEAM_SLUG_DIR, "truncated.jsonl"), `{"type":"session","cwd":"${"x".repeat(2200)}`);
		fs.fail("stat", joinPosix(TEAM_SLUG_DIR, "stat-error.jsonl"));
		fs.fail("open", joinPosix(TEAM_SLUG_DIR, "open-error.jsonl"));
		fs.fail("read", joinPosix(TEAM_SLUG_DIR, "read-error.jsonl"));

		const candidates = await scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, fs, joinPosix);

		assert.deepEqual(candidates.map((candidate) => candidate.agentSessionId), ["good-before.jsonl", "good-after.jsonl"]);
		assert.equal(fs.calls.some((call) => call.operation === "read" && call.length! > 2048), false);
	});

	it("returns an empty set for missing or unreadable slug directories", async () => {
		const missing = new TeamRecoveryFsFake();
		assert.deepEqual(await scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, missing, joinPosix), []);

		const unreadable = new TeamRecoveryFsFake().dir(TEAM_SLUG_DIR, []).fail("readdir", TEAM_SLUG_DIR);
		assert.deepEqual(await scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, unreadable, joinPosix), []);
	});

	it("completes a wide scan with at most the documented recovery I/O cap", async () => {
		assert.ok(RECOVERY_IO_CONCURRENCY > 0);
		const fs = new TeamRecoveryFsFake().defer("stat");
		const names = Array.from({ length: RECOVERY_IO_CONCURRENCY * 4 + 1 }, (_, index) => `${String(index).padStart(2, "0")}.jsonl`);
		fs.dir(TEAM_SLUG_DIR, names);
		for (const name of names) addCandidate(fs, name, sessionHeader(TEAM_CWD, name));

		const scan = scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, fs, joinPosix);
		await fs.waitForPending(RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.pending.length, RECOVERY_IO_CONCURRENCY, "only one capped worker set may start");
		await releaseDeferredWaves(fs, Math.ceil(names.length / RECOVERY_IO_CONCURRENCY));

		const candidates = await scan;
		assert.deepEqual(candidates.map((candidate) => candidate.agentSessionId), names);
		assert.ok(fs.maxActive <= RECOVERY_IO_CONCURRENCY, `observed ${fs.maxActive} concurrent operations`);
	});

	it("yields to unrelated scheduler work while deferred I/O remains pending", async () => {
		const fs = new TeamRecoveryFsFake().dir(TEAM_SLUG_DIR, []).defer("readdir", TEAM_SLUG_DIR);
		let settled = false;
		const scan = scanSlugDirForJsonlsAt(SESSIONS_ROOT, TEAM_CWD, fs, joinPosix).then((result) => {
			settled = true;
			return result;
		});
		let schedulerProgress = false;
		queueMicrotask(() => { schedulerProgress = true; });

		await microtaskTurns();
		assert.equal(schedulerProgress, true);
		assert.equal(settled, false);
		assert.equal(fs.pending.length, 1);

		fs.release("readdir", TEAM_SLUG_DIR);
		assert.deepEqual(await scan, []);
	});
});

describe("async team agent discovery", () => {
	it("accepts valid role/id slugs, rejects malformed names, omits failed/empty dirs, and preserves root order", async () => {
		const teamLead = "/worktrees/goal-alpha";
		const qa = agentSlug(teamLead, "qa-tester", "a1b2c3d4");
		const coder = agentSlug(teamLead, "coder", "deadbeef");
		const empty = agentSlug(teamLead, "reviewer", "1234abcd");
		const unreadable = agentSlug(teamLead, "code-reviewer", "abcdef12");
		const fs = new TeamRecoveryFsFake().dir(SESSIONS_ROOT, [
			qa.slug,
			"--unrelated--",
			`${coder.slug.slice(0, -10)}DEADBEEF--`,
			`${coder.slug.slice(0, -10)}abc--`,
			coder.slug,
			empty.slug,
			unreadable.slug,
		]);
		fs.dir(qa.dir, ["qa.jsonl"]).file(joinPosix(qa.dir, "qa.jsonl"), sessionHeader(qa.cwd, "qa-agent"));
		fs.dir(coder.dir, ["coder.jsonl"]).file(joinPosix(coder.dir, "coder.jsonl"), sessionHeader(coder.cwd, "coder-agent"));
		fs.dir(empty.dir, []);
		fs.dir(unreadable.dir, []).fail("readdir", unreadable.dir);

		const discovered = await discoverAgentsForGoal(SESSIONS_ROOT, teamLead, fs, joinPosix, dirnamePosix, basenamePosix);

		assert.deepEqual(discovered.map((agent) => ({ path: agent.agentWorktreePath, role: agent.role, id: agent.agentId, sessions: agent.candidates.map((c) => c.agentSessionId) })), [
			{ path: qa.cwd, role: "qa-tester", id: "a1b2c3d4", sessions: ["qa-agent"] },
			{ path: coder.cwd, role: "coder", id: "deadbeef", sessions: ["coder-agent"] },
		]);
	});

	it("scans matched agent directories sequentially so nested work never multiplies the cap", async () => {
		const teamLead = "/worktrees/goal-alpha";
		const first = agentSlug(teamLead, "coder", "11111111");
		const second = agentSlug(teamLead, "reviewer", "22222222");
		const perAgentCount = RECOVERY_IO_CONCURRENCY * 2 + 1;
		const names = Array.from({ length: perAgentCount }, (_, index) => `${index}.jsonl`);
		const fs = new TeamRecoveryFsFake().dir(SESSIONS_ROOT, [first.slug, second.slug]).dir(first.dir, names).dir(second.dir, names).defer("stat");
		for (const agent of [first, second]) {
			for (const name of names) fs.file(joinPosix(agent.dir, name), sessionHeader(agent.cwd, `${agent.role}-${name}`));
		}

		const discovery = discoverAgentsForGoal(SESSIONS_ROOT, teamLead, fs, joinPosix, dirnamePosix, basenamePosix);
		await fs.waitForPending(RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.count("readdir", first.dir), 1);
		assert.equal(fs.count("readdir", second.dir), 0, "second nested scan must not start beside the first");
		await releaseDeferredWaves(fs, Math.ceil(perAgentCount / RECOVERY_IO_CONCURRENCY));
		await fs.waitForPending(RECOVERY_IO_CONCURRENCY);
		assert.equal(fs.count("readdir", second.dir), 1);
		await releaseDeferredWaves(fs, Math.ceil(perAgentCount / RECOVERY_IO_CONCURRENCY));

		const discovered = await discovery;
		assert.deepEqual(discovered.map((agent) => agent.agentWorktreePath), [first.cwd, second.cwd]);
		assert.deepEqual(discovered.map((agent) => agent.candidates.length), [perAgentCount, perAgentCount]);
		assert.ok(fs.maxActive <= RECOVERY_IO_CONCURRENCY, `nested scans observed ${fs.maxActive} active operations`);
	});

	it("returns an empty set when the sessions root is unreadable", async () => {
		const fs = new TeamRecoveryFsFake().dir(SESSIONS_ROOT, []).fail("readdir", SESSIONS_ROOT);
		assert.deepEqual(await discoverAgentsForGoal(SESSIONS_ROOT, "/worktrees/goal-alpha", fs, joinPosix, dirnamePosix, basenamePosix), []);
	});
});

describe("canonical team transcript parity", () => {
	it("selects mtime first, size second, and preserves listing order on a full tie", () => {
		const candidate = (jsonlPath: string, mtime: number, size: number): CandidateJsonl => ({
			jsonlPath,
			mtime,
			size,
			agentSessionId: jsonlPath,
			agentStartedAtIso: "2024-01-01T00:00:00.000Z",
		});
		const listing = [
			candidate("older-large", 100, 9999),
			candidate("newer-small", 200, 1),
			candidate("newer-large-first", 200, 20),
			candidate("newer-large-tied-later", 200, 20),
		];

		assert.equal(pickCanonicalTeamLeadJsonl(listing)?.jsonlPath, "newer-large-first");
		assert.deepEqual(listing.map((item) => item.jsonlPath), ["older-large", "newer-small", "newer-large-first", "newer-large-tied-later"], "selection must not mutate input order");
		assert.equal(pickCanonicalTeamLeadJsonl([]), null);
	});
});
