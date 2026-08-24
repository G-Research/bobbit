import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	detectDockerSandboxCapability,
	resolveE2ePlaywrightWorkers,
	resolveE2ERetryCount,
} from "../../scripts/testing-v2/run-e2e-v2.mjs";
import {
	isDockerSandboxAvailable,
	SANDBOX_IMAGE,
} from "../../tests/e2e/test-utils/docker.js";

type ProbeCall = { args: readonly string[]; timeoutMs: number };

function capabilityProbe(daemonAvailable: boolean, imageAvailable: boolean, calls: ProbeCall[]) {
	return (args: readonly string[], timeoutMs: number): boolean => {
		calls.push({ args, timeoutMs });
		return args[0] === "info" ? daemonAvailable : imageAvailable;
	};
}

describe("E2E Docker capability and scheduling", () => {
	it.each([
		{ daemon: false, image: false, expected: "daemon-unavailable", sandbox: false, callCount: 1 },
		{ daemon: true, image: false, expected: "image-unavailable", sandbox: false, callCount: 2 },
		{ daemon: true, image: true, expected: "available", sandbox: true, callCount: 2 },
	])("classifies daemon=$daemon image=$image", ({ daemon, image, expected, sandbox, callCount }) => {
		const coordinatorCalls: ProbeCall[] = [];
		const testCalls: ProbeCall[] = [];

		expect(detectDockerSandboxCapability(capabilityProbe(daemon, image, coordinatorCalls))).toBe(expected);
		expect(isDockerSandboxAvailable(capabilityProbe(daemon, image, testCalls))).toBe(sandbox);
		expect(coordinatorCalls).toHaveLength(callCount);
		expect(testCalls).toHaveLength(callCount);
		for (const calls of [coordinatorCalls, testCalls]) {
			expect(calls[0]).toEqual({ args: ["info"], timeoutMs: 5_000 });
			if (daemon) expect(calls[1]).toEqual({ args: ["image", "inspect", SANDBOX_IMAGE], timeoutMs: 10_000 });
		}
	});

	it("runs Group D only after A, B, and C without changing retries or workers", () => {
		const source = readFileSync("scripts/testing-v2/run-e2e-v2.mjs", "utf8");
		const defaultSchedule = source.match(/\} else \{\n\t\t\/\/ Hosted runners[\s\S]*?\n\t\}\n\n\tconst sample/)?.[0];
		expect(defaultSchedule).toBeDefined();

		const steps = [
			"await runGroupA(A, coordinatorEnv)",
			"await runGroupB(B, coordinatorEnv)",
			"await runGroupC(C, coordinatorEnv)",
			"await runGroupD(D, { coordinatorEnv })",
		];
		let previous = -1;
		for (const step of steps) {
			const position = defaultSchedule!.indexOf(step);
			expect(position, step).toBeGreaterThan(previous);
			previous = position;
		}
		expect(defaultSchedule).not.toContain("groupDRun");
		expect(defaultSchedule).not.toContain("Promise.all");
		expect(resolveE2ERetryCount({})).toBe(3);
		expect(resolveE2ePlaywrightWorkers({})).toBe(2);
		expect(resolveE2ePlaywrightWorkers({ E2E_V2_PW_WORKERS: "4" })).toBe(4);
	});

	it("gates only image-backed sandbox cases and retains non-Docker coverage", () => {
		const source = readFileSync("tests/e2e/sandbox-recovery.spec.ts", "utf8");
		expect(source.match(/test\.skip\(!isDockerSandboxAvailable\(\)/g)).toHaveLength(2);
		expect(source).not.toContain("test.skip(!isDockerAvailable()");
		expect(source).toContain('test.describe("process_exit event handling"');
		expect(source.indexOf('test.describe("process_exit event handling"')).toBeGreaterThan(
			source.lastIndexOf("test.skip(!isDockerSandboxAvailable()"),
		);
	});
});
