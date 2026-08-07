// Logical Hindsight PostgreSQL migration contract. The bridge supplies trusted
// database/runtime operations; this module never shells out, resolves credentials,
// mounts paths, or makes a storage switch on its own.

import { createHash, randomUUID } from "node:crypto";

export type MigrationStorage =
	| { kind: "managed-volume"; volume: string }
	| { kind: "external"; target: string };

export interface MigrationCompatibility {
	bankExists: boolean;
	markerPresent: boolean;
	sourcePostgresMajor: number;
	targetPostgresMajor: number;
	sourceSchemaVersion: string;
	targetSchemaVersion: string;
	freeBytes: number;
	requiredBytes: number;
}

export interface MigrationPlanInput {
	source: MigrationStorage;
	target: MigrationStorage;
	compatibility: MigrationCompatibility;
	backupDirectory: string;
	createdAt?: string;
}

export interface HindsightMigrationPlan {
	id: string;
	fingerprint: string;
	confirmation: string;
	createdAt: string;
	source: MigrationStorage;
	target: MigrationStorage;
	backup: { format: "custom"; directory: string; artifact: string };
	compatibility: Omit<MigrationCompatibility, "freeBytes" | "requiredBytes"> & { freeBytes: number; requiredBytes: number; compatible: boolean; reasons: string[] };
	rollback: { action: "restore-source-routing"; retains: ["source", "backup"] };
}

export type MigrationPlanResult =
	| { ok: true; plan: HindsightMigrationPlan }
	| { ok: false; code: "HINDSIGHT_MIGRATION_INVALID" | "HINDSIGHT_MIGRATION_INCOMPATIBLE" };

export interface LogicalMigrationRunner {
	stopWriters(signal?: AbortSignal): Promise<void>;
	dumpCustom(source: MigrationStorage, artifact: string, signal?: AbortSignal): Promise<void>;
	validateDump(artifact: string, compatibility: MigrationCompatibility, signal?: AbortSignal): Promise<void>;
	createTarget(target: MigrationStorage, signal?: AbortSignal): Promise<void>;
	restoreCustom(target: MigrationStorage, artifact: string, signal?: AbortSignal): Promise<void>;
	verify(target: MigrationStorage, signal?: AbortSignal): Promise<{ healthy: boolean; markerPresent: boolean; retainRecallReflect: boolean }>;
	switchActive(target: MigrationStorage, signal?: AbortSignal): Promise<void>;
	/** Must restore routing only; it must not delete the old source or dump. */
	restoreSourceRouting(source: MigrationStorage, signal?: AbortSignal): Promise<void>;
}

export type MigrationExecutionResult =
	| { ok: true; planId: string; fingerprint: string }
	| { ok: false; code: "HINDSIGHT_MIGRATION_CONFIRMATION_REQUIRED" | "HINDSIGHT_MIGRATION_PLAN_STALE" | "HINDSIGHT_MIGRATION_INCOMPATIBLE" | "HINDSIGHT_MIGRATION_ABORTED" | "HINDSIGHT_MIGRATION_FAILED"; rolledBack?: boolean };

function validVolume(name: string): boolean {
	return /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(name) && !name.toLowerCase().includes("pg0");
}
function validExternalTarget(target: string): boolean {
	// This is a redacted logical identity, never a connection URL.
	return /^[a-z0-9][a-z0-9_.:-]{0,255}$/i.test(target);
}
function validStorage(storage: MigrationStorage): boolean {
	return storage.kind === "managed-volume" ? validVolume(storage.volume) : validExternalTarget(storage.target);
}
function sameStorage(a: MigrationStorage, b: MigrationStorage): boolean {
	return a.kind === b.kind && (a.kind === "managed-volume" && b.kind === "managed-volume" ? a.volume === b.volume : a.kind === "external" && b.kind === "external" && a.target === b.target);
}
function safeBackupDirectory(value: string): boolean {
	return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !/[\0\r\n]/.test(value) && !value.includes("..") && !value.toLowerCase().includes("pg0");
}
function fingerprint(payload: unknown): string {
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
function abort(signal?: AbortSignal): boolean { return signal?.aborted === true; }

export function migrationConfirmationFor(plan: Pick<HindsightMigrationPlan, "fingerprint">): string {
	return `MIGRATE HINDSIGHT ${plan.fingerprint}`;
}

/** Plans are pure and redacted: no dump, DB connection, start, or storage mutation. */
export function createHindsightMigrationPlan(input: MigrationPlanInput): MigrationPlanResult {
	if (!validStorage(input.source) || !validStorage(input.target) || sameStorage(input.source, input.target) || !safeBackupDirectory(input.backupDirectory)) {
		return { ok: false, code: "HINDSIGHT_MIGRATION_INVALID" };
	}
	const compatibility = input.compatibility;
	const reasons: string[] = [];
	if (!compatibility.bankExists || !compatibility.markerPresent) reasons.push("HINDSIGHT_SOURCE_BANK_UNVERIFIED");
	if (!Number.isSafeInteger(compatibility.sourcePostgresMajor) || !Number.isSafeInteger(compatibility.targetPostgresMajor) || compatibility.targetPostgresMajor < compatibility.sourcePostgresMajor) reasons.push("HINDSIGHT_POSTGRES_INCOMPATIBLE");
	if (!compatibility.sourceSchemaVersion || !compatibility.targetSchemaVersion || compatibility.sourceSchemaVersion !== compatibility.targetSchemaVersion) reasons.push("HINDSIGHT_SCHEMA_INCOMPATIBLE");
	if (!Number.isFinite(compatibility.freeBytes) || !Number.isFinite(compatibility.requiredBytes) || compatibility.freeBytes < compatibility.requiredBytes) reasons.push("HINDSIGHT_INSUFFICIENT_SPACE");
	if (reasons.length) return { ok: false, code: "HINDSIGHT_MIGRATION_INCOMPATIBLE" };
	const createdAt = input.createdAt ?? new Date().toISOString();
	const id = `hindsight-migration-${randomUUID()}`;
	const artifact = `${input.backupDirectory.replace(/\/$/, "")}/${id}.dump`;
	const stable = { source: input.source, target: input.target, compatibility: { ...compatibility, freeBytes: Math.floor(compatibility.freeBytes), requiredBytes: Math.floor(compatibility.requiredBytes) }, backupDirectory: input.backupDirectory };
	const plan: HindsightMigrationPlan = {
		id, fingerprint: fingerprint(stable), confirmation: "", createdAt, source: input.source, target: input.target,
		backup: { format: "custom", directory: input.backupDirectory, artifact },
		compatibility: { bankExists: true, markerPresent: true, sourcePostgresMajor: compatibility.sourcePostgresMajor, targetPostgresMajor: compatibility.targetPostgresMajor, sourceSchemaVersion: compatibility.sourceSchemaVersion, targetSchemaVersion: compatibility.targetSchemaVersion, freeBytes: Math.floor(compatibility.freeBytes), requiredBytes: Math.floor(compatibility.requiredBytes), compatible: true, reasons: [] },
		rollback: { action: "restore-source-routing", retains: ["source", "backup"] },
	};
	plan.confirmation = migrationConfirmationFor(plan);
	return { ok: true, plan };
}

/** Returns an exact, redacted plan fingerprint for durable server-side comparison. */
export function verifyHindsightMigrationPlan(plan: HindsightMigrationPlan): boolean {
	const recreated = createHindsightMigrationPlan({
		source: plan.source, target: plan.target, backupDirectory: plan.backup.directory, createdAt: plan.createdAt,
		compatibility: {
			bankExists: plan.compatibility.bankExists, markerPresent: plan.compatibility.markerPresent,
			sourcePostgresMajor: plan.compatibility.sourcePostgresMajor, targetPostgresMajor: plan.compatibility.targetPostgresMajor,
			sourceSchemaVersion: plan.compatibility.sourceSchemaVersion, targetSchemaVersion: plan.compatibility.targetSchemaVersion,
			freeBytes: plan.compatibility.freeBytes, requiredBytes: plan.compatibility.requiredBytes,
		},
	});
	return recreated.ok && recreated.plan.fingerprint === plan.fingerprint && plan.confirmation === migrationConfirmationFor(plan);
}

/**
 * Performs only a logical custom-format dump/restore. On every failure after
 * writer quiescing, source routing is restored; neither the source nor backup is
 * deleted. The caller persists plan/progress state and owns authorization.
 */
export async function executeHindsightMigration(plan: HindsightMigrationPlan, confirmation: string, runner: LogicalMigrationRunner, signal?: AbortSignal): Promise<MigrationExecutionResult> {
	if (!verifyHindsightMigrationPlan(plan)) return { ok: false, code: "HINDSIGHT_MIGRATION_PLAN_STALE" };
	if (confirmation !== plan.confirmation) return { ok: false, code: "HINDSIGHT_MIGRATION_CONFIRMATION_REQUIRED" };
	if (!plan.compatibility.compatible) return { ok: false, code: "HINDSIGHT_MIGRATION_INCOMPATIBLE" };
	let writersStopped = false;
	try {
		if (abort(signal)) return { ok: false, code: "HINDSIGHT_MIGRATION_ABORTED" };
		await runner.stopWriters(signal); writersStopped = true;
		if (abort(signal)) throw new DOMException("Aborted", "AbortError");
		await runner.dumpCustom(plan.source, plan.backup.artifact, signal);
		await runner.validateDump(plan.backup.artifact, {
			bankExists: plan.compatibility.bankExists, markerPresent: plan.compatibility.markerPresent,
			sourcePostgresMajor: plan.compatibility.sourcePostgresMajor, targetPostgresMajor: plan.compatibility.targetPostgresMajor,
			sourceSchemaVersion: plan.compatibility.sourceSchemaVersion, targetSchemaVersion: plan.compatibility.targetSchemaVersion,
			freeBytes: plan.compatibility.freeBytes, requiredBytes: plan.compatibility.requiredBytes,
		}, signal);
		if (abort(signal)) throw new DOMException("Aborted", "AbortError");
		// Target mutation is intentionally delayed until the validated logical dump exists.
		await runner.createTarget(plan.target, signal);
		await runner.restoreCustom(plan.target, plan.backup.artifact, signal);
		const verified = await runner.verify(plan.target, signal);
		if (!verified.healthy || !verified.markerPresent || !verified.retainRecallReflect) throw new Error("HINDSIGHT_MIGRATION_VERIFY_FAILED");
		await runner.switchActive(plan.target, signal);
		return { ok: true, planId: plan.id, fingerprint: plan.fingerprint };
	} catch (error) {
		let rolledBack = false;
		if (writersStopped) {
			try { await runner.restoreSourceRouting(plan.source, signal); rolledBack = true; } catch { /* stable result below */ }
		}
		return { ok: false, code: abort(signal) || (error instanceof DOMException && error.name === "AbortError") ? "HINDSIGHT_MIGRATION_ABORTED" : "HINDSIGHT_MIGRATION_FAILED", ...(writersStopped ? { rolledBack } : {}) };
	}
}
