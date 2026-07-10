/**
 * Tier-1 FAKE for the verification command-step executor (D4 seam).
 *
 * Reproduces the OBSERVABLE contract of the real durable runner WITHOUT
 * spawning an OS shell:
 *   - streamed stdout/stderr chunks (via the child's stdout/stderr emitters),
 *   - exit-code → verdict (child "exit"/"close" with a scripted code),
 *   - step timeout (marks timedOut + closes when the scripted delay exceeds the
 *     harness timeout), and
 *   - cancellation (killTree → prompt close so the harness sees the cancelled
 *     tracked key), and the restart→pending/retryable state (declared via
 *     `nonDurable`, which routes the harness onto the attached path).
 *
 * It NEVER spawns a process, so it removes the cmd.exe/Git-Bash spawns that
 * uncounted-oversubscribe the box under concurrent test:v2 load. It is reachable
 * ONLY when a test fixture injects it via GatewayDeps.commandStepRunner; the
 * real durable path is the production default and is never touched here.
 *
 * The command interpreter models exactly the primitive shapes the migrated
 * fake-target specs use (echo, node -e console.log/process.exit/setTimeout,
 * true/false). Fidelity vs the real runner is pinned by the contract test
 * tests2/core/verification-command-runner-contract.test.ts; anything the real
 * shell would do differently is caught there.
 */
import { EventEmitter } from "node:events";
import type {
	VerificationCommandRunner,
	VerificationCommandSpawnSpec,
} from "../../src/server/agent/verification-command-runner.js";
import type { TrackedChild } from "../../src/server/agent/spawn-tree.js";

interface ScriptedResult {
	exitCode: number;
	/** Output emitted while the scripted process is still running. */
	initialStdout: string;
	initialStderr: string;
	/** Output emitted as the scripted process completes. */
	stdout: string;
	stderr: string;
	/** Wall delay before the (scripted) process completes. Preserves timing-
	 *  sensitive observations (running/waiting windows, cancel-mid-flight). */
	delayMs: number;
}

/**
 * FAIL-CLOSED interpreter for the primitive command shapes the fake-target
 * verification specs use (`echo …`, `true`/`false`, `node -e "…"`). Anything
 * outside these shapes THROWS — it is never silently green-lit. This matches the
 * goal's fail-closed DI philosophy: a future fake-target spec that introduces a
 * new command (especially an expected-FAIL one) must not be masked as a pass;
 * the throw surfaces as a spawn error → the harness fails the step with the
 * descriptive message, forcing the interpreter to be extended (and the contract
 * test to pin the new shape) deliberately.
 */
export function interpretFakeCommand(command: string): ScriptedResult {
	const cmd = command.trim();
	const res: ScriptedResult = { exitCode: 0, initialStdout: "", initialStderr: "", stdout: "", stderr: "", delayMs: 0 };

	// `true` / `false`
	if (cmd === "true") return res;
	if (cmd === "false") return { ...res, exitCode: 1 };

	// `echo <text>` (single echo; no pipes/chains in the fake-target set)
	const echo = /^echo\s+(.*)$/s.exec(cmd);
	if (echo) {
		let text = echo[1];
		// Strip one layer of surrounding quotes if present (bash would too).
		const q = /^"(.*)"$/s.exec(text) || /^'(.*)'$/s.exec(text);
		if (q) text = q[1];
		return { ...res, stdout: `${text}\n` };
	}

	// `node -e "<script>"` / `node -e '<script>'` / `node -e <script>`
	const nodeE = /^node\s+-e\s+(.*)$/s.exec(cmd);
	if (nodeE) {
		let script = nodeE[1].trim();
		const sq = /^"([\s\S]*)"$/.exec(script) || /^'([\s\S]*)'$/.exec(script);
		if (sq) script = sq[1];
		return interpretNodeEval(script);
	}

	// Fail-closed: never fabricate a verdict for an unmodelled command.
	throw new Error(
		`[fake-verification-command-runner] unrecognised command — refusing to fabricate a verdict: ${JSON.stringify(command)}. ` +
			`Extend interpretFakeCommand() (and pin the new shape in the contract test), or run this spec on the REAL command-step runner.`,
	);
}

function interpretNodeEval(script: string): ScriptedResult {
	const res: ScriptedResult = { exitCode: 0, initialStdout: "", initialStderr: "", stdout: "", stderr: "", delayMs: 0 };

	// setTimeout(() => ..., MS) — the body runs after MS; capture the delay.
	const st = /setTimeout\s*\(\s*\(\)\s*=>\s*([\s\S]*?)\s*,\s*(\d+)\s*\)/.exec(script);
	let immediateBody = script;
	let completionBody = script;
	if (st) {
		res.delayMs = parseInt(st[2], 10) || 0;
		immediateBody = script.slice(0, st.index) + script.slice(st.index + st[0].length);
		completionBody = st[1]; // e.g. "process.exit(0)" or "{console.log('done');process.exit(0)}"
	}

	// console.log('X') / console.log("X") — collect all, newline-joined (Node
	// prints one line per call). console.error('Y') → stderr (error channel).
	const collect = (body: string, re: RegExp): string => {
		let m: RegExpExecArray | null;
		const lines: string[] = [];
		while ((m = re.exec(body)) !== null) lines.push(m[2]);
		return lines.map((l) => `${l}\n`).join("");
	};
	res.initialStdout = st ? collect(immediateBody, /console\.log\(\s*(['"])([\s\S]*?)\1\s*\)/g) : "";
	res.initialStderr = st ? collect(immediateBody, /console\.error\(\s*(['"])([\s\S]*?)\1\s*\)/g) : "";
	res.stdout = collect(completionBody, /console\.log\(\s*(['"])([\s\S]*?)\1\s*\)/g);
	res.stderr = collect(completionBody, /console\.error\(\s*(['"])([\s\S]*?)\1\s*\)/g);

	// process.exit(N) — default 0 when the script just logs / falls off the end.
	const ex = /process\.exit\(\s*(\d+)\s*\)/.exec(completionBody);
	if (ex) res.exitCode = parseInt(ex[1], 10) || 0;

	return res;
}

/** A fake ChildProcess-shaped emitter with the surface runCommandStep consumes. */
class FakeChild extends EventEmitter {
	readonly stdout = Object.assign(new EventEmitter(), { destroy() {} });
	readonly stderr = Object.assign(new EventEmitter(), { destroy() {} });
	readonly pid: number;
	constructor(pid: number) {
		super();
		this.pid = pid;
	}
	unref(): void {}
	kill(): boolean { return true; }
}

let _fakePidCounter = 900_000;

function makeFakeTracked(spec: VerificationCommandSpawnSpec): TrackedChild {
	const child = new FakeChild(++_fakePidCounter);
	const script = interpretFakeCommand(spec.command);
	let closed = false;
	let killed = false;
	let timedOut = false;
	let completionTimer: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
	let initialOutputTimer: ReturnType<typeof setTimeout> | undefined;
	let initialOutputEmitted = false;
	let finalOutputEmitted = false;

	const clearTimers = () => {
		if (completionTimer) clearTimeout(completionTimer);
		if (timeoutTimer) clearTimeout(timeoutTimer);
		if (initialOutputTimer) clearTimeout(initialOutputTimer);
		completionTimer = undefined;
		timeoutTimer = undefined;
		initialOutputTimer = undefined;
	};

	const emitClose = (code: number | null, signal: NodeJS.Signals | null) => {
		if (closed) return;
		closed = true;
		clearTimers();
		child.emit("exit", code, signal);
		child.emit("close", code, signal);
	};

	// Stream scripted output before completion when the script logs before a
	// delayed exit. This mirrors attached pipes and lets tests observe live output
	// without waiting for the fake process to close.
	const emitInitialOutput = () => {
		if (initialOutputEmitted) return;
		initialOutputEmitted = true;
		if (script.initialStdout) child.stdout.emit("data", Buffer.from(script.initialStdout));
		if (script.initialStderr) child.stderr.emit("data", Buffer.from(script.initialStderr));
	};
	const emitFinalOutput = () => {
		if (finalOutputEmitted) return;
		finalOutputEmitted = true;
		if (script.stdout) child.stdout.emit("data", Buffer.from(script.stdout));
		if (script.stderr) child.stderr.emit("data", Buffer.from(script.stderr));
	};
	initialOutputTimer = setTimeout(() => {
		if (closed || killed) return;
		emitInitialOutput();
	}, 0);
	initialOutputTimer.unref?.();

	// Timeout: the scripted delay exceeds the harness-provided step timeout.
	if (Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 && script.delayMs > spec.timeoutMs) {
		timeoutTimer = setTimeout(() => {
			if (closed || killed) return;
			timedOut = true;
			emitInitialOutput();
			emitClose(null, "SIGTERM");
		}, spec.timeoutMs);
		timeoutTimer.unref?.();
	} else {
		completionTimer = setTimeout(() => {
			if (closed || killed) return;
			emitInitialOutput();
			emitFinalOutput();
			emitClose(script.exitCode, null);
		}, script.delayMs);
		completionTimer.unref?.();
	}

	const tracked: TrackedChild & { _timedOut?: boolean } = {
		child: child as unknown as TrackedChild["child"],
		killed: () => killed,
		timedOut: () => timedOut || !!tracked._timedOut,
		markSurvival: () => { /* fake children never survive shutdown */ },
		killTree: (_signal, _graceMsOverride) => {
			if (closed) return;
			killed = true;
			// Close promptly so cancellation is observable (real path escalates
			// SIGTERM→SIGKILL; the fake just ends the "process"). The harness has
			// already recorded the cancelled tracked key before calling killTree.
			setTimeout(() => emitClose(null, "SIGTERM"), 0).unref?.();
		},
	};
	return tracked;
}

/**
 * Create a fake command-step runner. `nonDurable:true` makes the harness route
 * every command step through the attached, restart→pending/retryable path, so
 * none of the durable pid/exit-file machinery runs against the fake.
 */
export function createFakeVerificationCommandRunner(): VerificationCommandRunner {
	return {
		nonDurable: true,
		spawn: (spec) => makeFakeTracked(spec),
	};
}
