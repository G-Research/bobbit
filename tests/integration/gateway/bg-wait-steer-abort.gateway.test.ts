/**
 * E2E test for steer-interruptible `bash_bg wait`.
 *
 * Starts a long-running bg process via REST, begins a long-polling wait,
 * then triggers BgProcessManager.abortAllWaits() (the same call SessionManager
 * makes from its live-steer code path). The wait must return `aborted: true`
 * within 500ms and the bg process must keep running.
 */
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { test, expect } from "./_helpers/e2e/in-process-harness.js";
import { readE2EToken, nonGitCwd, injectDefaultProjectId } from "./_helpers/e2e/e2e-setup.js";
import { pollUntil } from "../../support/helpers/e2e/cleanup.js";
import { readAuthorSidecar } from "../../../src/server/agent/author-sidecar.js";
import { reliableMockCore } from "./_helpers/reliable-turn-barriers.js";

interface FakeBgChild extends EventEmitter {
	pid: number;
	unref(): void;
	kill(): boolean;
}

function installFakeBgRuntime(manager: any) {
	const original = {
		spawnFn: manager.spawnFn,
		tailerFactory: manager.tailerFactory,
		env: manager.env,
	};
	let nextPid = 10_000;
	let latestTailer: any;

	manager.spawnFn = () => {
		const child = new EventEmitter() as FakeBgChild;
		child.pid = nextPid++;
		child.unref = () => {};
		child.kill = () => true;
		return child;
	};
	manager.tailerFactory = (spec: any) => {
		latestTailer = spec;
		const tailer = { start() {}, stop() {} };
		return { out: tailer, err: tailer };
	};
	manager.env = {
		isHostPidAlive: () => false,
		killHostTree: () => {},
		dockerCli: () => ({ code: -1, stdout: "" }),
	};

	return {
		emitStdout(lines: string[]): void {
			latestTailer.onChunk("stdout", `${lines.join("\n")}\n`, Buffer.byteLength(`${lines.join("\n")}\n`));
		},
		exit(sessionId: string, processId: string, code = 0): void {
			const process = manager.processes.get(sessionId)?.get(processId);
			if (!process) throw new Error(`missing fake background process ${processId}`);
			writeFileSync(process.paths.statusSnapshot, `${code}\n`, "utf-8");
			process.child.emit("exit", code, null);
		},
		restore(): void {
			manager.spawnFn = original.spawnFn;
			manager.tailerFactory = original.tailerFactory;
			manager.env = original.env;
		},
	};
}

async function adminFetch(baseURL: string, path: string, opts: RequestInit = {}) {
	const method = (opts.method || "GET").toUpperCase();
	let body = opts.body;
	if (method === "POST" && /^\/api\/(sessions|goals|staff)(\?|$|\/)/.test(path)) {
		body = await injectDefaultProjectId(body) as BodyInit;
	}
	return fetch(`${baseURL}${path}`, {
		...opts,
		body,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${readE2EToken()}`,
			...(opts.headers as Record<string, string> || {}),
		},
	});
}

test.describe("bash_bg wait — steer abort", () => {
	let fakeRuntime: ReturnType<typeof installFakeBgRuntime>;

	test.beforeAll(async ({ gateway }) => {
		fakeRuntime = installFakeBgRuntime(gateway.bgProcessManager);
	});

	test.afterAll(async () => {
		fakeRuntime.restore();
	});
	test("logs endpoint defaults to the last 15 lines", async ({ gateway }) => {
		let sessionId: string | undefined;
		try {
			const res = await adminFetch(gateway.baseURL, "/api/sessions", {
				method: "POST",
				body: JSON.stringify({ cwd: nonGitCwd() }),
			});
			expect(res.status).toBe(201);
			({ id: sessionId } = await res.json());

			const command = "fake log producer";
			const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
				method: "POST",
				body: JSON.stringify({ command, name: "log tail" }),
			});
			expect(bgRes.status).toBe(201);
			const bg = await bgRes.json();
			const allLines = Array.from({ length: 20 }, (_, i) => `line-${i + 1}`);
			fakeRuntime.emitStdout(allLines);
			fakeRuntime.exit(sessionId!, bg.id);

			const waitRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=5`);
			expect(waitRes.status).toBe(200);

			const logsRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes/${bg.id}/logs`);
			expect(logsRes.status).toBe(200);
			const logs = await logsRes.json();
			const expected = Array.from({ length: 15 }, (_, i) => `line-${i + 6}`);
			expect(logs.log.map((entry: { text: string }) => entry.text)).toEqual(expected);
			expect(logs.stdout).toEqual(expected);
		} finally {
			if (sessionId) await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
		}
	});

	test("abortAllWaits resolves long-poll wait with aborted:true and leaves process running", async ({ gateway }) => {
		// Create session
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id: sessionId } = await res.json();

		// Spawn a long-running bg process
		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: "fake long-running command", name: "sleeper" }),
		});
		expect(bgRes.status).toBe(201);
		const bg = await bgRes.json();

		// Start a wait with a generous timeout (60s)
		const waitStart = Date.now();
		const waitPromise = adminFetch(
			gateway.baseURL,
			`/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=60`,
		).then(async (r) => ({ status: r.status, body: await r.json() }));

		// Wait until the long poll has registered its AbortController.
		await pollUntil(
			() => ((gateway.bgProcessManager as any).waits as Map<string, Set<unknown>>).get(sessionId)?.size ? true : false,
			{ timeoutMs: 5_000, intervalMs: 25, label: "bg wait registered" },
		);

		// Trigger abort via the bg manager (same call the live-steer code path uses).
		gateway.bgProcessManager.abortAllWaits(sessionId);

		const result = await waitPromise;
		const elapsed = Date.now() - waitStart;

		expect(result.status).toBe(200);
		expect(result.body.aborted).toBe(true);
		expect(result.body.timedOut).toBe(false);
		expect(result.body.info.status).toBe("running");
		expect(elapsed).toBeLessThan(1500);

		// Process should still be running.
		const listRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
		const list = await listRes.json();
		const proc = list.processes.find((p: any) => p.id === bg.id);
		expect(proc).toBeTruthy();
		expect(proc.status).toBe("running");

		// Cleanup: kill the process then the session.
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes/${bg.id}`, { method: "DELETE" });
		await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });
	});

	for (const source of ["task-notification", "auto-nudge"] as const) {
		test(`automatic ${source} live steer aborts a registered wait and settles its minted occurrence once`, async ({ gateway }) => {
			let sessionId: string | undefined;
			let bgId: string | undefined;
			let core: ReturnType<typeof reliableMockCore> | undefined;
			try {
				const sessionRes = await adminFetch(gateway.baseURL, "/api/sessions", {
					method: "POST",
					body: JSON.stringify({ cwd: nonGitCwd() }),
				});
				expect(sessionRes.status).toBe(201);
				({ id: sessionId } = await sessionRes.json());
				if (!sessionId) throw new Error("automatic-steer test session was not created");

				const live = gateway.sessionManager.getSession(sessionId) as any;
				expect(live, "live session is required for the real delivery path").toBeTruthy();
				core = reliableMockCore(gateway, sessionId);
				// Hold the real mock RPC immediately after its receipt so the assertion
				// observes the server's dispatch→echo seam, not a synthetic ledger.
				core.armBarrier("steer:1:received");
				core.armBarrier("steer:1:before-user-start");
				live.status = "streaming";

				const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
					method: "POST",
					body: JSON.stringify({ command: "fake long-running automatic-steer command", name: "automatic steer sleeper" }),
				});
				expect(bgRes.status).toBe(201);
				({ id: bgId } = await bgRes.json());

				const waitPromise = adminFetch(
					gateway.baseURL,
					`/api/sessions/${sessionId}/bg-processes/${bgId}/wait?timeout=60`,
				).then(async response => ({ status: response.status, body: await response.json() }));
				await pollUntil(
					() => ((gateway.bgProcessManager as any).waits as Map<string, Set<unknown>>).get(sessionId!)?.size ? true : false,
					{ timeoutMs: 5_000, intervalMs: 25, label: "automatic-steer bg wait registered" },
				);

				const text = `AUTOMATIC_${source.toUpperCase().replace(/-/g, "_")}_WAIT_INTERRUPT`;
				const interruptStartedAt = Date.now();
				const delivery = gateway.sessionManager.deliverLiveSteer(sessionId, text, { source });
				await core.waitForBarrier("steer:1:received");
				const waitResult = await waitPromise;
				const interruptElapsedMs = Date.now() - interruptStartedAt;

				expect(waitResult.status).toBe(200);
				expect(waitResult.body).toMatchObject({ aborted: true, timedOut: false, info: { status: "running" } });
				expect(interruptElapsedMs, "the dispatched automatic steer must promptly interrupt bash_bg wait").toBeLessThan(500);

				const attempt = live.inFlightSteerTexts?.find((row: any) => row.text === text);
				expect(attempt, "automatic no-intent callers must mint a reliable occurrence before RPC dispatch").toMatchObject({
					intentId: expect.any(String),
					attemptId: expect.stringMatching(/^attempt:/),
					state: "dispatching",
					targetTurn: "continuation",
					source,
				});
				expect(live.inFlightSteerTexts?.some((row: any) => row.text === text && !row.intentId),
					"the automatic steer must never create a legacy/no-intent in-flight record").toBe(false);

				const running = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`);
				const runningProcess = (await running.json()).processes.find((process: any) => process.id === bgId);
				expect(runningProcess?.status).toBe("running");

				core.releaseBarrier("steer:1:received");
				await delivery;
				await core.waitForBarrier("steer:1:before-user-start");
				core.releaseBarrier("steer:1:before-user-start");
				await pollUntil(
					() => !live.inFlightSteerTexts?.some((row: any) => row.intentId === attempt.intentId),
					{ timeoutMs: 5_000, intervalMs: 25, label: "automatic steer Pi echo settlement" },
				);

				const commandDeliveries = (core as any).commandJournal.filter((entry: any) =>
					entry.kind === "steer" && entry.text === `[System]: ${text}`,
				);
				expect(commandDeliveries, "one minted occurrence must produce one Pi steer RPC").toHaveLength(1);
				const echoDeliveries = live.eventBuffer.getAll().filter((entry: any) =>
					entry.event?.type === "message_end"
					&& (entry.event?.deliveryIntentId === attempt.intentId
						|| entry.event?.message?.deliveryIntentId === attempt.intentId),
				);
				expect(echoDeliveries, "the exact minted occurrence must have one correlated Pi user echo").toHaveLength(1);
				const settled = readAuthorSidecar(sessionId).filter(binding => binding.intentId === attempt.intentId);
				expect(settled).toEqual([
					expect.objectContaining({ attemptId: attempt.attemptId, settlement: expect.objectContaining({ outcome: "echoed" }) }),
				]);
				expect(live.inFlightSteerTexts?.some((row: any) => row.text === text),
					"settlement removes the reliable carrier rather than leaving a recovery transcript projection").toBe(false);
				expect(live.inFlightSteerTexts?.some((row: any) => !row.intentId),
					"the settled automatic occurrence leaves no legacy/no-intent recovery ledger row").toBe(false);
			} finally {
				core?.releaseAllBarriers();
				if (sessionId && bgId) {
					await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes/${bgId}`, { method: "DELETE" }).catch(() => {});
				}
				if (sessionId) await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
			}
		});
	}

	test("session termination releases hanging wait handlers", async ({ gateway }) => {
		const res = await adminFetch(gateway.baseURL, "/api/sessions", {
			method: "POST",
			body: JSON.stringify({ cwd: nonGitCwd() }),
		});
		expect(res.status).toBe(201);
		const { id: sessionId } = await res.json();

		const bgRes = await adminFetch(gateway.baseURL, `/api/sessions/${sessionId}/bg-processes`, {
			method: "POST",
			body: JSON.stringify({ command: "fake long-running command", name: "sleeper2" }),
		});
		expect(bgRes.status).toBe(201);
		const bg = await bgRes.json();

		const waitPromise = adminFetch(
			gateway.baseURL,
			`/api/sessions/${sessionId}/bg-processes/${bg.id}/wait?timeout=60`,
		);

		// Wait until the long poll has registered its AbortController.
		await pollUntil(
			() => ((gateway.bgProcessManager as any).waits as Map<string, Set<unknown>>).get(sessionId)?.size ? true : false,
			{ timeoutMs: 5_000, intervalMs: 25, label: "bg wait registered" },
		);

		// Terminate — must abort the in-flight wait so the handler resolves. Measure
		// from the registered wait/DELETE boundary, not from earlier setup work or
		// DELETE cleanup, so this pins the abort path without accepting hangs.
		const abortStart = Date.now();
		const deletePromise = adminFetch(gateway.baseURL, `/api/sessions/${sessionId}`, { method: "DELETE" });

		const response = await waitPromise;
		const elapsed = Date.now() - abortStart;
		await deletePromise;

		// Either 200 with aborted:true (abort fired first) or 404 (session gone) or
		// 200 with the process having exited via SIGTERM — any of these is OK as
		// long as the handler returned well before the 60s timeout.
		expect([200, 404]).toContain(response.status);
		expect(elapsed).toBeLessThan(5000);
	});
});
