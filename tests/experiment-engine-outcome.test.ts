// Live outcome-parsing regression guard — pins engine.parseRawOutcome /
// createGoalReader against the REAL gateway REST shapes (src/server/server.ts),
// closing the gap the code-quality review found: the API E2E injected
// pre-normalized RawOutcome stubs via ctx.goalReader and never exercised the
// actual parser, so the wrong field names (totalCostUsd/tokensIn, gate id/verdict,
// GET /api/goals/:goalId) shipped undetected.
//
// Authoritative shapes:
//   GET /api/goals/:id/cost  → { inputTokens, outputTokens, cacheReadTokens,
//                                cacheWriteTokens, totalCost, cacheHitRate }
//   GET /api/goals/:id/gates → { gates: [ { gateId, status, name, ... } ] }
//   GET /api/goals/:id/tasks → { tasks: [ { state, ... } ] }
//   GET /api/goals           → { generation, goals: [ PersistedGoal incl. metadata ] }
//   (there is NO GET /api/goals/:goalId single-goal endpoint)
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";

import {
	parseRawOutcome,
	isSettledFromRaw,
	completionBarFromRaw,
	createGoalReader,
	loadCreds,
} from "../market-packs/experiment-runner/lib/engine.mjs";

// ── parseRawOutcome against the EXACT REST shapes ─────────────────────────────
describe("parseRawOutcome: real gateway REST shapes", () => {
	it("maps the real cost shape (totalCost/inputTokens/outputTokens/cacheHitRate)", () => {
		const raw = parseRawOutcome({
			cost: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 50, cacheWriteTokens: 10, totalCost: 0.42, cacheHitRate: 0.25 },
		});
		assert.equal(raw.costUsd, 0.42);
		assert.equal(raw.tokensIn, 1200);
		assert.equal(raw.tokensOut, 340);
		assert.equal(raw.cacheHitRate, 0.25);
		// The cost endpoint carries no wall-clock; without meta it stays absent.
		assert.equal(raw.wallClockMs, undefined);
	});

	it("keeps tolerant fallbacks for legacy/unit-stub cost names", () => {
		const raw = parseRawOutcome({ cost: { totalCostUsd: 0.9, tokensIn: 5, tokensOut: 7, wallClockMs: 1234 } });
		assert.equal(raw.costUsd, 0.9);
		assert.equal(raw.tokensIn, 5);
		assert.equal(raw.tokensOut, 7);
		assert.equal(raw.wallClockMs, 1234);
	});

	it("reads gates keyed by gateId/status (mixed → incomplete, not settled)", () => {
		const raw = parseRawOutcome({
			gates: { gates: [{ gateId: "design-doc", status: "passed", name: "Design" }, { gateId: "review", status: "pending" }] },
		});
		assert.deepEqual(raw.gateVerdicts, { "design-doc": "passed", review: "pending" });
		assert.equal(isSettledFromRaw(raw), false);
		assert.equal(completionBarFromRaw(raw), "incomplete");
	});

	it("treats an all-passed gate set as settled + passed", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "passed" }] } });
		assert.deepEqual(raw.gateVerdicts, { build: "passed", review: "passed" });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");
	});

	it("maps a human-bypassed gate to passed (accepted pass)", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "bypassed" }] } });
		assert.deepEqual(raw.gateVerdicts, { build: "passed", review: "passed" });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");
	});

	it("maps a failed gate to failed completion bar", () => {
		const raw = parseRawOutcome({ gates: { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "failed" }] } });
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "failed");
	});

	it("reads task counts from the real { tasks: [{ state }] } shape", () => {
		const raw = parseRawOutcome({ tasks: { tasks: [{ state: "complete" }, { state: "todo" }, { state: "complete" }] } });
		assert.deepEqual(raw.taskCounts, { complete: 2, total: 3 });
	});

	it("derives wallClockMs + userMetrics from a PersistedGoal meta object", () => {
		const meta = { id: "g1", createdAt: 1000, updatedAt: 4000, metadata: { experiment: { userMetrics: { objective: 7 } } } };
		const raw = parseRawOutcome({ meta });
		assert.equal(raw.wallClockMs, 3000);
		assert.deepEqual(raw.userMetrics, { objective: 7 });
	});

	it("prefers archivedAt over updatedAt for wall-clock and leaves it absent when not determinable", () => {
		assert.equal(parseRawOutcome({ meta: { createdAt: 1000, archivedAt: 2500, updatedAt: 9999 } }).wallClockMs, 1500);
		assert.equal(parseRawOutcome({ meta: { id: "g", metadata: {} } }).wallClockMs, undefined);
	});

	it("never throws on empty / malformed input", () => {
		assert.deepEqual(parseRawOutcome(), {});
		assert.deepEqual(parseRawOutcome({ cost: null, gates: 5, tasks: "x", meta: undefined }), {});
	});
});

// ── createGoalReader against an injected fetch returning the REAL shapes ──────
describe("createGoalReader: assembles a RawOutcome from live REST responses", () => {
	const GOAL_ID = "child-goal-7";
	const goalsList = {
		generation: 3,
		goals: [
			{ id: "other", createdAt: 1, updatedAt: 2, metadata: {} },
			{ id: GOAL_ID, createdAt: 10_000, updatedAt: 25_000, metadata: { experiment: { userMetrics: { objective: 42 } } } },
		],
	};
	const responses: Record<string, unknown> = {
		[`/api/goals/${GOAL_ID}/cost`]: { inputTokens: 800, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost: 0.31, cacheHitRate: 0.5 },
		[`/api/goals/${GOAL_ID}/gates`]: { gates: [{ gateId: "design-doc", status: "passed" }, { gateId: "review", status: "bypassed" }] },
		[`/api/goals/${GOAL_ID}/tasks`]: { tasks: [{ state: "complete" }, { state: "complete" }, { state: "todo" }] },
		"/api/goals": goalsList,
	};

	function makeFetch(seen: string[]) {
		return async (url: string) => {
			const path = url.replace("https://gw", "");
			seen.push(path);
			const body = responses[path];
			if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => body };
		};
	}

	it("readOutcome() assembles a correct RawOutcome through the real parser", async () => {
		const seen: string[] = [];
		const reader = createGoalReader({ fetchImpl: makeFetch(seen) as any, creds: { gatewayUrl: "https://gw", token: "tok" } });
		const raw = await reader.readOutcome(GOAL_ID);

		assert.equal(raw.costUsd, 0.31);
		assert.equal(raw.tokensIn, 800);
		assert.equal(raw.tokensOut, 200);
		assert.equal(raw.cacheHitRate, 0.5);
		assert.deepEqual(raw.gateVerdicts, { "design-doc": "passed", review: "passed" });
		assert.deepEqual(raw.taskCounts, { complete: 2, total: 3 });
		assert.deepEqual(raw.userMetrics, { objective: 42 });
		assert.equal(raw.wallClockMs, 15_000); // updatedAt − createdAt from the goals list
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");

		// meta MUST hit the list endpoint, NOT a (non-existent) single-goal endpoint.
		assert.ok(seen.includes("/api/goals"));
		assert.ok(!seen.some((p) => p === `/api/goals/${GOAL_ID}`));
	});

	it("meta() resolves the goal by id from the goals list", async () => {
		const reader = createGoalReader({ fetchImpl: makeFetch([]) as any, creds: { gatewayUrl: "https://gw" } });
		const meta = await reader.meta(GOAL_ID);
		assert.equal(meta.id, GOAL_ID);
		assert.deepEqual(meta.metadata.experiment.userMetrics, { objective: 42 });
		const missing = await reader.meta("nope");
		assert.equal(missing, null);
	});

	it("never throws when the gateway is unreachable (returns an empty RawOutcome)", async () => {
		const reader = createGoalReader({ fetchImpl: (async () => { throw new Error("network"); }) as any, creds: { gatewayUrl: "https://gw" } });
		const raw = await reader.readOutcome(GOAL_ID);
		assert.deepEqual(raw, {});
	});
});

// ── PRODUCTION transport + cred discovery (no injected fetch/creds stubs) ──────
// The code-quality review found the live reader unusable in production: the pack
// route worker runs with cwd = the SESSION WORKTREE and an EMPTY env, so (a) the
// relative `.bobbit/state/token` read found nothing, and (b) global fetch rejected
// the gateway's SELF-SIGNED cert. These tests pin the REAL paths: cred discovery
// from a parent dir, and a TLS-tolerant GET against an actual self-signed HTTPS
// server with NO io.fetchImpl injection.
describe("loadCreds: discovers .bobbit/state from a PARENT of the start dir", () => {
	const tmpRoots: string[] = [];
	after(() => { for (const d of tmpRoots) rmSync(d, { recursive: true, force: true }); });

	it("walks up to find creds when the state dir sits above cwd (worktree/subdir case)", () => {
		const root = mkdtempSync(join(tmpdir(), "exp-creds-"));
		tmpRoots.push(root);
		const stateDir = join(root, ".bobbit", "state");
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(join(stateDir, "gateway-url"), "https://gw.example:3001\n");
		writeFileSync(join(stateDir, "token"), "secret-token\n");
		// A worktree-like nested subdir whose creds live several levels UP.
		const sub = join(root, "worktrees", "goal-x", "deep", "sub");
		mkdirSync(sub, { recursive: true });

		const creds = loadCreds(sub);
		assert.equal(creds.gatewayUrl, "https://gw.example:3001");
		assert.equal(creds.token, "secret-token");
	});

	it("returns empty (null-safe) creds when no state dir exists anywhere above", () => {
		const root = mkdtempSync(join(tmpdir(), "exp-nocreds-"));
		tmpRoots.push(root);
		const sub = join(root, "a", "b");
		mkdirSync(sub, { recursive: true });
		const creds = loadCreds(sub);
		assert.equal(creds.gatewayUrl, undefined);
		assert.equal(creds.token, undefined);
	});
});

describe("createGoalReader: real self-signed HTTPS gateway (no injected fetch)", () => {
	const GOAL_ID = "child-goal-tls";
	let server: https.Server | undefined;
	let baseUrl = "";
	const certDir = mkdtempSync(join(tmpdir(), "exp-tls-"));
	const seenPaths: string[] = [];

	const goalsList = {
		generation: 1,
		goals: [
			{ id: GOAL_ID, createdAt: 1_000, updatedAt: 6_000, metadata: { experiment: { userMetrics: { objective: 99 } } } },
		],
	};
	const bodyFor = (path: string): unknown => {
		if (path === `/api/goals/${GOAL_ID}/cost`) return { inputTokens: 700, outputTokens: 100, totalCost: 0.22, cacheHitRate: 0.4 };
		if (path === `/api/goals/${GOAL_ID}/gates`) return { gates: [{ gateId: "build", status: "passed" }, { gateId: "review", status: "passed" }] };
		if (path === `/api/goals/${GOAL_ID}/tasks`) return { tasks: [{ state: "complete" }, { state: "todo" }] };
		if (path === "/api/goals") return goalsList;
		return undefined;
	};

	after(() => {
		server?.close();
		rmSync(certDir, { recursive: true, force: true });
	});

	it("readOutcome() works through node:https against a self-signed cert + Bearer auth", async () => {
		// Generate a throwaway self-signed cert at test time (mirrors the gateway).
		execFileSync("openssl", [
			"req", "-x509", "-newkey", "rsa:2048",
			"-keyout", join(certDir, "key.pem"),
			"-out", join(certDir, "cert.pem"),
			"-days", "1", "-nodes", "-subj", "/CN=localhost",
		], { stdio: "ignore" });

		const { readFileSync } = await import("node:fs");
		let authSeen = "";
		server = https.createServer(
			{ cert: readFileSync(join(certDir, "cert.pem")), key: readFileSync(join(certDir, "key.pem")) },
			(req, res) => {
				authSeen = String(req.headers["authorization"] || "");
				const path = (req.url || "").split("?")[0];
				seenPaths.push(path);
				const body = bodyFor(path);
				if (body === undefined) { res.statusCode = 404; res.end("{}"); return; }
				res.setHeader("content-type", "application/json");
				res.end(JSON.stringify(body));
			},
		);
		await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		baseUrl = `https://127.0.0.1:${port}`;

		// NO io.fetchImpl — this exercises the SHIPPED node:https transport with
		// rejectUnauthorized:false. creds injection is allowed (bypasses discovery).
		const reader = createGoalReader({ creds: { gatewayUrl: baseUrl, token: "tok-123" } });
		const raw = await reader.readOutcome(GOAL_ID);

		assert.equal(raw.costUsd, 0.22);
		assert.equal(raw.tokensIn, 700);
		assert.equal(raw.tokensOut, 100);
		assert.deepEqual(raw.gateVerdicts, { build: "passed", review: "passed" });
		assert.deepEqual(raw.taskCounts, { complete: 1, total: 2 });
		assert.deepEqual(raw.userMetrics, { objective: 99 });
		assert.equal(raw.wallClockMs, 5_000);
		assert.equal(isSettledFromRaw(raw), true);
		assert.equal(completionBarFromRaw(raw), "passed");
		// The Bearer token from creds reached the server, and meta resolved via the list.
		assert.equal(authSeen, "Bearer tok-123");
		assert.ok(seenPaths.includes("/api/goals"));
	});
});
