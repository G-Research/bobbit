// v2-e2e-vitest real-process owner: this benchmark boundary intentionally starts
// the production gateway and must remain outside the subprocess-free tier-1 lane.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";

import { ProjectRegistry } from "../../src/server/agent/project-registry.js";
import { SessionStore, type PersistedSession } from "../../src/server/agent/session-store.js";
import {
	GATEWAY_STARTUP_PROJECT_ID,
	GATEWAY_STARTUP_SEARCH_SENTINEL,
	buildGatewayStartupFixtureRecords,
	cleanupTrackedGateways,
	validateGatewayStartupSemanticProjection,
} from "../../scripts/benchmarks/gateway-startup.mjs";
import {
	cleanupBenchmarkRunRoot,
	createBenchmarkGatewayToken,
	createBenchmarkRunRoot,
	sanitizeBenchmarkError,
	spawnGateway,
	stopGateway,
	waitForGatewayReady,
} from "../../scripts/benchmarks/runtime.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const FIXTURE_TIME = 1_700_000_000_000;
const LIVE_ID = "benchmark-smoke-live";
const DIRECT_ARCHIVED_ID = "benchmark-smoke-archived-direct";
const CHILD_ARCHIVED_ID = "benchmark-smoke-archived-child";
const CONTROL_ARCHIVED_ID = "benchmark-smoke-archived-control";
const TOOL_CALL_ID = "benchmark-smoke-tool";
const COMPACTION_ID = "c_1700000000000_smoke1";

type BenchmarkPaths = Awaited<ReturnType<typeof createBenchmarkRunRoot>>;
type GatewayRuntime = ReturnType<typeof spawnGateway>;

function transcriptRows(projectRoot: string): string {
	const timestamp = new Date(FIXTURE_TIME).toISOString();
	const rows = [
		{ type: "session", version: 3, id: "benchmark-smoke-transcript", timestamp, cwd: projectRoot },
		{
			type: "message", id: "entry-smoke-user", parentId: null, timestamp,
			message: { id: "message-smoke-user", role: "user", content: [{ type: "text", text: "BENCHMARK_SMOKE_FIRST" }], timestamp: FIXTURE_TIME },
		},
		{
			type: "message", id: "entry-smoke-assistant", parentId: "entry-smoke-user", timestamp,
			message: {
				id: "message-smoke-assistant", role: "assistant", stopReason: "toolUse", timestamp: FIXTURE_TIME + 1,
				content: [
					{ type: "text", text: "Inspect the reduced benchmark fixture." },
					{ type: "toolCall", id: TOOL_CALL_ID, name: "read", arguments: { path: "fixture.txt" } },
				],
			},
		},
		{
			type: "message", id: "entry-smoke-result", parentId: "entry-smoke-assistant", timestamp,
			message: {
				id: "message-smoke-result", role: "toolResult", toolCallId: TOOL_CALL_ID, toolName: "read",
				is_error: true, content: [{ type: "text", text: "legacy benchmark error" }], timestamp: FIXTURE_TIME + 2,
			},
		},
		{
			type: "message", id: "entry-smoke-last", parentId: "entry-smoke-result", timestamp,
			message: { id: "message-smoke-last", role: "assistant", content: [{ type: "text", text: "BENCHMARK_SMOKE_LAST" }], timestamp: FIXTURE_TIME + 3 },
		},
	];
	return `${rows.map(row => JSON.stringify(row)).join("\n")}\n`;
}

async function seedReducedStartupStore(paths: BenchmarkPaths): Promise<{ stateDir: string; secretsDir: string; token: string }> {
	const stateDir = path.join(paths.gateway, "state");
	const configDir = path.join(paths.gateway, "config");
	const secretsDir = path.join(paths.root, "secrets");
	const sessionsDir = path.join(paths.agent, "sessions");
	await Promise.all([stateDir, configDir, secretsDir, sessionsDir].map(directory => mkdir(directory, { recursive: true })));
	await Promise.all([
		writeFile(path.join(stateDir, "setup-complete"), "benchmark smoke\n", "utf8"),
		writeFile(path.join(stateDir, "preferences.json"), JSON.stringify({
			customProviders: [{
				id: "mock",
				name: "mock",
				type: "manual",
				baseUrl: "http://127.0.0.1",
				models: [{ id: "mock-model", name: "mock-model" }],
			}],
			"default.sessionModel": "mock/mock-model",
			"default.sessionThinkingLevel": "medium",
		}, null, 2), "utf8"),
	]);
	const token = await createBenchmarkGatewayToken(secretsDir);

	new ProjectRegistry(stateDir).ensureHeadquartersProject(paths.gateway, { stateDir, configDir });
	const transcript = path.join(sessionsDir, `${LIVE_ID}.jsonl`);
	await writeFile(transcript, transcriptRows(paths.project), "utf8");

	const base: Omit<PersistedSession, "id" | "title" | "agentSessionFile"> = {
		cwd: paths.project,
		createdAt: FIXTURE_TIME,
		lastActivity: FIXTURE_TIME,
		projectId: GATEWAY_STARTUP_PROJECT_ID,
	};
	const sessions: PersistedSession[] = [
		{ ...base, id: LIVE_ID, title: "Gateway startup smoke live", agentSessionFile: transcript, wasStreaming: false, messageQueue: [] },
		{
			...base, id: DIRECT_ARCHIVED_ID, title: `${GATEWAY_STARTUP_SEARCH_SENTINEL} smoke`, agentSessionFile: "",
			archived: true, archivedAt: FIXTURE_TIME + 30, delegateOf: LIVE_ID,
		},
		{
			...base, id: CHILD_ARCHIVED_ID, title: "Gateway startup smoke archived child", agentSessionFile: "",
			archived: true, archivedAt: FIXTURE_TIME + 20, parentSessionId: DIRECT_ARCHIVED_ID,
		},
		{
			...base, id: CONTROL_ARCHIVED_ID, title: "Gateway startup smoke unrelated control", agentSessionFile: "",
			archived: true, archivedAt: FIXTURE_TIME + 10,
		},
	];
	const store = new SessionStore(stateDir);
	for (const session of sessions) store.put(session);
	await store.flushAsync();

	const sidecarDir = path.join(stateDir, "compaction-sidecar");
	await mkdir(sidecarDir, { recursive: true });
	await writeFile(path.join(sidecarDir, `${LIVE_ID}.jsonl`), `${JSON.stringify({
		schemaVersion: 1,
		id: COMPACTION_ID,
		trigger: "manual",
		tokensBefore: 4_000,
		tokensAfter: 1_000,
		durationMs: 25,
		startedAt: new Date(FIXTURE_TIME).toISOString(),
		endedAt: new Date(FIXTURE_TIME + 25).toISOString(),
		success: true,
		firstKeptEntryId: null,
	})}\n`, "utf8");
	return { stateDir, secretsDir, token };
}

async function readPublishedUrl(runtime: GatewayRuntime, stateDir: string): Promise<string> {
	const urlFile = path.join(stateDir, "gateway-url");
	for (let attempt = 0; attempt < 2_000; attempt += 1) {
		if (runtime.spawnError) throw runtime.spawnError;
		if (runtime.exited || runtime.child.exitCode !== null) {
			throw new Error(`Gateway exited before URL publication: ${runtime.stderr.text()}`);
		}
		try {
			const value = (await readFile(urlFile, "utf8")).trim();
			if (/^http:\/\/127\.0\.0\.1:\d+$/.test(value)) return `${value}/`;
		} catch { /* listener has not published its address */ }
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	throw new Error(`Gateway did not publish its URL: ${runtime.stderr.text()}`);
}

async function apiJson(baseUrl: string, token: string, route: string): Promise<{ response: Response; body: any }> {
	const response = await fetch(new URL(route, baseUrl), {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	const text = await response.text();
	return { response, body: text ? JSON.parse(text) : null };
}

async function apiRequest(
	baseUrl: string,
	route: string,
	{ token, method = "GET", body }: { token?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
	return fetch(new URL(route, baseUrl), {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(10_000),
	});
}

async function waitForSearchSentinel(baseUrl: string, token: string): Promise<any> {
	const route = `api/search?q=${encodeURIComponent(GATEWAY_STARTUP_SEARCH_SENTINEL)}&type=sessions&includeArchived=true&projectId=${GATEWAY_STARTUP_PROJECT_ID}`;
	for (let attempt = 0; attempt < 400; attempt += 1) {
		const result = await apiJson(baseUrl, token, route);
		if (result.response.ok && result.body?.results?.some((row: any) => (row.sessionId ?? row.id) === DIRECT_ARCHIVED_ID)) {
			return result.body;
		}
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("Search index did not expose the reduced fixture sentinel");
}

async function getMessagesOverProductionSocket(baseUrl: string, token: string): Promise<any[]> {
	const target = new URL(`ws/${LIVE_ID}`, baseUrl);
	target.protocol = "ws:";
	const socket = new WebSocket(target);
	const frames: any[] = [];
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WebSocket auth timed out")), 10_000);
			socket.on("open", () => socket.send(JSON.stringify({ type: "auth", token })));
			socket.on("error", reject);
			socket.on("message", raw => {
				const frame = JSON.parse(raw.toString());
				frames.push(frame);
				if (frame.type === "auth_ok") {
					clearTimeout(timer);
					resolve();
				}
			});
		});
		const cursor = frames.length;
		socket.send(JSON.stringify({ type: "get_messages" }));
		const frame = await new Promise<any>((resolve, reject) => {
			const existing = frames.slice(cursor).find(candidate => candidate.type === "messages");
			if (existing) return resolve(existing);
			const timer = setTimeout(() => reject(new Error("get_messages timed out")), 10_000);
			const listener = (raw: WebSocket.RawData) => {
				const candidate = JSON.parse(raw.toString());
				if (candidate.type !== "messages") return;
				clearTimeout(timer);
				socket.off("message", listener);
				resolve(candidate);
			};
			socket.on("message", listener);
		});
		return Array.isArray(frame.data) ? frame.data : frame.data?.messages ?? [];
	} finally {
		socket.close();
	}
}

function semanticHash(records: ReturnType<typeof buildGatewayStartupFixtureRecords>): string {
	const projection = {
		fixtureVersion: records.manifest.fixtureVersion,
		caseName: records.manifest.caseName,
		projectId: records.manifest.projectId,
		goalId: records.manifest.goalId,
		liveIds: records.manifest.liveIds,
		archivedIds: records.manifest.archivedIds,
		reachableArchivedIds: records.manifest.reachableArchivedIds,
		controls: records.manifest.controls,
		sessions: records.sessions.map((session: PersistedSession) => ({
			id: session.id,
			title: session.title,
			archived: session.archived === true,
			delegateOf: session.delegateOf ?? null,
			parentSessionId: session.parentSessionId ?? null,
			teamLeadSessionId: session.teamLeadSessionId ?? null,
			teamGoalId: session.teamGoalId ?? null,
			goalId: session.goalId ?? null,
		})),
	};
	return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

describe("Bobbit journey benchmark production boundaries", () => {
	it("sanitizes forced post-spawn child failures and still closes the owned process", async () => {
		const paths = await createBenchmarkRunRoot({ repoRoot: REPO_ROOT });
		const token = "c9".repeat(32);
		const metadataSecret = "MetaSignal";
		const runtime = spawnGateway({
			command: process.execPath,
			args: ["-e", `console.log(${JSON.stringify(`token=${token}`)}); console.error(${JSON.stringify(`Authorization: Bearer ${token}`)}); setTimeout(() => process.exit(1), 20);`],
			cwd: REPO_ROOT,
			env: { ...process.env, NODE_ENV: "test" },
			redactions: [token, metadataSecret],
		});
		let sanitized: any;
		try {
			try {
				await waitForGatewayReady({ runtime, baseUrl: "http://127.0.0.1:1/", token, timeoutMs: 5_000 });
			} catch (error) {
				(error as any).name = `Error${metadataSecret}`;
				(error as any).benchmarkDiagnostic.sample = {
					order: 0, phase: "measured", cycle: 0, case: `child-${metadataSecret}`, caseOrder: 0,
				};
				(error as any).benchmarkDiagnostic.childExit.signal = metadataSecret;
				sanitized = sanitizeBenchmarkError(
					new AggregateError([error], `forced post-spawn failure ${token}`, { cause: error }),
					{ runtime, redactions: [token, metadataSecret] },
				);
			}
			expect(sanitized).toBeInstanceOf(AggregateError);
			const projection = JSON.stringify({
				message: sanitized.message,
				children: sanitized.errors.map((error: any) => ({
					message: error.message,
					diagnostic: error.benchmarkDiagnostic,
				})),
				cause: sanitized.cause?.message,
			});
			expect(projection).not.toContain(token);
			expect(projection).not.toContain(metadataSecret);
			expect(sanitized.errors[0].name).toBe("Error");
			expect(sanitized.errors[0].benchmarkDiagnostic.sample.case).toBe("child-[redacted]");
			expect(sanitized.errors[0].benchmarkDiagnostic.childExit.signal).toBeNull();
			expect(projection).toContain("[redacted]");
		} finally {
			await stopGateway(runtime).catch(() => {});
			await cleanupBenchmarkRunRoot(paths);
		}
		expect(runtime.closed).toBe(true);
		expect(existsSync(paths.root)).toBe(false);
	});

	it("restores a reduced deterministic store and validates readiness, APIs, search, relationships, and WS snapshot parity", async () => {
		const paths = await createBenchmarkRunRoot({ repoRoot: REPO_ROOT });
		let runtime: GatewayRuntime | undefined;
		let baseUrl: string | undefined;
		let token: string | undefined;
		try {
			const seeded = await seedReducedStartupStore(paths);
			token = seeded.token;
			runtime = spawnGateway({
				args: [
					"--import", "tsx", path.join(REPO_ROOT, "src", "server", "cli.ts"),
					"--host", "127.0.0.1", "--port", "0", "--cwd", paths.project,
					"--agent-cli", path.join(REPO_ROOT, "tests", "e2e", "mock-agent.mjs"),
					"--no-ui", "--no-tls", "--auth",
				],
				cwd: REPO_ROOT,
				redactions: [token],
				env: {
					...process.env,
					NODE_ENV: "test",
					BOBBIT_DIR: paths.gateway,
					BOBBIT_SECRETS_DIR: seeded.secretsDir,
					BOBBIT_AGENT_DIR: paths.agent,
					BOBBIT_NO_OPEN: "1",
					BOBBIT_SKIP_MCP: "1",
					BOBBIT_SKIP_WORKTREE_POOL: "1",
					BOBBIT_SKIP_TITLE_GEN: "1",
					BOBBIT_SKIP_AIGW_DISCOVERY: "1",
					BOBBIT_SKIP_NPM_CI: "1",
					BOBBIT_TEST_NO_EXTERNAL: "1",
					BOBBIT_TEST_NO_REMOTE: "1",
					BOBBIT_E2E_TMP_ROOT: paths.gateway,
				},
			});
			baseUrl = await readPublishedUrl(runtime, seeded.stateDir);

			const readinessStatuses: number[] = [];
			let injectStartingResponse = true;
			const readiness = await waitForGatewayReady({
				runtime,
				baseUrl,
				token,
				fetchImpl: async (...args: Parameters<typeof fetch>) => {
					if (injectStartingResponse) {
						injectStartingResponse = false;
						readinessStatuses.push(503);
						return new Response(JSON.stringify({ status: "starting" }), { status: 503 });
					}
					const response = await fetch(...args);
					readinessStatuses.push(response.status);
					return response;
				},
			});
			expect(readiness.status).toBe(200);
			expect(readinessStatuses[0]).toBe(503);
			expect(readinessStatuses.at(-1)).toBe(200);

			const projects = await apiJson(baseUrl, token, "api/projects");
			expect(projects.response.status).toBe(200);
			expect((Array.isArray(projects.body) ? projects.body : projects.body.projects).map((project: any) => project.id))
				.toEqual([GATEWAY_STARTUP_PROJECT_ID]);

			const listed = await apiJson(baseUrl, token, `api/sessions?include=archived&projectId=${GATEWAY_STARTUP_PROJECT_ID}`);
			expect(listed.response.status).toBe(200);
			expect(listed.body.sessions.map((session: any) => session.id).sort()).toEqual([
				LIVE_ID, DIRECT_ARCHIVED_ID, CHILD_ARCHIVED_ID, CONTROL_ARCHIVED_ID,
			].sort());
			expect(listed.body.archivedDelegates.map((session: any) => session.id)).toEqual([
				DIRECT_ARCHIVED_ID,
				CHILD_ARCHIVED_ID,
			]);
			expect(listed.body.archivedDelegates.map((session: any) => session.id)).not.toContain(CONTROL_ARCHIVED_ID);

			const restored = await apiJson(baseUrl, token, `api/sessions/${LIVE_ID}`);
			expect(restored.response.status).toBe(200);
			expect(restored.body).toMatchObject({ id: LIVE_ID, status: "idle" });
			expect(restored.body.restoreError).toBeFalsy();

			const search = await waitForSearchSentinel(baseUrl, token);
			expect(search.results.map((row: any) => row.sessionId ?? row.id)).toContain(DIRECT_ARCHIVED_ID);

			const messages = await getMessagesOverProductionSocket(baseUrl, token);
			const rawIds = messages.map(message => message.id).filter(Boolean);
			expect(new Set(rawIds).size).toBe(rawIds.length);
			const orders = messages.map(message => message._order);
			expect(orders.every((order, index) => Number.isFinite(order) && (index === 0 || order > orders[index - 1]))).toBe(true);
			expect(messages.find(message => message.id === "message-smoke-user")?.content?.[0]?.text).toBe("BENCHMARK_SMOKE_FIRST");
			expect(messages.find(message => message.id === "message-smoke-last")?.content?.[0]?.text).toBe("BENCHMARK_SMOKE_LAST");
			const toolResult = messages.find(message => message.toolCallId === TOOL_CALL_ID);
			expect(toolResult).toMatchObject({ role: "toolResult", toolName: "read", isError: true });
			const compaction = messages.find(message => message.id === COMPACTION_ID);
			expect(compaction?.content?.[0]).toMatchObject({ type: "toolCall", name: "__compaction_summary" });
			expect(messages.filter(message => message.id === COMPACTION_ID)).toHaveLength(1);

			const abuseSecretPath = path.join(paths.root, "mock-agent-abuse-secret.txt");
			const abuseSecret = "BENCHMARK_AUTH_ABUSE_SECRET";
			await writeFile(abuseSecretPath, abuseSecret, "utf8");
			const unauthenticatedRequests = [
				apiRequest(baseUrl, "api/sessions"),
				apiRequest(baseUrl, "api/sessions", {
					method: "POST",
					body: { cwd: paths.project, projectId: GATEWAY_STARTUP_PROJECT_ID, worktree: false },
				}),
				apiRequest(baseUrl, `api/sessions/${LIVE_ID}/prompt`, {
					method: "POST",
					body: { message: `use read tool ${abuseSecretPath}` },
				}),
				apiRequest(baseUrl, "api/shutdown", { method: "POST" }),
			];
			const rejected = await Promise.all(unauthenticatedRequests);
			expect(rejected.map(response => response.status)).toEqual([401, 401, 401, 401]);
			const rejectedBodies = await Promise.all(rejected.map(response => response.text()));
			expect(rejectedBodies.join("\n")).not.toContain(abuseSecret);
			expect(await readFile(abuseSecretPath, "utf8")).toBe(abuseSecret);
			expect(await readFile(path.join(paths.agent, "sessions", `${LIVE_ID}.jsonl`), "utf8"))
				.not.toContain(abuseSecret);
			expect(runtime.exited).toBe(false);

			const authenticatedCreate = await apiRequest(baseUrl, "api/sessions", {
				token,
				method: "POST",
				body: { cwd: paths.gateway, projectId: GATEWAY_STARTUP_PROJECT_ID, roleId: "assistant", worktree: false },
			});
			const createResult = await authenticatedCreate.json();
			expect(authenticatedCreate.status).not.toBe(401);
			expect(createResult.error).toMatch(/Role .* not found/);
			const authenticatedList = await apiRequest(baseUrl, "api/sessions", { token });
			expect(authenticatedList.status).toBe(200);
		} finally {
			if (runtime) await stopGateway(runtime, { baseUrl, token }).catch(() => {});
			await cleanupBenchmarkRunRoot(paths);
		}
	}, 90_000);

	it("rejects an archived relationship mutation instead of accepting a matching session count", () => {
		const records = buildGatewayStartupFixtureRecords("100-sessions", {
			projectRoot: path.join(REPO_ROOT, "fixture-project"),
			transcriptRoot: path.join(REPO_ROOT, "fixture-agent"),
		});
		expect(semanticHash(records)).toBe(records.manifest.semanticSha256);
		expect(validateGatewayStartupSemanticProjection(records.manifest, records.sessions).semanticSha256)
			.toBe(records.manifest.semanticSha256);

		const mutated = records.sessions.map((session: PersistedSession) => ({ ...session }));
		const direct = mutated.find((session: PersistedSession) => session.id === records.manifest.reachableArchivedIds[0]);
		expect(direct).toBeTruthy();
		direct!.delegateOf = "silently-mutated-parent";
		expect(() => validateGatewayStartupSemanticProjection(records.manifest, mutated))
			.toThrow(/relationship semantics changed/i);
	});

	it("attempts every retained process after a cleanup failure, propagates it, and then removes only its owned root", async () => {
		const paths = await createBenchmarkRunRoot({ repoRoot: REPO_ROOT });
		const first = { runtime: { closed: false }, baseUrl: "http://127.0.0.1:1/" } as any;
		const second = { runtime: { closed: false }, baseUrl: "http://127.0.0.1:2/" } as any;
		const active = new Set<any>([first, second]);
		const attempts: string[] = [];
		try {
			await expect(cleanupTrackedGateways(active, async (_runtime: any, options: any) => {
				attempts.push(options.baseUrl);
				if (options.baseUrl === first.baseUrl) throw new Error("forced benchmark cleanup failure");
				return { graceful: false, forced: true, closed: true };
			})).rejects.toThrow(/cleanup failed for 1 tracked process/i);
			expect(attempts).toEqual([first.baseUrl, second.baseUrl]);
			expect(active.has(first)).toBe(true);
			expect(active.has(second)).toBe(false);

			await cleanupTrackedGateways(active, async () => ({ graceful: false, forced: true, closed: true }));
			expect(active.size).toBe(0);
			expect(existsSync(paths.root)).toBe(true);
		} finally {
			await cleanupBenchmarkRunRoot(paths);
		}
		expect(existsSync(paths.root)).toBe(false);
	});
});
