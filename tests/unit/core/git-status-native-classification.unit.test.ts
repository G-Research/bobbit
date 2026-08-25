import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../../../src/server/gateway-deps.ts";
import {
	probeBatchGitStatusNative,
	runBatchGitStatusNative,
} from "../../../src/server/skills/git-status-native.ts";

function rejected(message: string, fields: Record<string, unknown> = {}): Error {
	return Object.assign(new Error(message), fields);
}

function failingHost(error: Error): CommandRunner {
	return {
		async execFile() {
			throw error;
		},
	};
}

function containerReturning(stdout: string, inspectScript?: (script: string) => void): CommandRunner {
	return {
		async execFile(file, args) {
			expect(file).toBe("docker");
			inspectScript?.(args.at(-1) ?? "");
			return { stdout, stderr: "" };
		},
	};
}

describe("classified native Git status probes", () => {
	it("classifies only the known host outside-repository diagnostic as definitive", async () => {
		const probe = await probeBatchGitStatusNative("/not-git", {
			commandRunner: failingHost(rejected("git failed", {
				code: 128,
				stderr: "fatal: not a git repository (or any of the parent directories): .git",
			})),
		});
		expect(probe.kind).toBe("not-repository");

		// The legacy nullable wrapper remains compatible for direct callers.
		await expect(runBatchGitStatusNative("/not-git", {
			commandRunner: failingHost(rejected("git failed", { code: 128, stderr: "fatal: not a git repository" })),
		})).resolves.toBeNull();
	});

	it("marks a host result partial and untracked-incomplete when porcelain fails", async () => {
		const runner: CommandRunner = {
			async execFile(_file, args) {
				if (args.join(" ") === "rev-parse --abbrev-ref HEAD") return { stdout: "master\n", stderr: "" };
				throw rejected("optional probe failed", { code: 128, stderr: "optional probe failed" });
			},
		};
		const probe = await probeBatchGitStatusNative("/repo", { untracked: true, commandRunner: runner });
		expect(probe.kind).toBe("success");
		if (probe.kind === "success") {
			expect(probe.result.partial).toBe(true);
			expect(probe.result.untrackedIncluded).toBe(false);
		}
	});

	it.each([
		["missing executable", rejected("spawn git ENOENT", { code: "ENOENT" })],
		["permission spawn with terminal-looking output", rejected("spawn git EACCES", { code: "EACCES", stderr: "fatal: not a git repository" })],
		["timeout", rejected("Command timed out", { code: "ETIMEDOUT", killed: true, signal: "SIGTERM" })],
		["timeout with terminal-looking output", rejected("Command timed out", { code: "ETIMEDOUT", killed: true, stderr: "fatal: not a git repository" })],
		["dubious ownership", rejected("git failed", { code: 128, stderr: "fatal: detected dubious ownership in repository" })],
		["permission", rejected("git failed", { code: 128, stderr: "fatal: cannot open .git/HEAD: Permission denied" })],
		["unknown failure", rejected("git failed", { code: 128, stderr: "fatal: unexpected repository failure" })],
	])("keeps host %s failures retryable", async (_label, error) => {
		const probe = await probeBatchGitStatusNative("/repo", { commandRunner: failingHost(error) });
		expect(probe.kind).toBe("error");
	});

	it("emits and parses a distinct container not-repository sentinel", async () => {
		let script = "";
		const probe = await probeBatchGitStatusNative("/workspace", {
			containerId: "container",
			commandRunner: containerReturning("__BOBBIT_GIT_STATUS__:NOT_REPOSITORY\0", value => { script = value; }),
		});
		expect(probe.kind).toBe("not-repository");
		expect(script).toContain("__BOBBIT_GIT_STATUS__:NOT_REPOSITORY");
		expect(script).toContain("__BOBBIT_GIT_STATUS__:PROBE_ERROR");
		expect(script).toContain("not a git repository");
	});

	it("keeps container mandatory-probe diagnostics retryable", async () => {
		const probe = await probeBatchGitStatusNative("/workspace", {
			containerId: "container",
			commandRunner: containerReturning("__BOBBIT_GIT_STATUS__:PROBE_ERROR:128:fatal: detected dubious ownership\0"),
		});
		expect(probe.kind).toBe("error");
		if (probe.kind === "error") expect(probe.diagnostic).toMatch(/dubious ownership/);
	});

	it("marks successful container results partial when optional probes fail", async () => {
		const stdout = [
			"feature/test",
			"__FAIL__",
			"yes",
			"no",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__FAIL__",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"__BOBBIT_GIT_STATUS__:OPTIONAL_ERROR",
			"master",
		].join("\0");
		const probe = await probeBatchGitStatusNative("/workspace", {
			containerId: "container",
			untracked: true,
			commandRunner: containerReturning(stdout),
		});
		expect(probe.kind).toBe("success");
		if (probe.kind === "success") {
			expect(probe.result.partial).toBe(true);
			expect(probe.result.untrackedIncluded).toBe(false);
			expect(probe.result.status).toEqual([]);
		}
	});

	it.each([
		["docker missing", rejected("spawn docker ENOENT", { code: "ENOENT" })],
		["docker timeout", rejected("docker timed out", { code: "ETIMEDOUT", killed: true })],
		["unknown docker rejection", rejected("docker exec failed", { code: 125, stderr: "daemon unavailable" })],
	])("keeps %s retryable", async (_label, error) => {
		const probe = await probeBatchGitStatusNative("/workspace", {
			containerId: "container",
			commandRunner: failingHost(error),
		});
		expect(probe.kind).toBe("error");
	});
});
