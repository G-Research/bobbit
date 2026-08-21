import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const STAGING_PREFIX = ".bobbit-dist-stage-";
const BACKUP_PREFIX = ".bobbit-dist-previous-";
const PROMOTION_JOURNAL_FILE = ".bobbit-dist-promotion.json";
const PROMOTION_JOURNAL_PHASE = "live-moved";
const REBUILT_DIST_ENTRIES = new Set(["server", "shared"]);
const REQUIRED_SERVER_ENTRYPOINTS = ["cli.js", "harness.js", "watchdog.js"] as const;
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"]);

export interface StagedDistBuild {
	projectRoot: string;
	liveDist: string;
	stagingDir: string;
}

interface DistPromotionJournal {
	version: 1;
	/**
	 * Durable recovery obligation published before the live rename. The name
	 * describes the state bootstrap must recover, including a host exit on the
	 * instruction immediately after publication and before the rename itself.
	 */
	phase: typeof PROMOTION_JOURNAL_PHASE;
	hadLive: boolean;
	stagingDir: string;
	backupDir?: string;
}

function assertManagedSibling(projectRoot: string, candidate: string, prefix: string): void {
	const resolvedRoot = path.resolve(projectRoot);
	const resolvedCandidate = path.resolve(candidate);
	if (path.dirname(resolvedCandidate) !== resolvedRoot || !path.basename(resolvedCandidate).startsWith(prefix)) {
		throw new Error(`Refusing to manage unexpected harness build path: ${candidate}`);
	}
}

function syncDirectory(directory: string): void {
	if (process.platform === "win32") return;
	let fd: number | undefined;
	try {
		fd = fs.openSync(directory, fs.constants.O_RDONLY);
		fs.fsyncSync(fd);
	} catch (error) {
		if (!UNSUPPORTED_DIRECTORY_SYNC.has((error as NodeJS.ErrnoException)?.code ?? "")) throw error;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

function writePromotionJournal(projectRoot: string, journal: DistPromotionJournal): string {
	const target = path.join(projectRoot, PROMOTION_JOURNAL_FILE);
	if (fs.existsSync(target)) {
		throw new Error(`A previous dist promotion journal still requires bootstrap recovery: ${target}`);
	}
	const temporary = path.join(projectRoot, `${PROMOTION_JOURNAL_FILE}.${process.pid}.${randomUUID()}.tmp`);
	let fd: number | undefined;
	try {
		fd = fs.openSync(temporary, "wx", 0o600);
		fs.writeFileSync(fd, `${JSON.stringify(journal)}\n`, "utf8");
		fs.fsyncSync(fd);
		fs.closeSync(fd);
		fd = undefined;
		fs.renameSync(temporary, target);
		syncDirectory(projectRoot);
		return target;
	} catch (error) {
		if (fd !== undefined) {
			try { fs.closeSync(fd); } catch { /* preserve the publication error */ }
		}
		try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort unpublished temp cleanup */ }
		throw error;
	}
}

function removePromotionJournal(journalPath: string, projectRoot: string): void {
	fs.rmSync(journalPath, { force: true });
	syncDirectory(projectRoot);
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
		for (const entrypoint of REQUIRED_SERVER_ENTRYPOINTS) {
			if (!fs.existsSync(path.join(stagingDir, "server", entrypoint))) {
				throw new Error(`Staged server build did not produce server/${entrypoint}`);
			}
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
 * Promote a fully prepared dist tree. Before either directory rename, a
 * fsynced journal outside dist records the exact backup and candidate paths.
 * The stable scripts/harness-bootstrap.mjs entry point can therefore finish or
 * roll back promotion even if the harness or host terminates between renames.
 */
export function promoteStagedDistBuild(prepared: StagedDistBuild): void {
	const { projectRoot, liveDist, stagingDir } = prepared;
	assertManagedSibling(projectRoot, stagingDir, STAGING_PREFIX);
	const backupDir = path.join(projectRoot, `${BACKUP_PREFIX}${process.pid}-${randomUUID()}`);
	const hadLive = fs.existsSync(liveDist);
	const journalPath = writePromotionJournal(projectRoot, {
		version: 1,
		phase: PROMOTION_JOURNAL_PHASE,
		hadLive,
		stagingDir: path.basename(stagingDir),
		...(hadLive ? { backupDir: path.basename(backupDir) } : {}),
	});
	let liveMoved = false;

	try {
		if (hadLive) {
			fs.renameSync(liveDist, backupDir);
			liveMoved = true;
			syncDirectory(projectRoot);
		}
		fs.renameSync(stagingDir, liveDist);
		syncDirectory(projectRoot);
	} catch (promotionError) {
		if (liveMoved && !fs.existsSync(liveDist)) {
			try {
				fs.renameSync(backupDir, liveDist);
				syncDirectory(projectRoot);
				removePromotionJournal(journalPath, projectRoot);
			} catch (rollbackError) {
				throw new AggregateError(
					[promotionError, rollbackError],
					"Staged dist promotion failed and the live dist rollback also failed; bootstrap recovery remains journaled",
				);
			}
		} else if (!liveMoved && fs.existsSync(liveDist)) {
			try { removePromotionJournal(journalPath, projectRoot); } catch { /* stable bootstrap can clean it */ }
		}
		throw promotionError;
	}

	// Candidate is now the validated live tree. Cleanup stays journaled until all
	// stale authorities are gone, so an abrupt exit during cleanup is retryable.
	try {
		if (hadLive) {
			fs.rmSync(backupDir, { recursive: true, force: true });
			syncDirectory(projectRoot);
		}
		removePromotionJournal(journalPath, projectRoot);
	} catch (error) {
		console.warn(`[harness] Dist promotion committed; bootstrap will retry stale backup/journal cleanup:`, error);
	}
}
