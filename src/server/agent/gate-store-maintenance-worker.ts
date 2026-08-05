import path from "node:path";
import { Worker } from "node:worker_threads";

export const GATE_STORE_MAINTENANCE_TOP_K = 20;
export const GATE_STORE_MAINTENANCE_FRESH_MS = 5_000;
export const GATE_STORE_MAINTENANCE_STALE_MS = 60_000;
export const GATE_STORE_MAINTENANCE_RETRY_MS = 1_000;
const GATE_STORE_MAINTENANCE_TIMEOUT_MS = 5_000;

export type GateStoreMaintenanceEntryKind = "goal" | "history" | "legacy" | "audit" | "payload" | "reclaim";

export interface GateStoreMaintenanceEntry {
	name: string;
	kind: GateStoreMaintenanceEntryKind;
	bytes: number;
	exceedsLimit: boolean;
}

export interface GateStoreMaintenanceTotals {
	goalBytes: number;
	historyBytes: number;
	legacyBytes: number;
	auditBytes: number;
	payloadBytes: number;
	orphanPayloadBytes: number;
	reclaimBytes: number;
	goalShards: number;
	historyShards: number;
	legacyShards: number;
	auditRecords: number;
	payloads: number;
	orphanPayloads: number;
	reclaimFiles: number;
}

export interface GateStoreMaintenanceInventory {
	schemaVersion: number;
	migration: {
		state: "complete";
		sourceBytes: number;
		gateCount: number;
		signalCount: number;
		externalizedBytes: number;
		payloadBytes: number;
		migratedAt: number;
		validatedAt: number;
	};
	totals: GateStoreMaintenanceTotals;
	staleStaging: boolean;
	largest: GateStoreMaintenanceEntry[];
	scan: {
		id: string;
		generatedAt: number;
		peakRetainedEntries: number;
	};
}

export type GateStoreMaintenanceScanSource = "scan" | "coalesced" | "cache" | "stale";

export interface GateStoreMaintenanceScanResult extends GateStoreMaintenanceInventory {
	scan: GateStoreMaintenanceInventory["scan"] & {
		source: GateStoreMaintenanceScanSource;
		ageMs: number;
		freshUntil: number;
		staleUntil: number;
		fresh: boolean;
		stale: boolean;
		retryable?: boolean;
	};
}

export interface GateStoreMaintenanceUnavailable {
	error: "Gate store maintenance report unavailable";
	scan: {
		source: "unavailable";
		retryable: true;
		failedAt: number;
		retryAfterMs: number;
	};
}

interface CachedInventory {
	inventory: GateStoreMaintenanceInventory;
	freshUntil: number;
	staleUntil: number;
}

interface ScanOptions {
	/** Test seam for expiry policy; worker timestamps always use the real clock. */
	now?: () => number;
}

const cache = new Map<string, CachedInventory>();
const scans = new Map<string, Promise<GateStoreMaintenanceInventory>>();
const generations = new Map<string, number>();

// The worker owns every directory walk and stat. Its heap retains at most 20
// candidates even when the store contains millions of audit or payload files.
const MAINTENANCE_WORKER_SOURCE = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { parentPort, workerData } = require("node:worker_threads");

const TOP_K = 20;
const ORDINARY_BYTES_LIMIT = 8 * 1024 * 1024;
const AUDIT_BYTES_LIMIT = 64 * 1024;
const root = workerData.v2Root;
const totals = { goalBytes: 0, historyBytes: 0, legacyBytes: 0, auditBytes: 0, payloadBytes: 0, orphanPayloadBytes: 0, reclaimBytes: 0, goalShards: 0, historyShards: 0, legacyShards: 0, auditRecords: 0, payloads: 0, orphanPayloads: 0, reclaimFiles: 0 };
const heap = [];
const referencedPayloads = new Set();
let peakRetainedEntries = 0;
function collectRefs(value) {
  if (!value || typeof value !== "object") return;
  if (value.kind === "gate-payload-v2" && /^[a-f0-9]{64}$/.test(value.sha256 || "")) referencedPayloads.add(value.sha256);
  if (Array.isArray(value)) { for (const item of value) collectRefs(item); return; }
  for (const child of Object.values(value)) collectRefs(child);
}

// "Worse" means this entry belongs nearer the min-heap root and is the first
// one discarded. For equal sizes, later names lose the deterministic tie.
function worse(a, b) {
  return a.bytes < b.bytes || (a.bytes === b.bytes && a.name.localeCompare(b.name) > 0);
}
function swap(a, b) { const value = heap[a]; heap[a] = heap[b]; heap[b] = value; }
function bubbleUp(index) {
  while (index > 0) {
    const parent = Math.floor((index - 1) / 2);
    if (!worse(heap[index], heap[parent])) break;
    swap(index, parent);
    index = parent;
  }
}
function bubbleDown(index) {
  for (;;) {
    const left = index * 2 + 1;
    const right = left + 1;
    let next = index;
    if (left < heap.length && worse(heap[left], heap[next])) next = left;
    if (right < heap.length && worse(heap[right], heap[next])) next = right;
    if (next === index) return;
    swap(index, next);
    index = next;
  }
}
function retain(entry) {
  if (heap.length < TOP_K) {
    heap.push(entry);
    bubbleUp(heap.length - 1);
    peakRetainedEntries = Math.max(peakRetainedEntries, heap.length);
    return;
  }
  if (!worse(heap[0], entry)) return;
  heap[0] = entry;
  bubbleDown(0);
}
async function* entries(directory) {
  let handle;
  try { handle = await fs.opendir(directory); }
  catch (error) { if (error && error.code === "ENOENT") return; throw error; }
  for await (const item of handle) yield item;
}
async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error && error.code === "ENOENT") return false; throw error; }
}
async function scanFlat(directory, kind) {
  for await (const item of entries(directory)) {
    if (!/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
    if (!item.isFile()) throw new Error("invalid gate maintenance shard");
    const file = path.join(directory, item.name);
    const bytes = (await fs.stat(file)).size;
    if (kind === "goal") { totals.goalBytes += bytes; totals.goalShards++; }
    else { totals.legacyBytes += bytes; totals.legacyShards++; }
    try { collectRefs(JSON.parse(await fs.readFile(file, "utf8"))); } catch {}
    retain({ name: item.name, kind, bytes, exceedsLimit: kind === "goal" && bytes > ORDINARY_BYTES_LIMIT });
  }
}
async function scanHistory() {
  const historyRoot = path.join(root, "history");
  for await (const goal of entries(historyRoot)) {
    if (!/^[a-f0-9]{64}$/.test(goal.name)) continue;
    if (!goal.isDirectory()) throw new Error("invalid gate maintenance history goal");
    const directory = path.join(historyRoot, goal.name);
    for await (const item of entries(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(item.name)) continue;
      if (!item.isFile()) throw new Error("invalid gate maintenance history shard");
      const file = path.join(directory, item.name);
      const bytes = (await fs.stat(file)).size;
      totals.historyBytes += bytes; totals.historyShards++;
      try { collectRefs(JSON.parse(await fs.readFile(file, "utf8"))); } catch {}
      retain({ name: goal.name.slice(0, 8) + "/" + item.name, kind: "history", bytes, exceedsLimit: bytes > ORDINARY_BYTES_LIMIT });
    }
  }
}
async function scanAudit() {
  const auditRoot = path.join(root, "audit");
  for await (const goal of entries(auditRoot)) {
    if (!/^[a-f0-9]{64}$/.test(goal.name)) continue;
    if (!goal.isDirectory()) throw new Error("invalid gate maintenance audit goal");
    const goalRoot = path.join(auditRoot, goal.name);
    for await (const gate of entries(goalRoot)) {
      if (!/^[a-f0-9]{64}$/.test(gate.name)) continue;
      if (!gate.isDirectory()) throw new Error("invalid gate maintenance audit gate");
      const gateRoot = path.join(goalRoot, gate.name);
      for await (const item of entries(gateRoot)) {
        if (!/^\d{16}-[a-f0-9]{64}\.json$/.test(item.name)) continue;
        if (!item.isFile()) throw new Error("invalid gate maintenance audit row");
        const file = path.join(gateRoot, item.name);
        const bytes = (await fs.stat(file)).size;
        totals.auditBytes += bytes;
        totals.auditRecords++;
        try { collectRefs(JSON.parse(await fs.readFile(file, "utf8"))); } catch {}
        retain({ name: goal.name.slice(0, 8) + "/" + gate.name.slice(0, 8) + "/" + item.name, kind: "audit", bytes, exceedsLimit: bytes > AUDIT_BYTES_LIMIT });
      }
    }
  }
}
async function scanPayloads() {
  const payloadRoot = path.join(root, "payloads");
  for await (const prefix of entries(payloadRoot)) {
    if (!/^[a-f0-9]{2}$/.test(prefix.name)) continue;
    // A valid-looking prefix is structural state, so a file here is corruption
    // rather than an ignorable unknown. readdir makes the failure explicit.
    const directory = path.join(payloadRoot, prefix.name);
    if (!prefix.isDirectory()) throw new Error("invalid gate maintenance payload prefix");
    for await (const item of entries(directory)) {
      if (!/^[a-f0-9]{64}\.payload$/.test(item.name)) continue;
      if (!item.isFile()) throw new Error("invalid gate maintenance payload");
      const bytes = (await fs.stat(path.join(directory, item.name))).size;
      totals.payloadBytes += bytes;
      totals.payloads++;
      const hash = item.name.slice(0, -".payload".length);
      const orphan = !referencedPayloads.has(hash);
      if (orphan) { totals.orphanPayloadBytes += bytes; totals.orphanPayloads++; }
      retain({ name: item.name, kind: "payload", bytes, exceedsLimit: orphan });
    }
  }
}
async function scanReclaim() {
  for await (const item of entries(path.join(root, "reclaim"))) {
    if (!/^[a-f0-9]{64}\.payload$/.test(item.name)) continue;
    if (!item.isFile()) throw new Error("invalid gate reclaim staging file");
    const bytes = (await fs.stat(path.join(root, "reclaim", item.name))).size;
    totals.reclaimBytes += bytes; totals.reclaimFiles++;
    retain({ name: item.name, kind: "reclaim", bytes, exceedsLimit: true });
  }
}
(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.state !== "complete") throw new Error("invalid gate maintenance manifest");
  await scanFlat(path.join(root, "goals"), "goal");
  await scanFlat(path.join(root, "legacy"), "legacy");
  await scanHistory();
  await scanAudit();
  await scanPayloads();
  await scanReclaim();
  const largest = heap.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const generatedAt = Date.now();
  parentPort.postMessage({ ok: true, value: {
    schemaVersion: manifest.schemaVersion,
    migration: {
      state: manifest.state,
      sourceBytes: manifest.sourceBytes,
      gateCount: manifest.gateCount,
      signalCount: manifest.signalCount,
      externalizedBytes: manifest.externalizedBytes,
      payloadBytes: manifest.payloadBytes,
      migratedAt: manifest.migratedAt,
      validatedAt: manifest.validatedAt,
    },
    totals,
    staleStaging: await exists(root + ".staging"),
    largest,
    scan: { id: crypto.randomUUID(), generatedAt, peakRetainedEntries },
  }});
})().catch(() => parentPort.postMessage({ ok: false }));
`;

function rootKey(v2Root: string): string {
	const resolved = path.resolve(v2Root);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function runInventoryWorker(v2Root: string): Promise<GateStoreMaintenanceInventory> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(MAINTENANCE_WORKER_SOURCE, { eval: true, workerData: { v2Root: path.resolve(v2Root) } });
		let settled = false;
		const timeout = setTimeout(() => finish(() => reject(new Error("gate maintenance worker timed out"))), GATE_STORE_MAINTENANCE_TIMEOUT_MS);
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			void worker.terminate();
			fn();
		};
		worker.on("message", (message: { ok?: boolean; value?: GateStoreMaintenanceInventory }) => {
			if (message.ok && message.value) finish(() => resolve(message.value!));
			else finish(() => reject(new Error("gate maintenance worker failed")));
		});
		worker.on("error", () => finish(() => reject(new Error("gate maintenance worker failed"))));
		worker.on("exit", code => {
			if (!settled) finish(() => reject(new Error(`gate maintenance worker exited (${code})`)));
		});
	});
}

function projectResult(cached: CachedInventory, source: GateStoreMaintenanceScanSource, now: number): GateStoreMaintenanceScanResult {
	const stale = now > cached.freshUntil;
	return {
		...structuredClone(cached.inventory),
		scan: {
			...cached.inventory.scan,
			source,
			ageMs: Math.max(0, now - cached.inventory.scan.generatedAt),
			freshUntil: cached.freshUntil,
			staleUntil: cached.staleUntil,
			fresh: !stale,
			stale,
			...(source === "stale" ? { retryable: true as const } : {}),
		},
	};
}

/**
 * Return one root-scoped worker inventory. Concurrent callers join a single
 * scan; failures use only a bounded stale cache and never traverse on-thread.
 */
export async function getGateStoreMaintenanceInventory(
	v2Root: string,
	options: ScanOptions = {},
): Promise<GateStoreMaintenanceScanResult | GateStoreMaintenanceUnavailable> {
	const key = rootKey(v2Root);
	const now = options.now?.() ?? Date.now();
	const cached = cache.get(key);
	if (cached && now <= cached.freshUntil) return projectResult(cached, "cache", now);

	const existing = scans.get(key);
	if (existing) {
		try {
			const inventory = await existing;
			const published = cache.get(key) ?? {
				inventory,
				freshUntil: inventory.scan.generatedAt + GATE_STORE_MAINTENANCE_FRESH_MS,
				staleUntil: inventory.scan.generatedAt + GATE_STORE_MAINTENANCE_STALE_MS,
			};
			return projectResult(published, "coalesced", options.now?.() ?? Date.now());
		} catch {
			const stale = cache.get(key);
			const failedAt = options.now?.() ?? Date.now();
			if (stale && failedAt <= stale.staleUntil) return projectResult(stale, "stale", failedAt);
			return unavailable(failedAt);
		}
	}

	const generation = generations.get(key) ?? 0;
	const scan = runInventoryWorker(v2Root);
	scans.set(key, scan);
	try {
		const inventory = await scan;
		const published: CachedInventory = {
			inventory,
			freshUntil: inventory.scan.generatedAt + GATE_STORE_MAINTENANCE_FRESH_MS,
			staleUntil: inventory.scan.generatedAt + GATE_STORE_MAINTENANCE_STALE_MS,
		};
		if ((generations.get(key) ?? 0) === generation) cache.set(key, published);
		return projectResult(published, "scan", options.now?.() ?? Date.now());
	} catch {
		const stale = cache.get(key);
		const failedAt = options.now?.() ?? Date.now();
		if (stale && failedAt <= stale.staleUntil) return projectResult(stale, "stale", failedAt);
		return unavailable(failedAt);
	} finally {
		if (scans.get(key) === scan) scans.delete(key);
	}
}

function unavailable(failedAt: number): GateStoreMaintenanceUnavailable {
	return {
		error: "Gate store maintenance report unavailable",
		scan: { source: "unavailable", retryable: true, failedAt, retryAfterMs: GATE_STORE_MAINTENANCE_RETRY_MS },
	};
}

/** Drop a root's fresh/stale inventory after a durable filesystem publication. */
export function invalidateGateStoreMaintenanceInventory(v2Root: string): void {
	const key = rootKey(v2Root);
	cache.delete(key);
	generations.set(key, (generations.get(key) ?? 0) + 1);
}
