import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { installCommandRunnerInterceptor } from "../integration/helpers/command-runner-dispatcher.js";

describe("shared CommandRunner dispatcher leases", () => {
	it("releases owners independently and leaves unintercepted methods untouched", async () => {
		const baseCalls: string[] = [];
		const baseExecFile: CommandRunner["execFile"] = async (file, args, options) => {
			baseCalls.push(`${String(options?.cwd)}:${file} ${args.join(" ")}`);
			return { stdout: "base", stderr: "" };
		};
		const baseExecFileSync: NonNullable<CommandRunner["execFileSync"]> = () => "sync-base";
		const baseSpawn: NonNullable<CommandRunner["spawn"]> = (() => ({ pid: 1 })) as any;
		const runner: CommandRunner = {
			execFile: baseExecFile,
			execFileSync: baseExecFileSync,
			spawn: baseSpawn,
		};

		const releaseAlpha = installCommandRunnerInterceptor(runner, {
			label: "alpha",
			async execFile(file, args, options, next) {
				if (options?.cwd !== "/owned/alpha") return next();
				if (file !== "git" || args.join(" ") !== "status --short") {
					throw new Error(`alpha unexpected command: ${file} ${args.join(" ")}`);
				}
				return { stdout: "alpha", stderr: "" };
			},
		});
		const dispatcherExecFile = runner.execFile;
		const releaseBeta = installCommandRunnerInterceptor(runner, {
			label: "beta",
			async execFile(file, args, options, next) {
				if (options?.cwd !== "/owned/beta") return next();
				if (file !== "git" || args.join(" ") !== "status --short") {
					throw new Error(`beta unexpected command: ${file} ${args.join(" ")}`);
				}
				return { stdout: "beta", stderr: "" };
			},
		});

		try {
			expect(runner.execFile).toBe(dispatcherExecFile);
			expect(runner.execFileSync).toBe(baseExecFileSync);
			expect(runner.spawn).toBe(baseSpawn);
			expect((await runner.execFile("git", ["status", "--short"], { cwd: "/owned/alpha" })).stdout).toBe("alpha");
			expect((await runner.execFile("git", ["status", "--short"], { cwd: "/owned/beta" })).stdout).toBe("beta");
			await expect(runner.execFile("node", ["script.js"], { cwd: "/owned/alpha" })).rejects.toThrow(
				"alpha unexpected command: node script.js",
			);
			expect((await runner.execFile("git", ["status", "--short"], { cwd: "/unrelated" })).stdout).toBe("base");

			releaseAlpha();
			expect(runner.execFile).toBe(dispatcherExecFile);
			expect((await runner.execFile("git", ["status", "--short"], { cwd: "/owned/beta" })).stdout).toBe("beta");
			expect((await runner.execFile("git", ["status", "--short"], { cwd: "/owned/alpha" })).stdout).toBe("base");
		} finally {
			releaseAlpha();
			releaseBeta();
		}

		expect(runner.execFile).toBe(baseExecFile);
		expect(runner.execFileSync).toBe(baseExecFileSync);
		expect(runner.spawn).toBe(baseSpawn);
		expect(baseCalls).toEqual([
			"/unrelated:git status --short",
			"/owned/alpha:git status --short",
		]);
	});
});
