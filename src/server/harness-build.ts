import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STAGING_PREFIX = ".bobbit-dist-stage-";
const BACKUP_PREFIX = ".bobbit-dist-previous-";
const REBUILT_DIST_ENTRIES = new Set(["server", "shared"]);

export interface StagedDistBuild {
	projectRoot: string;
	liveDist: string;
	stagingDir: string;
}

function assertManagedSibling(projectRoot: string, candidate: string, prefix: string): void {
	const resolvedRoot = path.resolve(projectRoot);
	const resolvedCandidate = path.resolve(candidate);
	if (path.dirname(resolvedCandidate) !== resolvedRoot || !path.basename(resolvedCandidate).startsWith(prefix)) {
		throw new Error(`Refusing to manage unexpected harness build path: ${candidate}`);
	}
}

function preserveNonServerArtifacts(liveDist: string, stagingDir: string): void {
	if (!fs.existsSync(liveDist)) return;
	for (const entry of fs.readdirSync(liveDist, { withFileTypes: true })) {
		if (REBUILT_DIST_ENTRIES.has(entry.name)) continue;
		fs.cpSync(path.join(liveDist, entry.name), path.join(stagingDir, entry.name), {
			recursive: entry.isDirectory(),
			force: true,
		});
	}
}

/**
 * Prepare a complete replacement dist tree without touching the live tree.
 * Server/shared output is rebuilt from scratch; unrelated output such as the UI
 * is copied into the candidate so the whole dist directory can be promoted as
 * one filesystem unit after the gateway has stopped.
 */
export async function prepareStagedDistBuild(
	projectRoot: string,
	build: (stagingDir: string) => void | Promise<void>,
): Promise<StagedDistBuild> {
	const resolvedRoot = path.resolve(projectRoot);
	const liveDist = path.join(resolvedRoot, "dist");
	const stagingDir = fs.mkdtempSync(path.join(resolvedRoot, STAGING_PREFIX));
	const prepared = { projectRoot: resolvedRoot, liveDist, stagingDir };

	try {
		preserveNonServerArtifacts(liveDist, stagingDir);
		await build(stagingDir);
		if (!fs.existsSync(path.join(stagingDir, "server", "cli.js"))) {
			throw new Error("Staged server build did not produce server/cli.js");
		}
		return prepared;
	} catch (error) {
		discardStagedDistBuild(prepared);
		throw error;
	}
}

export function discardStagedDistBuild(prepared: StagedDistBuild): void {
	assertManagedSibling(prepared.projectRoot, prepared.stagingDir, STAGING_PREFIX);
	fs.rmSync(prepared.stagingDir, { recursive: true, force: true });
}

/**
 * Promote a fully prepared dist tree. The live tree is retained as a rollback
 * authority until the candidate rename succeeds. A failed candidate rename
 * restores the original tree before the error is returned.
 */
export function promoteStagedDistBuild(prepared: StagedDistBuild): void {
	const { projectRoot, liveDist, stagingDir } = prepared;
	assertManagedSibling(projectRoot, stagingDir, STAGING_PREFIX);
	const backupDir = path.join(projectRoot, `${BACKUP_PREFIX}${process.pid}-${randomUUID()}`);
	let liveMoved = false;

	try {
		if (fs.existsSync(liveDist)) {
			fs.renameSync(liveDist, backupDir);
			liveMoved = true;
		}
		fs.renameSync(stagingDir, liveDist);
	} catch (promotionError) {
		if (liveMoved && !fs.existsSync(liveDist)) {
			try {
				fs.renameSync(backupDir, liveDist);
			} catch (rollbackError) {
				throw new AggregateError(
					[promotionError, rollbackError],
					"Staged dist promotion failed and the live dist rollback also failed",
				);
			}
		}
		throw promotionError;
	}

	if (liveMoved) {
		try {
			fs.rmSync(backupDir, { recursive: true, force: true });
		} catch (error) {
			console.warn(`[harness] Could not remove previous dist backup ${backupDir}:`, error);
		}
	}
}
