/**
 * Persistence + re-attach coverage for BgProcessManager — design §13 unit cases.
 *
 * No real OS processes: the SpawnFn returns a fake EventEmitter child, the
 * TailerFactory is faked (the test drives chunks through `spec.onChunk`), the
 * BgEnv (host liveness / host kill / docker CLI) is faked, and durable
 * log/status/spool/pid files are real files in an isolated temp state dir —
 * never the real `.bobbit/`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	BgProcessManager,
	buildHostWrapper,
	buildDockerWrapper,
	PollTailer,
	type BgEnv,
	type SpawnFn,
	type TailerFactory,
	type TailerSpec,
	type Tailer,
} from "../src/server/agent/bg-process-manager.ts";
import { BgProcessStore } from "../src/server/agent/bg-process-store.ts";
import { runBgRunner } from "../src/server/agent/bg-runner.ts";

const MAX_LOG_BYTES = 512 * 1024;

// ── fakes ─────────────────────────────────────────────────────────────────

function makeFakeChild(): any {
	const c = new EventEmitter() as any;
	c.pid = 10000 + Math.floor(Math.random() * 50000);
	c.stdout = Object.assign(new EventEmitter(), { destroy() {} });
	c.stderr = Object.assign(new EventEmitter(), { destroy() {} });
	c.kill = () => true;
	c.unref = () => {};
	return c;
}

interface Harness {
	stateDir: string;
	store: () => BgProcessStore;
	mgr: BgProcessManager;
	specs: TailerSpec[];
	sent: any[];
	dockerCalls: string[][];
	lastChild: () => any;
	reload: (env?: Partial<BgEnv>) => Harness;
}

function makeHarness(opts?: { env?: Partial<BgEnv>; stateDir?: string }): Harness {
	const stateDir = opts?.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-bg-"));
	let store = new BgProcessStore(stateDir);
	const specs: TailerSpec[] = [];
	const tailerFactory: TailerFactory = (spec) => {
		specs.push(spec);
		const mk = (): Tailer => ({ start() {}, stop() {} });
		return { out: mk(), err: mk() };
	};
	const dockerCalls: string[][] = [];
	const env: BgEnv = {
		isHostPidAlive: opts?.env?.isHostPidAlive ?? (() => false),
		killHostTree: opts?.env?.killHostTree ?? (() => {}),
		dockerCli: opts?.env?.dockerCli ?? ((argv) => { dockerCalls.push(argv); return { code: 0, stdout: "" }; }),
	};
	let lastChild: any = null;
	const spawnFn: SpawnFn = () => { lastChild = makeFakeChild(); return lastChild; };
	const sent: any[] = [];
	const fakeClient = { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) };
	const clients = new Set<any>([fakeClient]);

	const mgr = new BgProcessManager(
		() => clients as any,
		spawnFn,
		() => store,
		tailerFactory,
		env,
	);

	const h: Harness = {
		stateDir,
		store: () => store,
		mgr,
		specs,
		sent,
		dockerCalls,
		lastChild: () => lastChild,
		reload: (envOverride?: Partial<BgEnv>) => makeHarness({ env: envOverride, stateDir }),
	};
	return h;
}

function freshSession() { return `s-${randomUUID()}`; }

// ── tests ───────────────────────────────────────────────────────────────────

describe("BgProcessManager — wrapper builders (POSIX only)", () => {
	const paths = {
		logFile: "/state/bg-3.log", statusSnapshot: "/state/bg-3.status",
		outSpool: "/state/bg-3.out.spool", errSpool: "/state/bg-3.err.spool",
		pidFile: "/state/bg-3.pid", nonce: "NONCE123", inContainer: false,
	};

	it("buildHostWrapper emits subshell, trimmer, status write — no cmd / %errorlevel%", () => {
		const w = buildHostWrapper("echo hi", paths);
		assert.match(w, /printf '%s\\n%s\\n' "\$\$" 'NONCE123'/);
		assert.match(w, /while kill -0 "\$\$"/);
		assert.match(w, /tail -c 524288 "\$f" > "\$f\.trim"/);
		assert.match(w, /cat "\$f\.trim" > "\$f"/);
		assert.match(w, /\( echo hi \) >> '\/state\/bg-3\.out\.spool' 2>> '\/state\/bg-3\.err\.spool'/);
		assert.match(w, /code=\$\?/);
		assert.match(w, /kill "\$trimmer"/);
		assert.match(w, /printf '%s\\n' "\$code" > '\/state\/bg-3\.status'/);
		assert.match(w, /exit "\$code"/);
		assert.doesNotMatch(w, /%errorlevel%/i);
		assert.doesNotMatch(w, /\bmv\b/);
		assert.doesNotMatch(w, /cmd(\.exe)?/i);
	});

	it("Fix 1: emits a final synchronous spool trim BEFORE the status write", () => {
		const w = buildHostWrapper("echo hi", paths);
		// A `for f in <out> <err>; do tail -c <cap> ... done` trim line must exist.
		assert.match(w, /for f in '\/state\/bg-3\.out\.spool' '\/state\/bg-3\.err\.spool'; do tail -c 524288 "\$f" > "\$f\.trim"/);
		// And it must come AFTER `code=$?`/trimmer-kill and BEFORE the status write.
		const trimIdx = w.indexOf("for f in '/state/bg-3.out.spool' '/state/bg-3.err.spool'; do tail -c 524288");
		const statusIdx = w.indexOf("printf '%s\\n' \"$code\" > '/state/bg-3.status'");
		const codeIdx = w.indexOf("code=$?");
		assert.ok(trimIdx > codeIdx && trimIdx >= 0, "final trim after code=$?");
		assert.ok(statusIdx > trimIdx, "status write comes after the final trim");
		// Same-inode copytruncate, never mv (pinned for the final trim too).
		assert.doesNotMatch(w, /\bmv\b/);
	});

	it("Fix 5: shell-quotes paths/nonce so an embedded single quote cannot break out", () => {
		const qpaths = {
			logFile: "/sta'te/bg-3.log", statusSnapshot: "/sta'te/bg-3.status",
			outSpool: "/sta'te/bg-3.out.spool", errSpool: "/sta'te/bg-3.err.spool",
			pidFile: "/sta'te/bg-3.pid", nonce: "NON'CE", inContainer: false,
		};
		const w = buildHostWrapper("echo hi", qpaths);
		// Each embedded ' is escaped as '\'' — the literal path bytes are preserved
		// inside a re-opened single-quoted string, with no unbalanced quote.
		assert.match(w, /'\/sta'\\''te\/bg-3\.out\.spool'/);
		assert.match(w, /'NON'\\''CE'/);
		// The naive (buggy) interpolation `'<path>'` would let the embedded quote
		// close the string — assert that unescaped breakout form never appears.
		assert.ok(!w.includes("'/sta'te"), "no unescaped single-quote breakout in paths");
		assert.ok(!w.includes("'NON'CE'"), "no unescaped single-quote breakout in nonce");
	});

	it("buildDockerWrapper is the same POSIX wrapper plus mkdir -p of the container dir", () => {
		const dpaths = {
			...paths,
			containerOutSpool: "/tmp/bobbit-bg/s1/bg-3.out.spool",
			containerErrSpool: "/tmp/bobbit-bg/s1/bg-3.err.spool",
			containerStatus: "/tmp/bobbit-bg/s1/bg-3.status",
			containerPid: "/tmp/bobbit-bg/s1/bg-3.pid",
			inContainer: true,
		};
		const w = buildDockerWrapper("sleep 1", dpaths);
		assert.match(w, /mkdir -p '\/tmp\/bobbit-bg\/s1'/);
		assert.match(w, /\( sleep 1 \) >> '\/tmp\/bobbit-bg\/s1\/bg-3\.out\.spool'/);
		assert.match(w, /printf '%s\\n' "\$code" > '\/tmp\/bobbit-bg\/s1\/bg-3\.status'/);
		assert.doesNotMatch(w, /%errorlevel%/i);
	});
});

describe("BgProcessManager — persistence round-trip", () => {
	it("create → feed chunks → exit → reload manager → records + combined log restored", async () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "run.sh", h.stateDir);
		assert.equal(info.status, "running");
		assert.equal(info.terminalReason, null);

		// Feed interleaved output through the fake tailer.
		const spec = h.specs[0];
		spec.onChunk("stdout", "hello\n", 6);
		spec.onChunk("stderr", "warn\n", 5);
		spec.onChunk("stdout", "world\n", 12);
		h.mgr.flush(S);

		// Drive exit via the durable status file (as the wrapper would write it).
		const rec = h.store().get(S, info.id)!;
		fs.writeFileSync(rec.statusSnapshot, "0\n");
		h.lastChild().emit("exit", 0); // hint → checkStatus reads status

		await h.mgr.waitForExit(S, info.id, 1000);

		// bg-processes.json + durable projection exist on disk.
		assert.ok(fs.existsSync(path.join(h.stateDir, "bg-processes.json")));
		assert.ok(fs.existsSync(rec.logFile));

		// Fresh manager over the same dir restores.
		const h2 = h.reload();
		await h2.mgr.restoreSession(S);
		const restored = h2.mgr.list(S).find(p => p.id === info.id)!;
		assert.ok(restored, "process restored");
		assert.equal(restored.status, "exited");
		assert.equal(restored.exitCode, 0);
		assert.equal(restored.terminalReason, "normal");
		const logs = h2.mgr.getLogs(S, info.id)!;
		assert.deepEqual(logs.log.map(l => l.text), ["hello", "warn", "world"]);
		h2.mgr.cleanup(S);
	});

	it("combined-projection interleaving survives restart (order + per-stream arrays)", async () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "run.sh", h.stateDir);
		const spec = h.specs[0];
		spec.onChunk("stdout", "A\n", 2);
		spec.onChunk("stderr", "B\n", 2);
		spec.onChunk("stdout", "C\n", 4);
		spec.onChunk("stderr", "D\n", 4);
		h.mgr.flush(S);
		const rec = h.store().get(S, info.id)!;
		fs.writeFileSync(rec.statusSnapshot, "0\n");
		h.lastChild().emit("exit", 0);
		await h.mgr.waitForExit(S, info.id, 1000);

		const h2 = h.reload();
		await h2.mgr.restoreSession(S);
		const logs = h2.mgr.getLogs(S, info.id)!;
		assert.deepEqual(logs.log.map(l => `${l.stream}:${l.text}`), ["stdout:A", "stderr:B", "stdout:C", "stderr:D"]);
		assert.deepEqual(logs.stdout, ["A", "C"]);
		assert.deepEqual(logs.stderr, ["B", "D"]);
		h2.mgr.cleanup(S);
	});

	it("Fix 3: per-stream arrays stay ≤ MAX_LOG_LINES after finalFlush bulk append", async () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "chatty.sh", h.stateDir);
		const rec = h.store().get(S, info.id)!;
		// A spool that finalFlush will read whole on exit: > MAX_LOG_LINES short lines.
		fs.writeFileSync(rec.outSpool, Array.from({ length: 6000 }, (_, i) => `o${i}`).join("\n") + "\n");
		fs.writeFileSync(rec.errSpool, Array.from({ length: 6000 }, (_, i) => `e${i}`).join("\n") + "\n");
		fs.writeFileSync(rec.statusSnapshot, "0\n");
		h.lastChild().emit("exit", 0);
		await h.mgr.waitForExit(S, info.id, 2000);
		const logs = h.mgr.getLogs(S, info.id)!;
		assert.ok(logs.stdout.length <= 5000, `stdout ${logs.stdout.length} ≤ 5000 after finalFlush`);
		assert.ok(logs.stderr.length <= 5000, `stderr ${logs.stderr.length} ≤ 5000 after finalFlush`);
		h.mgr.cleanup(S);
	});
});

describe("BgProcessManager — re-attach reconciliation", () => {
	function seedRunningHostRecord(h: Harness, S: string, over: Partial<any> = {}) {
		const id = "bg-1";
		const dir = h.store().filesDir(S);
		fs.mkdirSync(dir, { recursive: true });
		const rec = {
			sessionId: S, id, name: id, command: "loop.sh",
			hostPid: 4242, processPid: 4242, nonce: "NONCE-A",
			cwd: h.stateDir, status: "running" as const, exitCode: null, terminalReason: null,
			startTime: Date.now() - 1000, endTime: null,
			logFile: path.join(dir, `${id}.log`), statusSnapshot: path.join(dir, `${id}.status`),
			outSpool: path.join(dir, `${id}.out.spool`), errSpool: path.join(dir, `${id}.err.spool`),
			pidFile: path.join(dir, `${id}.pid`),
			inContainer: false, outOffset: 0, errOffset: 0,
			...over,
		};
		h.store().put(rec as any);
		return rec;
	}

	it("ALIVE (nonce match) → re-attach reads spool tail then captures eventual real exit code", async (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		// Spool has bytes past the persisted offset (0); pidfile nonce matches.
		fs.writeFileSync(rec.outSpool, "live-line\n");
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");

		await h.mgr.restoreSession(S);
		const logs = h.mgr.getLogs(S, rec.id)!;
		assert.ok(logs.log.some(l => l.text === "live-line"), "retained/new spool tail streamed after restart");
		const after = h.mgr.list(S).find(p => p.id === rec.id)!;
		assert.equal(after.status, "running");

		// Later the status file gains the real exit code → status watcher captures it.
		fs.writeFileSync(rec.statusSnapshot, "0\n");
		t.mock.timers.tick(200);
		const exited = h.sent.find(m => m.type === "bg_process_exited" && m.processId === rec.id);
		assert.ok(exited, "bg_process_exited broadcast");
		assert.equal(exited.exitCode, 0);
		assert.equal(exited.terminalReason, "normal");
		h.mgr.cleanup(S);
	});

	it("COMPLETED during downtime → real exit code from the status file, no fabrication", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => false } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		fs.writeFileSync(rec.statusSnapshot, "137\n");
		await h.mgr.restoreSession(S);
		const p = h.mgr.list(S).find(x => x.id === rec.id)!;
		assert.equal(p.status, "exited");
		assert.equal(p.exitCode, 137);
		assert.equal(p.terminalReason, "normal");
		h.mgr.cleanup(S);
	});

	it("pid reused (nonce mismatch, alive, no status) → unrecoverable, exitCode null", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		fs.writeFileSync(rec.pidFile, "4242\nDIFFERENT-NONCE\n"); // reused pid
		await h.mgr.restoreSession(S);
		const p = h.mgr.list(S).find(x => x.id === rec.id)!;
		assert.equal(p.status, "unrecoverable");
		assert.equal(p.exitCode, null);
		assert.equal(p.terminalReason, "unrecoverable");
		h.mgr.cleanup(S);
	});

	it("lost (dead, no status) → unrecoverable, exitCode null, never fabricated", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => false } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		await h.mgr.restoreSession(S);
		const p = h.mgr.list(S).find(x => x.id === rec.id)!;
		assert.equal(p.status, "unrecoverable");
		assert.equal(p.exitCode, null);
		assert.equal(p.terminalReason, "unrecoverable");
		const exited = h.sent.find(m => m.type === "bg_process_exited");
		assert.equal(exited.exitCode, null);
		assert.equal(exited.terminalReason, "unrecoverable");
		h.mgr.cleanup(S);
	});

	it("Fix 4: ALIVE restore with non-empty projection + overlapping spool tail → no duplicated lines", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		// Host projection already holds retained output (what the gateway saw pre-restart).
		fs.writeFileSync(rec.logFile, `${Date.now()}\tout\tretained-1\n${Date.now()}\tout\tretained-2\n`);
		// The live spool still holds the SAME retained tail PLUS downtime output.
		fs.writeFileSync(rec.outSpool, "retained-1\nretained-2\ndowntime-3\n");
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");

		await h.mgr.restoreSession(S);
		const texts = h.mgr.getLogs(S, rec.id)!.log.map(l => l.text);
		// Overlapping retained lines appear exactly once (single source of truth).
		assert.equal(texts.filter(t => t === "retained-1").length, 1, "retained-1 not duplicated");
		assert.equal(texts.filter(t => t === "retained-2").length, 1, "retained-2 not duplicated");
		// Downtime output produced while the gateway was down is included.
		assert.ok(texts.includes("downtime-3"), "downtime output present");
		h.mgr.cleanup(S);
	});

	it("ALIVE re-attach rebases a stale offset (> spool size) to 0 — no stall, no duplicate", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S, { outOffset: 9999 }); // far past current size
		fs.writeFileSync(rec.outSpool, "retained\n"); // 9 bytes, < 9999
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");
		await h.mgr.restoreSession(S);
		const logs = h.mgr.getLogs(S, rec.id)!;
		assert.deepEqual(logs.log.filter(l => l.text === "retained").length, 1, "retained tail read once from rebased 0");
		// persisted offset reset to the new (small) size.
		const updated = h.store().get(S, rec.id)!;
		assert.equal(updated.outOffset, 9);
		h.mgr.cleanup(S);
	});

	it("Fix 2: spool copytruncated to EMPTY but projection non-empty → restored log == projection (no loss)", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		// Gateway consumed up to offset 100 pre-restart; the wrapper trimmer then
		// copytruncated the spool to empty during downtime.
		const rec = seedRunningHostRecord(h, S, { outOffset: 100 });
		fs.writeFileSync(rec.logFile, `${Date.now()}\tout\tretained-1\n${Date.now()}\tout\tretained-2\n`);
		fs.writeFileSync(rec.outSpool, ""); // copytruncated to empty
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");
		await h.mgr.restoreSession(S);
		const texts = h.mgr.getLogs(S, rec.id)!.log.map(l => l.text);
		assert.deepEqual(texts, ["retained-1", "retained-2"], "retained projection preserved, nothing lost");
		h.mgr.cleanup(S);
	});

	it("Fix 2: downtime bytes in the spool beyond the projection appear after restore", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		fs.writeFileSync(rec.logFile, `${Date.now()}\tout\tretained-1\n`);
		// Spool was copytruncated during downtime and now holds only fresh downtime
		// output (no overlap with the projection).
		fs.writeFileSync(rec.outSpool, "downtime-a\ndowntime-b\n");
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");
		await h.mgr.restoreSession(S);
		const texts = h.mgr.getLogs(S, rec.id)!.log.map(l => l.text);
		assert.deepEqual(texts, ["retained-1", "downtime-a", "downtime-b"], "projection + downtime output, in order");
		h.mgr.cleanup(S);
	});

	it("Fix 3: per-stream arrays stay ≤ MAX_LOG_LINES after restore bulk append", async () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const rec = seedRunningHostRecord(h, S);
		// No projection → spool-only rebuild path; feed > MAX_LOG_LINES short lines.
		const lines = Array.from({ length: 6000 }, (_, i) => `o${i}`).join("\n") + "\n";
		fs.writeFileSync(rec.outSpool, lines);
		fs.writeFileSync(rec.pidFile, "4242\nNONCE-A\n");
		await h.mgr.restoreSession(S);
		const logs = h.mgr.getLogs(S, rec.id)!;
		assert.ok(logs.stdout.length <= 5000, `stdout ${logs.stdout.length} ≤ 5000 after restore`);
		h.mgr.cleanup(S);
	});
});

describe("BgProcessManager — kill terminal states", () => {
	it("graceful kill → real code from status → terminalReason normal", () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const info = h.mgr.create(S, "loop.sh", h.stateDir);
		const rec = h.store().get(S, info.id)!;
		fs.writeFileSync(rec.statusSnapshot, "0\n"); // wrapper wrote real code before dying
		assert.equal(h.mgr.kill(S, info.id), true);
		const p = h.mgr.list(S).find(x => x.id === info.id)!;
		assert.equal(p.status, "exited");
		assert.equal(p.exitCode, 0);
		assert.equal(p.terminalReason, "normal");
	});

	it("hard kill, no status → terminalReason killed, exitCode null (known, not fabricated)", () => {
		const killCalls: any[] = [];
		const h = makeHarness({ env: { isHostPidAlive: () => false, killHostTree: (pid, sig) => killCalls.push([pid, sig]) } });
		const S = freshSession();
		const info = h.mgr.create(S, "loop.sh", h.stateDir);
		assert.equal(h.mgr.kill(S, info.id), true);
		const p = h.mgr.list(S).find(x => x.id === info.id)!;
		assert.equal(p.status, "exited");
		assert.equal(p.exitCode, null);
		assert.equal(p.terminalReason, "killed");
		assert.ok(killCalls.length >= 1, "host kill issued");
	});

	it("user `exit N` inside command → status file carries N → normal/N (not killed)", () => {
		// The wrapper's isolated subshell captures `code=$?` even when the user
		// command calls `exit 3`; we model the status file the wrapper writes.
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const info = h.mgr.create(S, "exit 3", h.stateDir);
		const rec = h.store().get(S, info.id)!;
		fs.writeFileSync(rec.statusSnapshot, "3\n");
		h.lastChild().emit("exit", 3);
		const p = h.mgr.list(S).find(x => x.id === info.id)!;
		assert.equal(p.terminalReason, "normal");
		assert.equal(p.exitCode, 3);
	});
});

describe("BgProcessManager — docker", () => {
	function seedDockerRecord(h: Harness, S: string, over: Partial<any> = {}) {
		const id = "bg-1";
		const dir = h.store().filesDir(S);
		fs.mkdirSync(dir, { recursive: true });
		const cdir = `/tmp/bobbit-bg/${S}`;
		const rec = {
			sessionId: S, id, name: id, command: "loop.sh",
			hostPid: 999 /* dead docker-exec handle */, processPid: 4242, nonce: "NONCE-D",
			cwd: "/workspace", containerId: "container-abc", status: "running" as const,
			exitCode: null, terminalReason: null, startTime: Date.now() - 1000, endTime: null,
			logFile: path.join(dir, `${id}.log`), statusSnapshot: path.join(dir, `${id}.status`),
			outSpool: "", errSpool: "", pidFile: "",
			containerOutSpool: `${cdir}/${id}.out.spool`, containerErrSpool: `${cdir}/${id}.err.spool`,
			containerStatus: `${cdir}/${id}.status`, containerPid: `${cdir}/${id}.pid`,
			inContainer: true, outOffset: 0, errOffset: 0,
			...over,
		};
		h.store().put(rec as any);
		return rec;
	}

	it("restore liveness + kill target the in-container processPid (negative pid group), never hostPid", async () => {
		const calls: string[][] = [];
		const dockerCli = (argv: string[]) => {
			calls.push(argv);
			if (argv[0] === "inspect") return { code: 0, stdout: "true\n" };
			if (argv.includes("kill") && argv.includes("-0")) return { code: 0, stdout: "" };
			if (argv.includes("cat") && argv[argv.length - 1].endsWith(".pid")) return { code: 0, stdout: "4242\nNONCE-D\n" };
			return { code: 0, stdout: "" };
		};
		const h = makeHarness({ env: { dockerCli } });
		const S = freshSession();
		const rec = seedDockerRecord(h, S);
		await h.mgr.restoreSession(S);
		const after = h.mgr.list(S).find(p => p.id === rec.id)!;
		assert.equal(after.status, "running", "re-attached alive container process");

		h.mgr.kill(S, rec.id);
		const killGroup = calls.find(a => a.includes("kill") && a.includes("-TERM") && a.includes("-4242"));
		assert.ok(killGroup, "kill targets negative in-container processPid (group)");
		assert.ok(!calls.some(a => a.includes("-999") || a.includes("999")), "dead hostPid never signalled");
		h.mgr.cleanup(S);
	});

	it("Fix 1b: processPid:0 record, container alive + pidfile readable → recover pid and re-attach", async () => {
		const dockerCli = (argv: string[]) => {
			if (argv[0] === "inspect") return { code: 0, stdout: "true\n" };
			if (argv.includes("kill") && argv.includes("-0")) return { code: 0, stdout: "" };
			if (argv.includes("cat") && argv[argv.length - 1].endsWith(".pid")) return { code: 0, stdout: "4242\nNONCE-D\n" };
			return { code: 0, stdout: "" };
		};
		const h = makeHarness({ env: { dockerCli } });
		const S = freshSession();
		// Persisted in the create→resolve window: processPid still 0.
		const rec = seedDockerRecord(h, S, { processPid: 0 });
		await h.mgr.restoreSession(S);
		const after = h.mgr.list(S).find(p => p.id === rec.id)!;
		assert.equal(after.status, "running", "re-attached after recovering the in-container pid");
		assert.equal(after.pid, 4242, "recovered processPid surfaced");
		const updated = h.store().get(S, rec.id)!;
		assert.equal(updated.processPid, 4242, "recovered pid persisted");
		h.mgr.cleanup(S);
	});

	it("Fix 1b: processPid:0 record, container gone → unrecoverable (no fabrication)", async () => {
		const dockerCli = () => ({ code: 1, stdout: "" }); // container gone, pidfile unreadable
		const h = makeHarness({ env: { dockerCli } });
		const S = freshSession();
		const rec = seedDockerRecord(h, S, { processPid: 0 });
		await h.mgr.restoreSession(S);
		const p = h.mgr.list(S).find(x => x.id === rec.id)!;
		assert.equal(p.status, "unrecoverable");
		assert.equal(p.exitCode, null);
		assert.equal(p.terminalReason, "unrecoverable");
		h.mgr.cleanup(S);
	});

	it("container recreated/removed (no status mirrored) → host projection retained, unrecoverable", async () => {
		const dockerCli = (argv: string[]) => {
			if (argv[0] === "inspect") return { code: 1, stdout: "" }; // container gone
			return { code: 1, stdout: "" };
		};
		const h = makeHarness({ env: { dockerCli } });
		const S = freshSession();
		const rec = seedDockerRecord(h, S);
		// Host projection has retained output (survives container churn).
		fs.writeFileSync(rec.logFile, `${Date.now()}\tout\tretained-output\n`);
		await h.mgr.restoreSession(S);
		const p = h.mgr.list(S).find(x => x.id === rec.id)!;
		assert.equal(p.status, "unrecoverable");
		assert.equal(p.exitCode, null, "no fabricated exit code");
		const logs = h.mgr.getLogs(S, rec.id)!;
		assert.ok(logs.log.some(l => l.text === "retained-output"), "retained host projection still shown");
		h.mgr.cleanup(S);
	});
});

describe("BgProcessManager — dismiss", () => {
	it("dismiss purges persisted files + index entry; a later restore finds nothing", async () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "run.sh", h.stateDir);
		const rec = h.store().get(S, info.id)!;
		// Mark exited so dismiss is allowed, and create the durable files.
		fs.writeFileSync(rec.statusSnapshot, "0\n");
		fs.writeFileSync(rec.outSpool, "out\n");
		fs.writeFileSync(rec.errSpool, "err\n");
		fs.writeFileSync(rec.pidFile, "1\nN\n");
		fs.writeFileSync(rec.logFile, "x");
		h.lastChild().emit("exit", 0);
		await h.mgr.waitForExit(S, info.id, 1000);

		assert.equal(h.mgr.dismiss(S, info.id), true);
		for (const f of [rec.logFile, rec.statusSnapshot, rec.pidFile]) {
			assert.ok(!fs.existsSync(f), `purged ${path.basename(f)}`);
		}
		const dismissed = h.sent.find(m => m.type === "bg_process_dismissed");
		assert.equal(dismissed.processId, info.id);

		const h2 = h.reload();
		await h2.mgr.restoreSession(S);
		assert.equal(h2.mgr.list(S).length, 0, "stays gone after restart");
	});

	it("dismiss refuses a running process unless forced", () => {
		const h = makeHarness({ env: { isHostPidAlive: () => true } });
		const S = freshSession();
		const info = h.mgr.create(S, "loop.sh", h.stateDir);
		assert.equal(h.mgr.dismiss(S, info.id), false, "running → refused");
		assert.equal(h.mgr.dismiss(S, info.id, { force: true }), true, "force → dismissed");
	});
});

describe("BgProcessManager — disk caps", () => {
	it("combined projection stays ≤ caps WHILE running", () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "chatty.sh", h.stateDir);
		const spec = h.specs[0];
		let off = 0;
		// Feed ~2MB across both streams without exiting.
		for (let i = 0; i < 8000; i++) {
			const line = `line-${i}-${"x".repeat(200)}\n`;
			off += line.length;
			spec.onChunk(i % 2 === 0 ? "stdout" : "stderr", line, off);
		}
		h.mgr.flush(S);
		const rec = h.store().get(S, info.id)!;
		const stat = fs.statSync(rec.logFile);
		assert.ok(stat.size <= MAX_LOG_BYTES, `projection ${stat.size} ≤ ${MAX_LOG_BYTES}`);
		const lineCount = fs.readFileSync(rec.logFile, "utf-8").split("\n").filter(Boolean).length;
		assert.ok(lineCount <= 5000, `≤5000 lines (got ${lineCount})`);
		h.mgr.cleanup(S);
	});

	it("Fix 3: combined projection stays ≤ BYTE cap with multibyte output", () => {
		const h = makeHarness();
		const S = freshSession();
		const info = h.mgr.create(S, "chatty.sh", h.stateDir);
		const spec = h.specs[0];
		let off = 0;
		// Each '★' is 3 UTF-8 bytes — JS string .length would undercount the byte size.
		for (let i = 0; i < 8000; i++) {
			const line = `${"★".repeat(200)}\n`;
			off += Buffer.byteLength(line, "utf8");
			spec.onChunk("stdout", line, off);
		}
		h.mgr.flush(S);
		const rec = h.store().get(S, info.id)!;
		const stat = fs.statSync(rec.logFile);
		assert.ok(stat.size <= MAX_LOG_BYTES, `multibyte projection ${stat.size} ≤ ${MAX_LOG_BYTES} bytes`);
		h.mgr.cleanup(S);
	});
});

describe("PollTailer — host poll: rebase + gateway copytruncate", () => {
	it("rebases offset to 0 when spool shrinks below it (no stall)", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-poll-"));
		const file = path.join(dir, "x.spool");
		fs.writeFileSync(file, "short\n"); // 6 bytes
		const chunks: string[] = [];
		const tailer = new PollTailer(file, "stdout", (_s, text) => chunks.push(text));
		tailer.start(9999); // stale offset > size
		t.mock.timers.tick(200);
		assert.ok(chunks.join("").includes("short"), "rebased to 0 and read the retained content");
		tailer.stop();
	});

	it("copytruncates the spool once consumed and over cap", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-poll-"));
		const file = path.join(dir, "x.spool");
		fs.writeFileSync(file, "z".repeat(MAX_LOG_BYTES + 1000));
		const tailer = new PollTailer(file, "stdout", () => {});
		tailer.start(0);
		t.mock.timers.tick(200);
		assert.equal(fs.statSync(file).size, 0, "spool truncated to 0 after consume + over cap");
		tailer.stop();
	});

	it("Fix 2: a delta larger than the cap reads only the last cap bytes (bounded allocation)", (t) => {
		t.mock.timers.enable({ apis: ["setInterval"] });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-poll-"));
		const file = path.join(dir, "x.spool");
		const head = Buffer.alloc(1000, 0x41); // 'A' — older bytes beyond the window
		const tail = Buffer.alloc(MAX_LOG_BYTES, 0x42); // 'B' — the last cap bytes
		fs.writeFileSync(file, Buffer.concat([head, tail]));
		const size = fs.statSync(file).size;
		let received = "";
		let lastOffset = -1;
		const tailer = new PollTailer(file, "stdout", (_s, text, off) => { received += text; lastOffset = off; });
		tailer.start(0);
		t.mock.timers.tick(200);
		assert.equal(received.length, MAX_LOG_BYTES, "read exactly the last cap bytes, not the whole delta");
		assert.ok(!received.includes("A"), "older bytes beyond the retained window were skipped");
		assert.equal(lastOffset, size, "offset advanced to size");
		tailer.stop();
	});
});

describe("bg-runner helper — bounded ring + real exit code", () => {
	it("trims spools to ≤ maxBytes and writes the real exit code + pid/nonce", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-runner-"));
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const opts = {
			shell: "/bin/sh", shellArgs: ["-c"], command: "x",
			outSpool: path.join(dir, "o.spool"), errSpool: path.join(dir, "e.spool"),
			statusFile: path.join(dir, "s.status"), pidFile: path.join(dir, "p.pid"),
			nonce: "RUN-NONCE", maxBytes: 1024,
		};
		runBgRunner(opts, () => child);
		// pidfile written immediately.
		assert.equal(fs.readFileSync(opts.pidFile, "utf-8"), `${process.pid}\nRUN-NONCE\n`);
		// feed > cap → ring trims in place.
		child.stdout.emit("data", Buffer.alloc(4096, 0x61));
		assert.ok(fs.statSync(opts.outSpool).size <= 1024, "spool ring bounded");
		// real exit code on child exit.
		child.emit("exit", 7, null);
		assert.equal(fs.readFileSync(opts.statusFile, "utf-8"), "7\n");
	});

	it("Fix 1: trims an oversize spool to ≤ maxBytes on child exit (before the status write)", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-runner-"));
		const child = new EventEmitter() as any;
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		const opts = {
			shell: "/bin/sh", shellArgs: ["-c"], command: "x",
			outSpool: path.join(dir, "o.spool"), errSpool: path.join(dir, "e.spool"),
			statusFile: path.join(dir, "s.status"), pidFile: path.join(dir, "p.pid"),
			nonce: "RUN-NONCE", maxBytes: 1024,
		};
		runBgRunner(opts, () => child);
		// A burst lands on disk over cap (modelling fast writes that beat per-append
		// trimming); the exit-time trim must bound each spool before the status write.
		fs.writeFileSync(opts.outSpool, Buffer.alloc(5000, 0x61));
		fs.writeFileSync(opts.errSpool, Buffer.alloc(5000, 0x62));
		child.emit("exit", 0, null);
		assert.ok(fs.statSync(opts.outSpool).size <= 1024, "stdout spool trimmed to ≤ cap on exit");
		assert.ok(fs.statSync(opts.errSpool).size <= 1024, "stderr spool trimmed to ≤ cap on exit");
		assert.equal(fs.readFileSync(opts.statusFile, "utf-8"), "0\n");
	});
});
