/**
 * Contract tests for the tier-1 verification command-step runner seam.
 *
 * The real runner remains the production default, but tier-1 exercises command
 * output, exit, timeout, and cancellation deterministically through the fake.
 * Real process-tree fidelity is owned by the e2e tier.
 */
import { describe, expect, it } from "vitest";
import {
	realVerificationCommandRunner,
	type VerificationCommandRunner,
	type VerificationCommandSpawnSpec,
} from "../../src/server/agent/verification-command-runner.js";
import { createFakeVerificationCommandRunner, interpretFakeCommand } from "../harness/fake-verification-command-runner.js";
import { resolveGatewayDeps } from "../../src/server/gateway-deps.js";

interface Observed {
	stdout: string;
	stderr: string;
	code: number | null;
	timedOut: boolean;
	killed: boolean;
}

function spec(command: string, timeoutMs: number): VerificationCommandSpawnSpec {
	return {
		shellBin: "fake-shell",
		shellArgs: [],
		cmdToRun: command,
		command,
		cwd: process.cwd(),
		timeoutMs,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		useDetached: false,
	};
}

function drive(runner: VerificationCommandRunner, command: string, timeoutMs: number, cancelAfterMs?: number): Promise<Observed> {
	return new Promise((resolve) => {
		const tracked = runner.spawn(spec(command, timeoutMs));
		const child = tracked.child;
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
		child.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });
		if (cancelAfterMs != null) {
			setTimeout(() => tracked.killTree("SIGTERM", 0), cancelAfterMs);
		}
		child.on("close", (code: number | null) => {
			resolve({ stdout, stderr, code, timedOut: tracked.timedOut(), killed: tracked.killed() });
		});
	});
}

const fake = createFakeVerificationCommandRunner();

describe("verification command-step runner wiring", () => {
	it("defaults production wiring to the real runner", () => {
		expect(resolveGatewayDeps().commandStepRunner).toBe(realVerificationCommandRunner);
		expect(resolveGatewayDeps({}).commandStepRunner).toBe(realVerificationCommandRunner);
		expect(realVerificationCommandRunner.nonDurable).toBeFalsy();
		expect(fake.nonDurable).toBe(true);
	});

	it("fails closed for unmodelled commands", () => {
		expect(() => interpretFakeCommand("echo ok")).not.toThrow();
		expect(() => interpretFakeCommand(`node -e "process.exit(0)"`)).not.toThrow();
		expect(() => interpretFakeCommand("npm run build")).toThrow(/unrecognised command/i);
		expect(() => interpretFakeCommand("pytest -q")).toThrow(/refusing to fabricate/i);
	});

	it("keeps production CLI free of test-runner wiring", async () => {
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const cliPath = fileURLToPath(new URL("../../src/server/cli.ts", import.meta.url));
		const src = readFileSync(cliPath, "utf8");
		expect(src).not.toMatch(/commandStepRunner/);
		expect(src).not.toMatch(/fake-verification-command-runner/i);
	});
});

describe("verification command-step runner deterministic contract", () => {
	it.each([
		["echo ok", "echo ok", "ok\n", "", 0],
		["successful node command", `node -e "console.log('done');process.exit(0)"`, "done\n", "", 0],
		["stderr and nonzero exit", `node -e "console.error('boom');process.exit(3)"`, "", "boom\n", 3],
		["bare failure", "false", "", "", 1],
	] as const)("emits deterministic output and exit for %s", async (_name, command, stdout, stderr, code) => {
		await expect(drive(fake, command, 1_000)).resolves.toEqual({
			stdout,
			stderr,
			code,
			timedOut: false,
			killed: false,
		});
	});

	it("marks timeout and closes without a clean exit", async () => {
		const result = await drive(fake, `node -e "console.log('started');setTimeout(()=>process.exit(0),1000)"`, 5);
		expect(result.stdout).toBe("started\n");
		expect(result.code).toBeNull();
		expect(result.timedOut).toBe(true);
		expect(result.killed).toBe(false);
	});

	it("killTree deterministically cancels and closes the tracked child", async () => {
		const result = await drive(fake, `node -e "console.log('started');setTimeout(()=>process.exit(0),1000)"`, 2_000, 5);
		expect(result.stdout).toBe("started\n");
		expect(result.code).toBeNull();
		expect(result.timedOut).toBe(false);
		expect(result.killed).toBe(true);
	});
});
