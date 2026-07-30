import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../../src/server/gateway-deps.js";
import { installCommandRunnerInterceptor } from "../integration/helpers/command-runner-dispatcher.js";
import { MaintenanceGitModel } from "../integration/helpers/maintenance-git-model.js";

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

	it("routes one maintenance owner across distinct gateway and route runners without claiming foreign paths", async () => {
		const baseDir = mkdtempSync(join(tmpdir(), "bobbit-maintenance-runner-owners-"));
		const alphaRepo = join(baseDir, "alpha-repo");
		const alphaWorktree = join(baseDir, "alpha-worktree");
		const betaRepo = join(baseDir, "beta-repo");
		const betaWorktree = join(baseDir, "beta-worktree");
		for (const repo of [alphaRepo, betaRepo]) mkdirSync(join(repo, ".git"), { recursive: true });

		const gatewayBase: CommandRunner["execFile"] = async () => ({ stdout: "gateway-base", stderr: "" });
		const routeBase: CommandRunner["execFile"] = async () => ({ stdout: "route-base", stderr: "" });
		const gatewayRunner: CommandRunner = { execFile: gatewayBase };
		const routeRunner: CommandRunner = { execFile: routeBase };
		const alpha = new MaintenanceGitModel("dispatcher-regression-alpha");
		const beta = new MaintenanceGitModel("dispatcher-regression-beta");
		let releaseAlpha: (() => void) | undefined;
		let releaseBeta: (() => void) | undefined;

		try {
			alpha.registerRepo(alphaRepo);
			alpha.addWorktree(alphaRepo, alphaWorktree, "alpha-branch");
			beta.registerRepo(betaRepo);
			beta.addWorktree(betaRepo, betaWorktree, "beta-branch");
			releaseAlpha = alpha.install([gatewayRunner, routeRunner, routeRunner]);
			releaseBeta = beta.install([gatewayRunner, routeRunner]);

			const routeAlpha = await routeRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: alphaRepo });
			const gatewayBeta = await gatewayRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: betaRepo });
			expect(routeAlpha.stdout).toContain(alphaWorktree);
			expect(gatewayBeta.stdout).toContain(betaWorktree);
			expect((await routeRunner.execFile("git", ["status"], { cwd: join(baseDir, "foreign") })).stdout).toBe("route-base");

			releaseAlpha();
			expect((await routeRunner.execFile("git", ["status"], { cwd: alphaRepo })).stdout).toBe("route-base");
			expect((await routeRunner.execFile("git", ["worktree", "list", "--porcelain"], { cwd: betaRepo })).stdout).toContain(betaWorktree);
		} finally {
			releaseAlpha?.();
			releaseBeta?.();
			alpha.reset();
			beta.reset();
			rmSync(baseDir, { recursive: true, force: true });
		}

		expect(gatewayRunner.execFile).toBe(gatewayBase);
		expect(routeRunner.execFile).toBe(routeBase);
	});
});
