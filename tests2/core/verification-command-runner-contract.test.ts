/**
 * Contract test: the tier-1 FAKE verification command-step runner must be
 * observably equivalent to the REAL durable runner for the primitive command
 * shapes the fake-target specs use — and the seam must default to REAL.
 *
 * We drive BOTH runners through the SAME attached-mode spec and assert an
 * identical observable outcome: streamed stdout/stderr, exit-code, timeout, and
 * cancellation (killTree → close). This is a FOCUSED real-spawn test (it spawns
 * real shells for the real runner) — the durable-recovery / tree-kill / Git-Bash
 * fallback fidelity lives in the real-path integration + daily tiers.
 */
import { describe, expect, it } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
	realVerificationCommandRunner,
	type VerificationCommandRunner,
	type VerificationCommandSpawnSpec,
} from "../../src/server/agent/verification-command-runner.js";
import { createFakeVerificationCommandRunner } from "../harness/fake-verification-command-runner.js";
import { getVerificationShell } from "../../src/server/agent/shell-util.js";
import { resolveGatewayDeps } from "../../src/server/gateway-deps.js";

interface Observed {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	/** null when the process closed on its own; set when we killed it. */
	killedClosed: boolean;
}

const norm = (s: string) => s.replace(/\r\n/g, "\n").trim();

function spec(command: string, timeoutMs: number): VerificationCommandSpawnSpec {
	const { shell, args } = getVerificationShell(command);
	return {
		shellBin: shell,
		shellArgs: args,
		cmdToRun: command, // attached mode → raw command (no durable wrapper)
		command,
		cwd: process.cwd(),
		timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: process.platform === "win32",
		useDetached: false,
	};
}

function drive(runner: VerificationCommandRunner, command: string, timeoutMs: number, cancelAfterMs?: number): Promise<Observed> {
	return new Promise((resolve) => {
		const tracked = runner.spawn(spec(command, timeoutMs));
		const child = tracked.child as ChildProcess;
		let stdout = "";
		let stderr = "";
		let killed = false;
		child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
		child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
		if (cancelAfterMs != null) {
			setTimeout(() => { killed = true; tracked.killTree("SIGTERM", 1000); }, cancelAfterMs);
		}
		child.on("close", (code: number | null) => {
			resolve({ stdout, stderr, code, timedOut: tracked.timedOut(), killedClosed: killed });
		});
		child.on("error", () => {
			resolve({ stdout, stderr, code: null, timedOut: tracked.timedOut(), killedClosed: killed });
		});
	});
}

const fake = createFakeVerificationCommandRunner();

describe("verification command-step runner: default-real wiring", () => {
	it("resolveGatewayDeps defaults commandStepRunner to the REAL runner", () => {
		expect(resolveGatewayDeps().commandStepRunner).toBe(realVerificationCommandRunner);
		expect(resolveGatewayDeps({}).commandStepRunner).toBe(realVerificationCommandRunner);
	});

	it("the real runner is NOT marked nonDurable; the fake IS", () => {
		expect(realVerificationCommandRunner.nonDurable).toBeFalsy();
		expect(fake.nonDurable).toBe(true);
	});

	it("cli.ts wires no command-step fake (production is always real)", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const cliPath = fileURLToPath(new URL("../../src/server/cli.ts", import.meta.url));
		const src = readFileSync(cliPath, "utf8");
		expect(src).not.toMatch(/commandStepRunner/);
		expect(src).not.toMatch(/fake-verification-command-runner/i);
	});
});

describe("verification command-step runner: fake ⇔ real observable contract", () => {
	const cases: Array<{ name: string; command: string; timeoutMs: number }> = [
		{ name: "echo ok", command: "echo ok", timeoutMs: 30_000 },
		{ name: "echo metadata-works", command: "echo metadata-works", timeoutMs: 30_000 },
		{ name: "node console.log", command: `node -e "console.log('FRESH_ROOT_AFTER_RESET')"`, timeoutMs: 30_000 },
		{ name: "node exit 0", command: `node -e "process.exit(0)"`, timeoutMs: 30_000 },
		{ name: "node exit 1", command: `node -e "process.exit(1)"`, timeoutMs: 30_000 },
		{ name: "node exit 7", command: `node -e "process.exit(7)"`, timeoutMs: 30_000 },
		{ name: "node delayed exit", command: `node -e "setTimeout(()=>process.exit(0),300)"`, timeoutMs: 30_000 },
		{ name: "node delayed log+exit", command: `node -e "setTimeout(()=>{console.log('done');process.exit(0)},200)"`, timeoutMs: 30_000 },
	];

	for (const c of cases) {
		it(`matches for: ${c.name}`, async () => {
			const [real, faked] = await Promise.all([
				drive(realVerificationCommandRunner, c.command, c.timeoutMs),
				drive(fake, c.command, c.timeoutMs),
			]);
			expect(faked.code, `${c.name}: exit code`).toBe(real.code);
			expect(norm(faked.stdout), `${c.name}: stdout`).toBe(norm(real.stdout));
			expect(faked.timedOut, `${c.name}: timedOut`).toBe(real.timedOut);
		});
	}

	it("matches on TIMEOUT (scripted delay exceeds step timeout)", async () => {
		const command = `node -e "setTimeout(()=>process.exit(0),5000)"`;
		const [real, faked] = await Promise.all([
			drive(realVerificationCommandRunner, command, 400),
			drive(fake, command, 400),
		]);
		// The harness derives a TIMEOUT-failure verdict from tracked.timedOut()
		// and ignores the raw close code (which differs by kill mechanism across
		// OSes), so the observable contract is `timedOut`, not the exit code.
		expect(real.timedOut, "real timed out").toBe(true);
		expect(faked.timedOut, "fake timed out").toBe(true);
		// Neither reports a clean self-exit-0 on timeout.
		expect(real.code === 0, "real not clean-0").toBe(false);
		expect(faked.code === 0, "fake not clean-0").toBe(false);
	});

	it("matches on CANCELLATION (killTree closes the child)", async () => {
		const command = `node -e "setTimeout(()=>process.exit(0),5000)"`;
		const [real, faked] = await Promise.all([
			drive(realVerificationCommandRunner, command, 30_000, 200),
			drive(fake, command, 30_000, 200),
		]);
		// Both must CLOSE after killTree (not hang), and neither reports a clean
		// self-completion (timedOut stays false — this is a cancel, not a timeout).
		expect(real.killedClosed).toBe(true);
		expect(faked.killedClosed).toBe(true);
		expect(faked.timedOut).toBe(false);
		expect(real.timedOut).toBe(false);
	});
});
