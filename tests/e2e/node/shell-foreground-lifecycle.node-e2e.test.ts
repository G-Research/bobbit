import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";

import shellExtension, {
	createForegroundGroupWitness,
	createForegroundShellGroupTracker,
	ForegroundShellGroupDrainError,
	foregroundShellSpawnSpec,
	type ForegroundGroupWitness,
} from "../../../defaults/tools/shell/extension.ts";

type GroupSignal = "SIGTERM" | "SIGKILL";
type ProcessIdentity = {
	pid: number;
	kind: "linux-proc-stat-22" | "darwin-lstart-argv-nonce";
	startToken: string;
	nonce?: string;
};

type ProcessSnapshot = ProcessIdentity & { state: string };

function inspectProcess(pid: number): ProcessSnapshot | undefined {
	try {
		if (process.platform === "linux") {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
			return fields[0] && fields[19]
				? { pid, kind: "linux-proc-stat-22", state: fields[0], startToken: fields[19] }
				: undefined;
		}
		if (process.platform === "darwin") {
			const startToken = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			const state = execFileSync("ps", ["-o", "state=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
			const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const nonce = /bobbit-shell-test-descendant:([^\s]+)/.exec(command)?.[1];
			return startToken && state ? { pid, kind: "darwin-lstart-argv-nonce", state, startToken, nonce } : undefined;
		}
	} catch { /* a missing process is not executable */ }
	return undefined;
}

// `kill(pid, 0)` treats both zombies and a reused PID as alive. This probe
// instead follows the fixture's spawn-time identity and counts Z as terminal.
function isExactProcessExecutable(identity: ProcessIdentity): boolean {
	const current = inspectProcess(identity.pid);
	const nonceMatches = identity.kind !== "darwin-lstart-argv-nonce" || current?.nonce === identity.nonce;
	return current?.kind === identity.kind &&
		current.startToken === identity.startToken &&
		nonceMatches &&
		!current.state.startsWith("Z");
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH";
	}
}

function deterministicTracker(options: {
	onSignal?: (processGroupId: number, signal: GroupSignal) => void;
	deadlineMs?: number;
	graceMs?: number;
	onActiveChange?: (active: boolean) => void;
	onSleep?: () => void;
}) {
	let now = 0;
	const reports: string[] = [];
	const signals: Array<[number, GroupSignal]> = [];
	const tracker = createForegroundShellGroupTracker({
		platform: "linux",
		deadlineMs: options.deadlineMs ?? 25,
		graceMs: options.graceMs ?? 10,
		pollMs: 5,
		onActiveChange: options.onActiveChange,
		ops: {
			now: () => now,
			sleep: async ms => {
				now += ms;
				options.onSleep?.();
			},
			signal: (processGroupId, signal) => {
				signals.push([processGroupId, signal]);
				options.onSignal?.(processGroupId, signal);
			},
			report: message => reports.push(message),
		},
	});
	return { tracker, reports, signals, now: () => now };
}

function mutableWitness(initial: "pending" | "live" | "lost" = "live"): {
	witness: ForegroundGroupWitness;
	set: (status: "pending" | "live" | "lost") => void;
} {
	let status = initial;
	return { witness: { status: () => status }, set: next => { status = next; } };
}

describe("foreground shell process-group lifecycle", () => {
	it("finalizes a normally exited root with one exact final kill before tool completion", async () => {
		const ownership = mutableWitness();
		const activeChanges: boolean[] = [];
		const fixture = deterministicTracker({
			onActiveChange: active => activeChanges.push(active),
			onSignal: (processGroupId, signal) => {
				if (processGroupId === 41 && signal === "SIGKILL") ownership.set("lost");
			},
		});

		fixture.tracker.track(41, ownership.witness);
		fixture.tracker.track(41, ownership.witness);
		const firstFinalization = fixture.tracker.finalizeRootExit(41);
		const repeatedFinalization = fixture.tracker.finalizeRootExit(41);
		assert.equal(repeatedFinalization, firstFinalization, "concurrent completion paths share one bounded finalizer");
		await firstFinalization;

		assert.deepEqual(fixture.signals, [[41, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 0, "normal completion must not depend on session drain");
		assert.deepEqual(activeChanges, [true, false], "signal listeners can be installed and removed without duplication");
	});

	it("rejects a non-exiting group at the absolute deadline with structured credential-neutral diagnostics", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25, graceMs: 10 });
		fixture.tracker.track(63, mutableWitness().witness);
		const firstDrain = fixture.tracker.drain();
		assert.equal(fixture.tracker.drain(), firstDrain, "terminal drain failures remain coalesced");

		let failure: unknown;
		await assert.rejects(firstDrain, error => {
			failure = error;
			return error instanceof ForegroundShellGroupDrainError;
		});

		assert.equal(fixture.now(), 25);
		assert.deepEqual(fixture.signals, [[63, "SIGTERM"], [63, "SIGKILL"]]);
		assert.deepEqual((failure as ForegroundShellGroupDrainError).groups, [{
			processGroupId: 63,
			finalWitnessStatus: "live",
			termAttempt: "sent",
			killAttempt: "sent",
			reason: "deadline-exceeded",
			elapsedMs: 25,
			deadlineMs: 25,
		}]);
		assert.equal(fixture.reports.length, 1, "the structured terminal failure is reported exactly once");
		assert.match(fixture.reports[0], /pgid=63 status=live reason=deadline-exceeded TERM=sent KILL=sent/);
		assert.equal(fixture.tracker.activeCount, 1, "an unresolved owner must not look like a successful empty drain");
	});

	it("never signals a reused PGID after its spawn-time witness identity is replaced", async () => {
		const fixture = deterministicTracker({});
		const readiness = new PassThrough();
		let currentStartToken = "original-incarnation";
		const witness = createForegroundGroupWitness(readiness, 91, "spawn-nonce", "linux", pid => ({
			pid,
			pgid: 91,
			kind: "linux-proc-stat-22",
			startToken: currentStartToken,
		}));
		readiness.write("R\t501\t91\tlinux-proc-stat-22\toriginal-incarnation\tspawn-nonce\n");
		assert.equal(witness.status(), "live");
		fixture.tracker.track(91, witness);

		// The same sentinel PID and numeric PGID now describe another process
		// incarnation. Apparent group liveness cannot restore old authority.
		currentStartToken = "reused-incarnation";
		await assert.rejects(fixture.tracker.finalizeRootExit(91), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.deepEqual(error.groups, [{
				processGroupId: 91,
				finalWitnessStatus: "lost",
				termAttempt: "not-attempted",
				killAttempt: "not-attempted",
				reason: "ownership-lost",
				elapsedMs: 0,
				deadlineMs: 25,
			}]);
			return true;
		});
		currentStartToken = "original-incarnation";

		assert.equal(witness.status(), "lost", "witness loss is permanent even if old identity values reappear");
		assert.deepEqual(fixture.signals, [], "a lost witness never regains numeric signal authority");
		assert.equal(fixture.reports.length, 1);
		assert.equal(fixture.tracker.activeCount, 1, "lost ownership remains visible to enclosing teardown");
		readiness.destroy();
	});

	it("queues timeout termination until readiness, then escalates and joins within the invocation", async () => {
		const ownership = mutableWitness("pending");
		const fixture = deterministicTracker({
			onSleep: () => ownership.set("live"),
			onSignal: (_processGroupId, signal) => {
				if (signal === "SIGKILL") ownership.set("lost");
			},
		});
		fixture.tracker.track(93, ownership.witness);
		await fixture.tracker.terminate(93);

		assert.deepEqual(fixture.signals, [[93, "SIGTERM"], [93, "SIGKILL"]]);
		assert.deepEqual(fixture.reports, []);
		assert.equal(fixture.tracker.activeCount, 0);
	});

	it("coalesces abort escalation with root-exit finalization", async () => {
		const ownership = mutableWitness();
		const fixture = deterministicTracker({
			onSignal: (_processGroupId, signal) => {
				if (signal === "SIGKILL") ownership.set("lost");
			},
		});
		fixture.tracker.track(96, ownership.witness);

		const aborted = fixture.tracker.terminate(96);
		const rootExit = fixture.tracker.finalizeRootExit(96);
		assert.equal(rootExit, aborted);
		await aborted;

		assert.deepEqual(fixture.signals, [[96, "SIGTERM"], [96, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 0);
	});

	it("waits for a root-exit readiness race before issuing the exact final kill", async () => {
		const ownership = mutableWitness("pending");
		const fixture = deterministicTracker({
			onSleep: () => ownership.set("live"),
			onSignal: (_processGroupId, signal) => {
				if (signal === "SIGKILL") ownership.set("lost");
			},
		});
		fixture.tracker.track(97, ownership.witness);
		await fixture.tracker.finalizeRootExit(97);

		assert.deepEqual(fixture.signals, [[97, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 0);
	});

	it("POSIX foreground success is withheld when post-exit ownership proof cannot complete", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25 });
		fixture.tracker.track(92, mutableWitness("pending").witness);

		await assert.rejects(fixture.tracker.finalizeRootExit(92), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.deepEqual(error.groups, [{
				processGroupId: 92,
				finalWitnessStatus: "pending",
				termAttempt: "not-attempted",
				killAttempt: "not-attempted",
				reason: "ownership-never-established",
				elapsedMs: 25,
				deadlineMs: 25,
			}]);
			return true;
		});

		assert.equal(fixture.now(), 25);
		assert.deepEqual(fixture.signals, []);
		assert.equal(fixture.reports.length, 1);
		assert.equal(fixture.tracker.activeCount, 1);
	});

	it("propagates a terminal drain failure before an enclosing cleanup can remove its root", async () => {
		const fixture = deterministicTracker({ deadlineMs: 25, graceMs: 10 });
		fixture.tracker.track(94, mutableWitness().witness);
		let removed = false;
		const sessionShutdownThenRemove = async () => {
			await fixture.tracker.drain();
			removed = true;
		};

		await assert.rejects(sessionShutdownThenRemove(), ForegroundShellGroupDrainError);
		assert.equal(removed, false, "session_shutdown rejection must fence owned-root removal");
		assert.equal(fixture.tracker.activeCount, 1);
	});

	it("rejects a signal failure without treating the numeric PGID as proof of exit", async () => {
		const ownership = mutableWitness();
		const fixture = deterministicTracker({
			deadlineMs: 25,
			graceMs: 10,
			onSignal: (_processGroupId, signal) => {
				if (signal === "SIGTERM") {
					const error = new Error("credential-bearing operating-system detail") as NodeJS.ErrnoException;
					error.code = "EPERM";
					throw error;
				}
				ownership.set("lost");
			},
		});
		fixture.tracker.track(95, ownership.witness);

		await assert.rejects(fixture.tracker.drain(), (error: unknown) => {
			assert.ok(error instanceof ForegroundShellGroupDrainError);
			assert.equal(error.groups[0].reason, "signal-failed");
			assert.equal(error.groups[0].termAttempt, "failed");
			assert.equal(error.groups[0].killAttempt, "sent");
			assert.doesNotMatch(error.message, /credential-bearing/);
			return true;
		});
		assert.deepEqual(fixture.signals, [[95, "SIGTERM"], [95, "SIGKILL"]]);
		assert.equal(fixture.tracker.activeCount, 1);
	});

	it("leaves Windows tree ownership to the outer Job without creating POSIX group state", async () => {
		const signals: Array<[number, GroupSignal]> = [];
		const tracker = createForegroundShellGroupTracker({
			platform: "win32",
			ops: { signal: (processGroupId, signal) => signals.push([processGroupId, signal]) },
		});
		tracker.track(74);
		await tracker.drain();

		assert.equal(tracker.activeCount, 0);
		assert.deepEqual(signals, []);
	});

	it("POSIX foreground root exit finalizes a TERM-ignoring descendant before publishing", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
		const descendantNonce = randomBytes(16).toString("hex");
		const descendant = [
			"const fs=require('node:fs');",
			"const {execFileSync}=require('node:child_process');",
			"let identity;",
			"if(process.platform==='linux'){const stat=fs.readFileSync('/proc/'+process.pid+'/stat','utf8');const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/);identity={pid:process.pid,kind:'linux-proc-stat-22',startToken:fields[19]};}",
			"else if(process.platform==='darwin'){const startToken=execFileSync('ps',['-o','lstart=','-p',String(process.pid)],{encoding:'utf8'}).trim();identity={pid:process.pid,kind:'darwin-lstart-argv-nonce',startToken,nonce:process.argv[1].split(':')[1]};}",
			"else{process.exit(125);}",
			"process.stdout.write(JSON.stringify(identity)+'\\n');",
			"process.on('SIGTERM',()=>{});setInterval(()=>{},1000);",
		].join("");
		const command = [
			"const {spawn}=require('node:child_process');",
			`const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(`bobbit-shell-test-descendant:${descendantNonce}`)}],{stdio:['ignore','pipe','ignore']});`,
			"let handshake='';child.stdout.setEncoding('utf8');",
			"child.stdout.on('data',chunk=>{handshake+=chunk;if(handshake.includes('\\n')){process.stdout.write(handshake.slice(0,handshake.indexOf('\\n')+1));setTimeout(()=>process.exit(0),20);}});",
		].join("");
		const spec = foregroundShellSpawnSpec(process.execPath, ["-e"], command);
		const root = spawn(spec.file, spec.args, {
			detached: true,
			env: spec.env,
			stdio: spec.stdio,
		});
		assert.ok(root.pid);
		let identityText = "";
		let resolveIdentity!: () => void;
		const identityReady = new Promise<void>(resolve => { resolveIdentity = resolve; });
		root.stdout!.setEncoding("utf8");
		root.stdout!.on("data", chunk => {
			identityText += chunk;
			if (identityText.includes("\n")) resolveIdentity();
		});
		const tracker = createForegroundShellGroupTracker({ graceMs: 50, deadlineMs: 2_000, pollMs: 10 });
		tracker.track(root.pid, createForegroundGroupWitness(
			root.stdio[3] as NodeJS.ReadableStream,
			root.pid,
			spec.witnessNonce,
		));

		try {
			await Promise.all([once(root, "exit"), identityReady]);
			const descendantIdentity = JSON.parse(identityText.trim()) as ProcessIdentity;
			assert.ok(Number.isSafeInteger(descendantIdentity.pid) && descendantIdentity.pid > 0);
			assert.equal(isExactProcessExecutable(descendantIdentity), true, "fixture descendant must outlive its shell root");
			assert.equal(tracker.activeCount, 1, "the live group remains owned until root-exit finalization");

			await tracker.finalizeRootExit(root.pid);
			assert.equal(tracker.activeCount, 0);
			assert.equal(isExactProcessExecutable(descendantIdentity), false, "root-exit finalization must retire the exact executable descendant before resolving");
		} finally {
			try { process.kill(-root.pid, "SIGKILL"); } catch { /* already drained */ }
		}
	});

	it("routes normal exit, timeout, and already-aborted Bash calls through bounded finalization", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
		const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
		shellExtension({ registerTool: (tool: any) => tools.push(tool) } as any);
		const bash = tools.find(tool => tool.name === "bash");
		assert.ok(bash);

		const normal = await bash.execute("normal", { command: "printf READY", timeout: 2 });
		assert.match(normal.content[0].text, /Exit code: 0\s+READY/);

		const stubbornCommand = `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`;
		const timeoutStartedAt = Date.now();
		const timedOut = await bash.execute("timeout", { command: stubbornCommand, timeout: 0.05 });
		assert.ok(Date.now() - timeoutStartedAt < 2_500, "timeout escalation must finish within the invocation deadline");
		assert.match(timedOut.content[0].text, /timed out after 0\.05s and was killed/);

		const controller = new AbortController();
		controller.abort();
		const abortStartedAt = Date.now();
		const aborted = await bash.execute("abort", { command: stubbornCommand, timeout: 10 }, controller.signal);
		assert.ok(Date.now() - abortStartedAt < 2_500, "already-aborted cleanup must finish within the invocation deadline");
		assert.equal(aborted.content[0].text, "");
	});

	it("TERM-escalates and joins a live foreground root within the per-command deadline", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
		const command = "process.on('SIGTERM',()=>{});process.stdout.write('READY');setInterval(()=>{},1000)";
		const spec = foregroundShellSpawnSpec(process.execPath, ["-e"], command);
		const root = spawn(spec.file, spec.args, {
			detached: true,
			env: spec.env,
			stdio: spec.stdio,
		});
		assert.ok(root.pid);
		const tracker = createForegroundShellGroupTracker({ graceMs: 50, deadlineMs: 2_000, pollMs: 10 });
		tracker.track(root.pid, createForegroundGroupWitness(
			root.stdio[3] as NodeJS.ReadableStream,
			root.pid,
			spec.witnessNonce,
		));
		const rootExit = once(root, "exit");

		try {
			await once(root.stdout!, "data");
			const startedAt = Date.now();
			await tracker.terminate(root.pid);
			await rootExit;

			assert.ok(Date.now() - startedAt < 2_000, "termination must not wait for session shutdown");
			assert.equal(tracker.activeCount, 0);
			assert.equal(isAlive(root.pid), false);
		} finally {
			try { process.kill(-root.pid, "SIGKILL"); } catch { /* already finalized */ }
		}
	});
});
