/**
 * Reproducing test for the Windows `bash_bg` "does not survive a dev-harness
 * restart" bug (goal: Fix Windows bg-process restart). It pins the TWO fixable
 * seams identified in the issue-analysis gate and MUST fail on current code:
 *
 *   (A) Harness tree-kill (primary). The dev restart harness kills the gateway
 *       on Windows with `taskkill /pid <pid> /T /F`; the `/T` walks the gateway's
 *       child tree and euthanizes the detached bg-process wrappers. The fix
 *       extracts the Windows kill-command construction into a pure, exported
 *       helper `windowsGatewayKillArgs(pid)` in `src/server/harness-kill.ts`
 *       that returns the taskkill argv WITHOUT `/T` (single-pid, force only).
 *
 *   (B) POSIX wrapper publishes a non-Windows PID (secondary). The wrapper
 *       pidfile line writes bare `$$` — the MSYS-internal pid, NOT a Windows
 *       pid. The fix makes it publish `$(cat /proc/$$/winpid 2>/dev/null || echo $$)`
 *       so the pidfile carries a Windows-usable pid (with a $$ fallback off
 *       Windows, where $$ already IS the real pid → no behaviour change).
 *
 *   (C) Host restore never reconciles `processPid` from the pidfile (secondary).
 *       The docker path reconciles processPid from the (nonce-checked) pidfile on
 *       restore; the host path does not, so liveness/kill target a possibly-wrong
 *       pid. The fix reconciles the host processPid from the pidfile, analogous
 *       to the docker path.
 *
 * Every assertion message carries the unique marker WIN_BG_RESTART_BUG so the
 * gate's error_pattern reliably matches. The test uses the injected-dependency
 * harness from `tests/bg-process-manager.test.ts` (fake SpawnFn, noop tailers,
 * isolated temp BgProcessStore, faked BgEnv) so NO real OS process is touched.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChildProcess } from "node:child_process";

import {
	BgProcessManager,
	buildHostWrapper,
	type SpawnFn,
	type BgEnv,
	type BgPaths,
	type TailerFactory,
	type Tailer,
} from "../src/server/agent/bg-process-manager.ts";
import { BgProcessStore, type PersistedBgProcess } from "../src/server/agent/bg-process-store.ts";

const MARKER = "WIN_BG_RESTART_BUG";

// --- (C) host-restore harness (injected deps, no real OS process) ---------

function makeRestoreHarness(opts: { alivePid: number }) {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bgwin-"));
	const store = new BgProcessStore(stateDir);
	// restore() never spawns; this stub exists only to satisfy the constructor.
	const spawn: SpawnFn = () => { throw new Error("spawn must not be called during restore"); };
	// Noop tailers so no real fs polling / DockerTailer is exercised.
	const tailerFactory: TailerFactory = () => {
		const mk = (): Tailer => ({ start() {}, stop() {} });
		return { out: mk(), err: mk() };
	};
	const env: BgEnv = {
		// Liveness passes ONLY for the reconciled (pidfile) pid, so the host path
		// must reconcile processPid before re-attaching.
		isHostPidAlive: (pid: number) => pid === opts.alivePid,
		killHostTree: () => { /* noop */ },
		dockerCli: () => ({ code: -1, stdout: "" }),
	};
	const mgr = new BgProcessManager(() => undefined, spawn, () => store, tailerFactory, env);
	return { mgr, store, stateDir };
}

function hostRecord(stateDir: string, sessionId: string, id: string, processPid: number, nonce: string): PersistedBgProcess {
	const dir = path.join(stateDir, "bg-processes", sessionId);
	return {
		sessionId, id, name: id, command: "sleep 30",
		hostPid: processPid, processPid, nonce,
		cwd: stateDir, containerId: undefined,
		status: "running", exitCode: null, terminalReason: null,
		killRequested: false, killRequestedAt: undefined,
		startTime: Date.now(), endTime: null,
		logFile: path.join(dir, `${id}.log`),
		statusSnapshot: path.join(dir, `${id}.status`),
		outSpool: path.join(dir, `${id}.out.spool`),
		errSpool: path.join(dir, `${id}.err.spool`),
		pidFile: path.join(dir, `${id}.pid`),
		nonce, inContainer: false,
		outOffset: 0, errOffset: 0,
	};
}

// --- Tests ----------------------------------------------------------------

describe("Windows bash_bg survives a dev-harness restart", () => {
	it("(A) harness Windows gateway-kill helper kills only the gateway pid (no /T tree-kill)", async () => {
		let mod: { windowsGatewayKillArgs?: (pid: number) => string[] } | undefined;
		try {
			mod = await import("../src/server/harness-kill.ts");
		} catch {
			// Module does not exist yet on current code.
		}

		assert.ok(
			mod && typeof mod.windowsGatewayKillArgs === "function",
			`${MARKER}: expected src/server/harness-kill.ts to export windowsGatewayKillArgs(pid: number): string[]`,
		);

		const argv = mod!.windowsGatewayKillArgs!(1234);
		assert.ok(
			Array.isArray(argv),
			`${MARKER}: windowsGatewayKillArgs must return a string[] argv`,
		);
		assert.ok(
			argv.includes("taskkill") && argv.includes("/pid") && argv.includes("1234") && argv.includes("/F"),
			`${MARKER}: kill argv must target the gateway pid with force — got ${JSON.stringify(argv)}`,
		);
		assert.ok(
			!argv.includes("/T"),
			`${MARKER}: kill argv must NOT include /T (tree-kill euthanizes detached bg children) — got ${JSON.stringify(argv)}`,
		);
	});

	it("(B) POSIX host wrapper publishes a Windows-usable winpid, not bare $$", () => {
		const fakePaths: BgPaths = {
			logFile: "/tmp/bg/bg-1.log",
			statusSnapshot: "/tmp/bg/bg-1.status",
			outSpool: "/tmp/bg/bg-1.out.spool",
			errSpool: "/tmp/bg/bg-1.err.spool",
			pidFile: "/tmp/bg/bg-1.pid",
			nonce: "nonce-abc",
			inContainer: false,
		};
		const wrapper = buildHostWrapper("echo hi", fakePaths);
		assert.ok(
			wrapper.includes("/proc/$$/winpid"),
			`${MARKER}: host wrapper pidfile line must publish a Windows-usable pid via /proc/$$/winpid (with a $$ fallback), not bare $$ — wrapper was:\n${wrapper}`,
		);
	});

	it("(C) host restore reconciles processPid from the pidfile (nonce-checked) and persists it", async () => {
		const OLD = 11111; // stale spawn-time child.pid (persisted)
		const NEW = 22222; // Windows-usable pid published in the pidfile
		const h = makeRestoreHarness({ alivePid: NEW });
		const SESSION = `s-${randomUUID()}`;
		const ID = "bg-1";
		const nonce = randomUUID();

		// Persist a HOST running record carrying the STALE processPid.
		h.store.put(hostRecord(h.stateDir, SESSION, ID, OLD, nonce));

		// Write the pidfile with the NEW (Windows-usable) pid + MATCHING nonce.
		const dir = path.join(h.stateDir, "bg-processes", SESSION);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, `${ID}.pid`), `${NEW}\n${nonce}\n`);
		// No status file → process is treated as still running.

		try {
			await h.mgr.restoreSession(SESSION);

			const info = h.mgr.list(SESSION).find((p) => p.id === ID);
			assert.ok(info, `${MARKER}: restored bg record should be present in memory`);
			assert.equal(
				info!.pid, NEW,
				`${MARKER}: host restore must reconcile processPid from the pidfile (expected ${NEW}, got ${info!.pid}) so liveness/kill target the signalable pid`,
			);
			assert.notEqual(
				info!.status, "unrecoverable",
				`${MARKER}: a still-running host process must re-attach, not resolve to unrecoverable`,
			);

			const persisted = h.store.get(SESSION, ID);
			assert.equal(
				persisted?.processPid, NEW,
				`${MARKER}: reconciled processPid must be persisted to the store (expected ${NEW}, got ${persisted?.processPid})`,
			);
		} finally {
			h.mgr.cleanup(SESSION);
		}
	});
});
