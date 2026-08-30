import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { WorktreePool } from "../../../src/server/agent/worktree-pool.js";
import { realCommandRunner, type CommandRunner } from "../../../src/server/gateway-deps.js";
import { createWorktree } from "../../../src/server/skills/git.js";
import {
	canonicalGitCommonDir,
	type RepositoryMutationCoordinator,
} from "../../../src/server/skills/repository-mutation-coordinator.js";
import { copyGitTemplate, prepareGitTemplate } from "../../../tests2/harness/git-template.js";

const INCIDENT_LOCK = "could not lock config file .git/config: File exists";

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
	let resolvePromise!: (value: T) => void;
	return {
		promise: new Promise<T>(resolve => { resolvePromise = resolve; }),
		resolve: value => resolvePromise(value),
	};
}

/** A barrier-controlled implementation of the process-wide common-dir queue. */
class BarrierCoordinator implements RepositoryMutationCoordinator {
	readonly keys: string[] = [];
	readonly secondQueued = deferred();
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
		this.keys.push(key);
		if (this.keys.length === 2) this.secondQueued.resolve();
		const prior = this.tails.get(key) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>(resolve => { release = resolve; });
		this.tails.set(key, current);
		await prior.catch(() => undefined);
		try {
			return await operation();
		} finally {
			release();
			if (this.tails.get(key) === current) this.tails.delete(key);
		}
	}
}

test("serializes concurrent pool claims by canonical Git common directory", async () => {
	await prepareGitTemplate();
	const root = mkdtempSync(join(tmpdir(), "bobbit-pool-config-coordination-"));
	const repo = copyGitTemplate(join(root, "repo"));
	const firstRenameEntered = deferred();
	const releaseFirstRename = deferred();
	const incidentLockObserved = deferred();
	const coordinator = new BarrierCoordinator();
	let activeBranchRenames = 0;
	let firstPool: WorktreePool | undefined;
	let secondPool: WorktreePool | undefined;

	const runner: CommandRunner = {
		execFile: async (file, args, options) => {
			const isClaimRename = file === "git" && args[0] === "branch" && args[1] === "-m";
			if (!isClaimRename) return realCommandRunner.execFile(file, args, options);

			activeBranchRenames++;
			if (activeBranchRenames === 1) {
				firstRenameEntered.resolve();
				await releaseFirstRename.promise;
				try {
					return await realCommandRunner.execFile(file, args, options);
				} finally {
					activeBranchRenames--;
				}
			}

			incidentLockObserved.resolve();
			activeBranchRenames--;
			const error = new Error(INCIDENT_LOCK);
			(error as Error & { stderr?: string }).stderr = INCIDENT_LOCK;
			throw error;
		},
	};

	try {
		const first = await createWorktree(repo, "pool/_pool-claim-one");
		const second = await createWorktree(repo, "pool/_pool-claim-two");
		firstPool = new WorktreePool({
			repoPath: repo,
			targetSize: 0,
			commandRunner: runner,
			repositoryMutationCoordinator: coordinator,
		});
		secondPool = new WorktreePool({
			repoPath: repo,
			targetSize: 0,
			commandRunner: runner,
			repositoryMutationCoordinator: coordinator,
		});
		firstPool.registerExternalEntry("pool/_pool-claim-one", first.worktreePath);
		secondPool.registerExternalEntry("pool/_pool-claim-two", second.worktreePath);

		const rootClaim = firstPool.claim("goal/root-pool-claim");
		await firstRenameEntered.promise;
		const childClaim = secondPool.claim("goal/child-pool-claim");

		const observed = await Promise.race([
			coordinator.secondQueued.promise.then(() => "queued" as const),
			incidentLockObserved.promise.then(() => "incident-lock" as const),
		]);
		if (observed === "incident-lock") {
			releaseFirstRename.resolve();
			await Promise.allSettled([rootClaim, childClaim]);
			throw new Error(`concurrent pool claims reached ${INCIDENT_LOCK}`);
		}

		releaseFirstRename.resolve();
		const [rootClaimed, childClaimed] = await Promise.all([rootClaim, childClaim]);
		expect(rootClaimed?.branchName).toBe("goal/root-pool-claim");
		expect(childClaimed?.branchName).toBe("goal/child-pool-claim");
		expect(activeBranchRenames).toBe(0);
		const expectedCommonDir = await canonicalGitCommonDir(resolve(repo, (await realCommandRunner.execFile(
			"git",
			["rev-parse", "--git-common-dir"],
			{ cwd: repo, encoding: "utf-8" },
		)).stdout.toString().trim()));
		expect(coordinator.keys).toEqual([expectedCommonDir, expectedCommonDir]);
	} finally {
		releaseFirstRename.resolve();
		await Promise.all([firstPool?.stop(), secondPool?.stop()]);
		rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
	}
});
