import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const TEAM_FORENSIC_RECOVERY_VERSION = 1;
export const TEAM_FORENSIC_RECOVERY_CHECKPOINT_FILE = ".team-forensic-recovery.json";

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

function isCheckpointRecord(value: unknown): value is TeamRecoveryCheckpointRecord {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return record.version === TEAM_FORENSIC_RECOVERY_VERSION
		&& (record.status === "running" || record.status === "complete");
}

/**
 * Filesystem-backed versioned checkpoint. Writes are atomic, so a crash either
 * leaves the previous state or a valid `running`/`complete` record. A running,
 * corrupt, missing, or older-version record always causes recovery to run.
 */
export class FileTeamRecoveryCheckpointStore implements TeamRecoveryCheckpointStore {
	async isComplete(stateDir: string): Promise<boolean> {
		try {
			const text = await fs.promises.readFile(checkpointPath(stateDir), "utf-8");
			const value: unknown = JSON.parse(text);
			return isCheckpointRecord(value) && value.status === "complete";
		} catch {
			return false;
		}
	}

	begin(stateDir: string): Promise<void> {
		return this.write(stateDir, "running");
	}

	complete(stateDir: string): Promise<void> {
		return this.write(stateDir, "complete");
	}

	private async write(stateDir: string, status: CheckpointStatus): Promise<void> {
		await fs.promises.mkdir(stateDir, { recursive: true });
		const target = checkpointPath(stateDir);
		const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
		try {
			await fs.promises.writeFile(
				temporary,
				JSON.stringify({ version: TEAM_FORENSIC_RECOVERY_VERSION, status } satisfies TeamRecoveryCheckpointRecord),
				{ encoding: "utf-8", flag: "wx" },
			);
			await fs.promises.rename(temporary, target);
		} catch (error) {
			try { await fs.promises.unlink(temporary); } catch { /* best-effort temporary cleanup */ }
			throw error;
		}
	}
}
