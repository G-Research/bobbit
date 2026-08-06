/**
 * Regression for goal bf43b7ab-5092-4331-97c0-25ae392fc9d6:
 * root- and child-goal provisioning use different worktree paths but mutate the
 * same linked-worktree Git common directory.  A repository-scoped coordinator
 * must serialize the full mutation transaction, not merely worktree paths.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { realCommandRunner, type CommandRunner } from "../../src/server/gateway-deps.js";
import { createWorktree } from "../../src/server/skills/git.js";
import { canonicalGitCommonDir } from "../../src/server/skills/repository-mutation-coordinator.js";
import { copyGitTemplate, prepareGitTemplate } from "../harness/git-template.js";

const REPRO = "SHARED_GIT_CONFIG_COORDINATION_REPRO";
const INCIDENT_LOCK = "could not lock config file .git/config: File exists";

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolvePromise!: (value: T) => void;
	return {
		promise: new Promise<T>(resolve => { resolvePromise = resolve; }),
		resolve: value => resolvePromise(value),
	};
}

async function git(runner: CommandRunner, cwd: string, args: string[]): Promise<string> {
	const result = await runner.execFile("git", args, { cwd, encoding: "utf-8", timeout: 10_000 });
	return String(result.stdout).trim();
}

/**
 * This deliberately injectable seam is also a deterministic test barrier.
 * `run()` is invoked before queueing, so the test can prove the second setup
 * arrived while the first setup owns the transaction without timing sleeps.
 */
class BarrierRepositoryMutationCoordinator {
	readonly keys: string[] = [];
	readonly secondOperationEntered = deferred();
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(gitCommonDir: string, operation: () => Promise<T>): Promise<T> {
		this.keys.push(gitCommonDir);
		if (this.keys.length === 2) this.secondOperationEntered.resolve();
		const prior = this.tails.get(gitCommonDir) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => { release = resolve; });
		this.tails.set(gitCommonDir, current);
		await prior.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.tails.get(gitCommonDir) === current) this.tails.delete(gitCommonDir);
		}
	}
}

test("serializes root and child-like upstream mutations by Git common directory", async () => {
	await prepareGitTemplate();
	const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-shared-git-config-"));
	const repoPath = copyGitTemplate(join(fixtureRoot, "repo"));
	const rootBranch = "goal/root-config-coordination";
	const childBranch = "goal/child-config-coordination";
	const firstUpstreamEntered = deferred();
	const releaseFirstUpstream = deferred();
	const incidentLockObserved = deferred();
	const coordinator = new BarrierRepositoryMutationCoordinator();
	let upstreamMutationsInFlight = 0;

	const controlledRunner: CommandRunner = {
		execFile: async (file, args, options) => {
			const isUpstreamMutation = file === "git"
				&& args[0] === "branch"
				&& args.some(arg => arg.startsWith("--set-upstream-to="));
			if (!isUpstreamMutation) return realCommandRunner.execFile(file, args, options);

			upstreamMutationsInFlight++;
			if (upstreamMutationsInFlight === 1) {
				firstUpstreamEntered.resolve();
				await releaseFirstUpstream.promise;
				try {
					return await realCommandRunner.execFile(file, args, options);
				} finally {
					upstreamMutationsInFlight--;
				}
			}

			incidentLockObserved.resolve();
			upstreamMutationsInFlight--;
			const error = new Error(`${REPRO}: ${INCIDENT_LOCK}`);
			(error as Error & { stderr?: string }).stderr = INCIDENT_LOCK;
			throw error;
		},
	};

	try {
		const worktreeOptions = {
			configuredBaseRef: "master",
			commandRunner: controlledRunner,
			// The production coordinator must call this seam with the canonical
			// `git rev-parse --git-common-dir` key, then run provisioning and
			// postcondition validation inside its queued operation.
			repositoryMutationCoordinator: coordinator,
		} as any;
		const rootSetup = createWorktree(repoPath, rootBranch, worktreeOptions);
		await firstUpstreamEntered.promise;
		const childSetup = createWorktree(repoPath, childBranch, worktreeOptions);

		const observed = await Promise.race([
			coordinator.secondOperationEntered.promise.then(() => "serialized" as const),
			incidentLockObserved.promise.then(() => "incident-lock" as const),
		]);
		if (observed === "incident-lock") {
			releaseFirstUpstream.resolve();
			await Promise.allSettled([rootSetup, childSetup]);
			throw new Error(
				`${REPRO}: root and child setup overlapped git branch --set-upstream-to against one Git common directory; `
				+ `the incident lock signature was reproduced (${INCIDENT_LOCK}).`,
			);
		}

		releaseFirstUpstream.resolve();
		const [root, child] = await Promise.all([rootSetup, childSetup]);
		const expectedCommonDir = await canonicalGitCommonDir(
			resolve(repoPath, await git(realCommandRunner, repoPath, ["rev-parse", "--git-common-dir"])),
		);

		expect(coordinator.keys, `${REPRO}: both setups must enter the same repository queue`).toEqual([
			expectedCommonDir,
			expectedCommonDir,
		]);
		expect(upstreamMutationsInFlight, `${REPRO}: queued upstream writes must not overlap`).toBe(0);
		expect(await git(realCommandRunner, root.worktreePath, ["rev-parse", "--abbrev-ref", `${rootBranch}@{upstream}`])).toBe("master");
		expect(await git(realCommandRunner, child.worktreePath, ["rev-parse", "--abbrev-ref", `${childBranch}@{upstream}`])).toBe("master");
	} finally {
		releaseFirstUpstream.resolve();
		rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	}
});

test("reconciles a config-lock report after the upstream postcondition already holds", async () => {
	await prepareGitTemplate();
	const fixtureRoot = mkdtempSync(join(tmpdir(), "bobbit-shared-git-reconcile-"));
	const repoPath = copyGitTemplate(join(fixtureRoot, "repo"));
	const branch = "goal/reconcile-config-lock";
	let injectedLock = false;
	const runner: CommandRunner = {
		execFile: async (file, args, options) => {
			const isUpstreamMutation = file === "git"
				&& args[0] === "branch"
				&& args.some(arg => arg.startsWith("--set-upstream-to="));
			if (!isUpstreamMutation || injectedLock) return realCommandRunner.execFile(file, args, options);

			// Model Git winning the config write but reporting an ambiguous close /
			// config.lock error. Reconciliation must trust verified postconditions,
			// not preserve this false setup failure.
			await realCommandRunner.execFile(file, args, options);
			injectedLock = true;
			const error = new Error(`${REPRO}: ${INCIDENT_LOCK}`);
			(error as Error & { stderr?: string }).stderr = INCIDENT_LOCK;
			throw error;
		},
	};

	try {
		const result = await createWorktree(repoPath, branch, {
			configuredBaseRef: "master",
			commandRunner: runner,
		} as any);
		expect(injectedLock, `${REPRO}: the transient config-lock seam must be exercised`).toBe(true);
		expect(await git(realCommandRunner, result.worktreePath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`])).toBe("master");
	} catch (error) {
		if (error instanceof Error && error.message.includes(INCIDENT_LOCK)) {
			throw new Error(
				`${REPRO}: setup kept a false failure after ${INCIDENT_LOCK} even though branch '${branch}' already tracked master.`,
			);
		}
		throw error;
	} finally {
		rmSync(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	}
});
