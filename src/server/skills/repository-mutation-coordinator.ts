import fs from "node:fs";
import path from "node:path";

/**
 * Serializes Git mutations that share one repository's common Git directory.
 * Linked worktrees have separate worktree directories but share config and
 * refs in this directory, so path-based worktree locks are insufficient.
 */
export interface RepositoryMutationCoordinator {
	run<T>(gitCommonDir: string, operation: () => Promise<T>): Promise<T>;
}

export class AsyncRepositoryMutationCoordinator implements RepositoryMutationCoordinator {
	private readonly tails = new Map<string, Promise<void>>();

	async run<T>(gitCommonDir: string, operation: () => Promise<T>): Promise<T> {
		const prior = this.tails.get(gitCommonDir) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((resolve) => { release = resolve; });
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

export const repositoryMutationCoordinator = new AsyncRepositoryMutationCoordinator();

/** Canonicalize an existing Git common directory for use as a process-wide key. */
export async function canonicalGitCommonDir(gitCommonDir: string): Promise<string> {
	let resolved = path.resolve(gitCommonDir);
	try {
		resolved = await fs.promises.realpath(resolved);
	} catch {
		// The Git command determines repository validity. Preserve the resolved path
		// if a test seam or a concurrently removed repository cannot be realpathed.
	}
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
