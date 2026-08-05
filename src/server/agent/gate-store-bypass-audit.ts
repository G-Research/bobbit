import path from "node:path";

import type { FsLike } from "../gateway-deps.js";
import type { GateSignal } from "./gate-store.js";
import {
	GATE_STORE_SCHEMA_VERSION,
	bypassAuditDirectory,
	collectPayloadRefs,
	bypassAuditRecordPath,
	stableGateStoreId,
	type GateStoreV2BypassAuditRecord,
} from "./gate-store-v2-persistence.js";

export interface GateBypassAuditMetrics {
	files: number;
	bytes: number;
	largest: Array<{ name: string; bytes: number }>;
}

function isAuditFile(name: string): boolean {
	return /^\d{16}-[a-f0-9]{64}\.json$/.test(name);
}

function cleanupAuditTemps(fs: FsLike, file: string): void {
	const directory = path.dirname(file);
	const prefix = `${path.basename(file)}.`;
	if (!fs.existsSync(directory)) return;
	for (const name of fs.readdirSync(directory) as string[]) {
		if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
		try { fs.unlinkSync(path.join(directory, name)); } catch { /* restart cleanup is best effort */ }
	}
}

/** True only when this exact stable bypass identity was already exported. */
export function isBypassAuditRecordPublished(
	fs: FsLike,
	v2Root: string,
	goalId: string,
	gateId: string,
	signal: GateSignal,
): boolean {
	const ordinal = signal.persistenceOrdinal;
	if (ordinal === undefined || ordinal < 0 || !Number.isSafeInteger(ordinal)) return false;
	return fs.existsSync(bypassAuditRecordPath(v2Root, goalId, gateId, ordinal, signal.id));
}

/**
 * Publishes one immutable audit row. Existing rows are content-addressed by
 * signal identity + stable ordinal and are never rewritten by later gate saves.
 */
export function appendBypassAuditRecord(
	fs: FsLike,
	v2Root: string,
	goalId: string,
	gateId: string,
	signal: GateSignal,
): { bytes: number; written: boolean } {
	const ordinal = signal.persistenceOrdinal;
	if (ordinal === undefined || ordinal < 0 || !Number.isSafeInteger(ordinal)) throw new Error("bypass audit signal has no stable ordinal");
	const file = bypassAuditRecordPath(v2Root, goalId, gateId, ordinal, signal.id);
	if (fs.existsSync(file)) {
		cleanupAuditTemps(fs, file);
		return { bytes: fs.statSync(file).size, written: false };
	}
	const record: GateStoreV2BypassAuditRecord = { schemaVersion: GATE_STORE_SCHEMA_VERSION, goalId, gateId, ordinal, signal };
	const json = JSON.stringify(record);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, json, "utf8");
	try {
		fs.renameSync(tmp, file);
	} catch (error) {
		if (!fs.existsSync(file)) throw error;
	}
	cleanupAuditTemps(fs, file);
	return { bytes: Buffer.byteLength(json), written: true };
}

/** Load body-free audit rows in stable ordinal order, rejecting identity drift. */
export function loadBypassAuditRecords(fs: FsLike, v2Root: string, goalId: string, gateId: string): GateSignal[] {
	const directory = bypassAuditDirectory(v2Root, goalId, gateId);
	if (!fs.existsSync(directory)) return [];
	const rows: GateSignal[] = [];
	for (const name of (fs.readdirSync(directory) as string[]).filter(isAuditFile).sort()) {
		const parsed = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8") as string) as GateStoreV2BypassAuditRecord;
		if (parsed.schemaVersion !== GATE_STORE_SCHEMA_VERSION || parsed.goalId !== goalId || parsed.gateId !== gateId
			|| parsed.ordinal !== parsed.signal.persistenceOrdinal || parsed.signal.goalId !== goalId || parsed.signal.gateId !== gateId
			|| parsed.signal.metadata?.bypass !== "true") throw new Error(`invalid bypass audit record ${name}`);
		const expectedSuffix = `-${stableGateStoreId(parsed.signal.id)}.json`;
		if (!name.endsWith(expectedSuffix)) throw new Error(`invalid bypass audit identity ${name}`);
		rows.push(parsed.signal);
	}
	rows.sort((a, b) => (a.persistenceOrdinal ?? 0) - (b.persistenceOrdinal ?? 0) || a.id.localeCompare(b.id));
	return rows;
}

export function collectBypassAuditPayloadRefs(fs: FsLike, v2Root: string, refs = new Set<string>()): Set<string> {
	const root = path.join(v2Root, "audit");
	if (!fs.existsSync(root)) return refs;
	for (const goal of fs.readdirSync(root) as string[]) {
		if (!/^[a-f0-9]{64}$/.test(goal)) continue;
		const goalDir = path.join(root, goal);
		for (const gate of fs.readdirSync(goalDir) as string[]) {
			if (!/^[a-f0-9]{64}$/.test(gate)) continue;
			const gateDir = path.join(goalDir, gate);
			for (const name of fs.readdirSync(gateDir) as string[]) {
				if (!isAuditFile(name)) continue;
				const record = JSON.parse(fs.readFileSync(path.join(gateDir, name), "utf8") as string) as GateStoreV2BypassAuditRecord;
				collectPayloadRefs(record, refs);
			}
		}
	}
	return refs;
}

export function measureBypassAudit(fs: FsLike, v2Root: string): GateBypassAuditMetrics {
	const root = path.join(v2Root, "audit");
	if (!fs.existsSync(root)) return { files: 0, bytes: 0, largest: [] };
	let files = 0;
	let bytes = 0;
	const largest: Array<{ name: string; bytes: number }> = [];
	for (const goal of fs.readdirSync(root) as string[]) {
		if (!/^[a-f0-9]{64}$/.test(goal)) continue;
		const goalDir = path.join(root, goal);
		for (const gate of fs.readdirSync(goalDir) as string[]) {
			if (!/^[a-f0-9]{64}$/.test(gate)) continue;
			const gateDir = path.join(goalDir, gate);
			for (const name of fs.readdirSync(gateDir) as string[]) {
				if (!isAuditFile(name)) continue;
				files++;
				const size = fs.statSync(path.join(gateDir, name)).size;
				bytes += size;
				largest.push({ name: `${goal.slice(0, 8)}/${gate.slice(0, 8)}/${name}`, bytes: size });
			}
		}
	}
	largest.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
	return { files, bytes, largest: largest.slice(0, 20) };
}
