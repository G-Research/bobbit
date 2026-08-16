import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TEAM_FORENSIC_RECOVERY_VERSION = 1;
export const TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE = ".team-forensic-recovery.json";
export const TEAM_FORENSIC_RECOVERY_COMPLETION_FENCE_FILE = `${TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE}.completion-pending`;

type CheckpointStatus = "running" | "complete";

interface TeamRecoveryCheckpointRecord {
	version: number;
	status: CheckpointStatus;
}

/** Durable boundary for the expensive historical team/session transcript sweep. */
export interface TeamRecoveryCheckpointStore {
	isComplete(stateDir: string): Promise<boolean>;
	begin(stateDir: string): Promise<void>;
	complete(stateDir: string): Promise<void>;
}

function checkpointPath(stateDir: string): string {
	return path.join(stateDir, TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE);
}

function completionFencePath(stateDir: string): string {
	return path.join(stateDir, TEAM_FORENSIC_RECOVERY_COMPLETION_FENCE_FILE);
}

async function syncDirectory(directory: string): Promise<void> {
	// Windows does not support opening directories through Node's FileHandle API.
	// Its rename is still the atomic publication boundary; POSIX additionally
	// flushes the directory entry where the filesystem supports directory fsync.
	if (process.platform === "win32") return;
	let handle: fs.promises.FileHandle | undefined;
	try {
		handle = await fs.promises.open(directory, "r");
		await handle.sync();
	} catch (error) {
		// Match the repository's established directory-durability policy: these
		// errors mean the platform/filesystem cannot provide this extra barrier.
		if (!["EACCES", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EPERM"].includes(
			(error as NodeJS.ErrnoException)?.code ?? "",
		)) throw error;
	} finally {
		await handle?.close();
	}
}

function isCheckpointRecord(value: unknown): value is TeamRecoveryCheckpointRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === TEAM_FORENSIC_RECOVERY_VERSION
		&& (record.status === "running" || record.status === "complete");
}

/**
 * Filesystem-backed versioned checkpoint. Writes are atomic, so a crash either
 * leaves the previous state or a valid `running`/`complete` record. Completion
 * remains fenced until its rename has passed the directory durability barrier.
 * A running, fenced, corrupt, missing, or older-version record always retries.
 */
export class FileTeamRecoveryCheckpointStore implements TeamRecoveryCheckpointStore {
	async isComplete(stateDir: string): Promise<boolean> {
		try {
			await fs.promises.access(completionFencePath(stateDir));
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return false;
		}
		try {
			const text = await fs.promises.readFile(checkpointPath(stateDir), "utf-8");
			const value: unknown = JSON.parse(text);
			return isCheckpointRecord(value) && value.status === "complete";
		} catch {
			return false;
		}
	}

	begin(stateDir: string): Promise<void> {
		return this.writeRecord(stateDir, "running");
	}

	async complete(stateDir: string): Promise<void> {
		await fs.promises.mkdir(stateDir, { recursive: true });
		const fence = completionFencePath(stateDir);
		await this.ensureCompletionFence(stateDir, fence);

		// The fence is authoritative before the visible marker can become complete.
		// If either completion acknowledgement fails, it is durably republished so
		// the next boot retries instead of trusting the visible complete record.
		await this.writeRecord(stateDir, "complete");
		try {
			await fs.promises.unlink(fence);
			await syncDirectory(stateDir);
		} catch (error) {
			try {
				await this.ensureCompletionFence(stateDir, fence);
			} catch (compensationError) {
				throw new AggregateError(
					[error, compensationError],
					"Forensic recovery checkpoint completion failed and retry authority could not be republished",
				);
			}
			throw error;
		}
	}

	private async ensureCompletionFence(stateDir: string, fence: string): Promise<void> {
		try {
			await fs.promises.access(fence);
			await syncDirectory(stateDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			await this.publish(stateDir, fence, JSON.stringify({ version: TEAM_FORENSIC_RECOVERY_VERSION, status: "completion-pending" }));
		}
	}

	private writeRecord(stateDir: string, status: CheckpointStatus): Promise<void> {
		return this.publish(
			stateDir,
			checkpointPath(stateDir),
			JSON.stringify({ version: TEAM_FORENSIC_RECOVERY_VERSION, status } satisfies TeamRecoveryCheckpointRecord),
		);
	}

	private async publish(stateDir: string, target: string, contents: string): Promise<void> {
		await fs.promises.mkdir(stateDir, { recursive: true });
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		let handle: fs.promises.FileHandle | undefined;
		try {
			handle = await fs.promises.open(temporary, "wx");
			await handle.writeFile(contents, "utf-8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await fs.promises.rename(temporary, target);
			await syncDirectory(stateDir);
		} catch (error) {
			try { await handle?.close(); } catch { /* preserve the publication error */ }
			try { await fs.promises.unlink(temporary); } catch { /* best-effort temporary cleanup */ }
			throw error;
		}
	}
}
