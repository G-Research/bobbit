import path from "node:path";
import { Worker } from "node:worker_threads";

import type { GateState } from "./gate-store.js";
import type { GateStoreV2Manifest } from "./gate-store-v2-persistence.js";
import {
	canonicalGateStoreStateRoot,
	coordinateGateStoreRootPreparation,
	releaseGateStoreRootPreparationClaim,
	type GateStoreRootPreparationClaim,
} from "./gate-store-root-coordinator.js";

export { canonicalGateStoreStateRoot } from "./gate-store-root-coordinator.js";

export interface GateStorePreloadedState {
	canonicalStateRoot: string;
	/** Atomic worker-to-constructor ownership of this complete loaded snapshot. */
	rootClaim?: GateStoreRootPreparationClaim;
	v2Root: string;
	manifest: GateStoreV2Manifest;
	gates: Map<string, GateState>;
	legacySignalIds: Set<string>;
	legacyPayloadRefs: Set<string>;
	auditPayloadRefs: Set<string>;
	/** Replaceable managed-payload owners keyed by the canonical goal::gate partition. */
	partitionPayloadRefs: Map<string, Set<string>>;
	reclaimedPayloadBytes: number;
	orphanPayloadBytes: number;
	orphanPayloads: number;
	reclaimFailureBytes: number;
	reclaimFailures: number;
}

export interface GateStoreMigrationWorkerResult {
	migrated: boolean;
	sourceBytes: number;
	externalizedBytes: number;
	payloadBytes: number;
	durationMs: number;
	preload: GateStorePreloadedState;
}

type GateStoreMigrationWorkerFault = "before-bypass-truth-rename" | "before-bypass-audit-rename" | "after-bypass-audit-rename";

const migrations = new Map<string, Promise<GateStoreMigrationWorkerResult>>();
const claimedPreloads = new WeakSet<GateStorePreloadedState>();
const workerFaultsForTests = new Map<string, GateStoreMigrationWorkerFault>();

/** Release a worker snapshot when its publication path is cancelled or superseded. */
export function releaseGateStorePreload(preload: GateStorePreloadedState): void {
	if (preload.rootClaim) releaseGateStoreRootPreparationClaim(preload.rootClaim);
}

/** Claim an exact worker snapshot once; completed snapshots are never cached or reused. */
export function claimGateStorePreload(stateDir: string, preload: GateStorePreloadedState): GateStorePreloadedState {
	if (canonicalGateStoreStateRoot(stateDir) !== preload.canonicalStateRoot
		|| path.basename(preload.v2Root) !== "v2"
		|| path.basename(path.dirname(preload.v2Root)) !== "gate-records"
		|| canonicalGateStoreStateRoot(path.dirname(path.dirname(preload.v2Root))) !== preload.canonicalStateRoot) {
		throw new Error("gate store preload belongs to a different physical state root");
	}
	if (claimedPreloads.has(preload)) throw new Error("gate store preload was already consumed");
	claimedPreloads.add(preload);
	return preload;
}

// Keep the worker self-contained: production runs compiled JavaScript while the
// test runner transforms TypeScript in-process and cannot resolve a sibling TS
// worker without a separate prebundle. Only the validated, body-free canonical
// snapshot crosses the MessagePort; legacy source bytes and payload bodies do not.
const MIGRATION_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const started = performance.now();
const stable = value => createHash("sha256").update(value).digest("hex");
let workerFaultInjected = false;
const injectWorkerFault = point => {
  if (workerFaultInjected || workerData.fault !== point) return;
  workerFaultInjected = true;
  throw new Error("INJECTED_GATE_V2_WORKER_" + point.toUpperCase().replaceAll("-", "_"));
};
const atomic = (file, value, faultPoint) => {
  const json = JSON.stringify(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
  if (faultPoint) injectWorkerFault(faultPoint);
  fs.renameSync(tmp, file);
  return Buffer.byteLength(json);
};
const payloadFile = (root, hash) => path.join(root, "payloads", hash.slice(0, 2), hash + ".payload");
const payload = (staging, published, content) => {
  const bytes = Buffer.byteLength(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const target = payloadFile(staging, sha256);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, content, "utf8");
    try { fs.renameSync(tmp, target); } catch (error) {
      if (!fs.existsSync(target)) throw error;
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return { ref: { kind: "gate-payload-v2", sha256, bytes, path: payloadFile(published, sha256) }, bytes };
};
const within = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};
const copyOwnedRef = (staging, published, ref) => {
  if (!ref || ref.kind !== "gate-payload-v2" || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error("invalid ref-only managed gate payload");
  const expected = payloadFile(published, ref.sha256);
  if (ref.path !== expected) throw new Error("managed gate payload reference is outside the source project root");
  let rootReal, payloadRootReal, candidateReal, stat;
  try {
    rootReal = fs.realpathSync(published);
    payloadRootReal = fs.realpathSync(path.join(published, "payloads"));
    candidateReal = fs.realpathSync(expected);
    stat = fs.statSync(candidateReal);
  } catch { throw new Error("ref-only managed gate payload is missing or unavailable"); }
  if (!within(rootReal, candidateReal) || !within(payloadRootReal, candidateReal) || !stat.isFile() || stat.size !== ref.bytes) throw new Error("ref-only managed gate payload failed ownership validation");
  const hash = createHash("sha256");
  const fd = fs.openSync(candidateReal, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
  } finally { fs.closeSync(fd); }
  if (position !== ref.bytes || hash.digest("hex") !== ref.sha256) throw new Error("ref-only managed gate payload checksum mismatch");
  const target = payloadFile(staging, ref.sha256);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + "." + process.pid + ".tmp";
    fs.copyFileSync(candidateReal, tmp);
    try { fs.renameSync(tmp, target); } catch (error) {
      if (!fs.existsSync(target)) throw error;
      try { fs.unlinkSync(tmp); } catch {}
    }
  }
  return { kind: "gate-payload-v2", sha256: ref.sha256, bytes: ref.bytes, path: expected };
};
const copyOwnedRefs = (staging, published, value) => {
  if (!value || typeof value !== "object") return value;
  if (value.kind === "gate-payload-v2") return copyOwnedRef(staging, published, value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) value[index] = copyOwnedRefs(staging, published, value[index]);
    return value;
  }
  for (const key of Object.keys(value)) value[key] = copyOwnedRefs(staging, published, value[key]);
  return value;
};
const dropSupersededRefs = signal => {
  if (signal.metadata?.bypass === "true" && signal.content) delete signal.contentRef;
  for (const [key, value] of Object.entries(signal.metadata || {})) {
    if (Buffer.byteLength(value) > 16384 && signal.auditMetadataRefs) delete signal.auditMetadataRefs[key];
  }
  if (signal.metadata?.whyBypassed && Buffer.byteLength(signal.metadata.whyBypassed) > 16384) delete signal.bypassReasonRef;
  for (const step of signal.verification?.steps || []) {
    if (step.output) delete step.outputRef;
    if (step.artifact?.content) delete step.artifact.contentRef;
    for (const artifact of step.diagnostics?.artifacts || []) if (artifact.content) delete artifact.contentRef;
  }
};
const compact = (staging, published, source) => {
  const signal = source;
  let externalized = 0;
  if (signal.metadata?.bypass === "true" && signal.content) {
    const stored = payload(staging, published, signal.content);
    signal.contentRef = stored.ref; externalized += stored.bytes; signal.content = "";
  }
  if (signal.metadata?.bypass === "true") {
    for (const [key, value] of Object.entries(signal.metadata)) {
      if (Buffer.byteLength(value) <= 16384) continue;
      const stored = payload(staging, published, value);
      signal.auditMetadataRefs ||= {}; signal.auditMetadataRefs[key] = stored.ref;
      if (key === "whyBypassed") signal.bypassReasonRef = stored.ref;
      externalized += stored.bytes;
      signal.metadata[key] = Buffer.from(value).subarray(0, 16384).toString("utf8"); signal.metadata[key + "Truncated"] = "true";
    }
  }
  for (const step of signal.verification?.steps || []) {
    if (step.output) {
      step.outputRef = payload(staging, published, step.output).ref;
      externalized += Buffer.byteLength(step.output); step.output = "";
    }
    if (step.artifact?.content) {
      const stored = payload(staging, published, step.artifact.content);
      step.artifact.contentRef = stored.ref; externalized += stored.bytes; step.artifact.content = "";
    }
    for (const artifact of step.diagnostics?.artifacts || []) {
      if (!artifact.content) continue;
      artifact.contentRef = payload(staging, published, artifact.content).ref;
      externalized += Buffer.byteLength(artifact.content); delete artifact.content;
    }
  }
  return { signal, externalized };
};
const refs = (value, out = new Set()) => {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value) refs(item, out); return out; }
  if (value.kind === "gate-payload-v2" && typeof value.sha256 === "string") out.add(value.sha256);
  for (const child of Object.values(value)) refs(child, out);
  return out;
};
const canonicalJson = value => {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
  return JSON.stringify(value);
};
const migrationRef = (published, content) => {
  const bytes = Buffer.byteLength(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { kind: "gate-payload-v2", sha256, bytes, path: payloadFile(published, sha256) };
};
const expectedCompactedSignal = (published, source) => {
  const signal = JSON.parse(JSON.stringify(source));
  let externalized = 0;
  dropSupersededRefs(signal);
  if (signal.metadata?.bypass === "true" && signal.content) {
    signal.contentRef = migrationRef(published, signal.content);
    externalized += Buffer.byteLength(signal.content); signal.content = "";
  }
  if (signal.metadata?.bypass === "true") {
    for (const [key, value] of Object.entries(signal.metadata)) {
      if (Buffer.byteLength(value) <= 16384) continue;
      const ref = migrationRef(published, value);
      signal.auditMetadataRefs ||= {}; signal.auditMetadataRefs[key] = ref;
      if (key === "whyBypassed") signal.bypassReasonRef = ref;
      externalized += Buffer.byteLength(value);
      signal.metadata[key] = Buffer.from(value).subarray(0, 16384).toString("utf8"); signal.metadata[key + "Truncated"] = "true";
    }
  }
  for (const step of signal.verification?.steps || []) {
    if (step.output) {
      step.outputRef = migrationRef(published, step.output);
      externalized += Buffer.byteLength(step.output); step.output = "";
    }
    if (step.artifact?.content) {
      step.artifact.contentRef = migrationRef(published, step.artifact.content);
      externalized += Buffer.byteLength(step.artifact.content); step.artifact.content = "";
    }
    for (const artifact of step.diagnostics?.artifacts || []) {
      if (!artifact.content) continue;
      artifact.contentRef = migrationRef(published, artifact.content);
      externalized += Buffer.byteLength(artifact.content); delete artifact.content;
    }
  }
  return { signal, externalized };
};
const collectValidatedRefs = (value, published, out) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value) collectValidatedRefs(item, published, out); return; }
  if (value.kind === "gate-payload-v2") {
    if (!/^[a-f0-9]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 0 || value.path !== payloadFile(published, value.sha256)) throw new Error("invalid managed ref contract in migrated legacy archive");
    const prior = out.get(value.sha256);
    if (prior !== undefined && prior !== value.bytes) throw new Error("conflicting managed ref byte contract in migrated legacy archive");
    out.set(value.sha256, value.bytes);
  }
  for (const child of Object.values(value)) collectValidatedRefs(child, published, out);
};
const validateLegacyCutover = (storeFile, storageRoot, publishedRoot, manifest) => {
  if (manifest.schemaVersion !== 2 || manifest.state !== "complete") throw new Error("invalid gate v2 migration manifest");
  const sourceBuffer = fs.readFileSync(storeFile);
  const sourceSha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  if (manifest.sourceFile !== "gates.json" || manifest.sourceBytes !== sourceBuffer.byteLength || manifest.sourceSha256 !== sourceSha256) throw new Error("legacy source does not match gate v2 migration manifest");
  const source = JSON.parse(sourceBuffer.toString("utf8"));
  if (!Array.isArray(source)) throw new Error("legacy gates.json is not an array");
  const byGoal = new Map(), gateKeys = new Set();
  let signalCount = 0, bypassCount = 0, externalizedBytes = 0;
  for (const gate of source) {
    if (!gate || typeof gate.goalId !== "string" || !gate.goalId || typeof gate.gateId !== "string" || !gate.gateId) throw new Error("invalid legacy gate identity at migration cutover");
    const key = gate.goalId + "::" + gate.gateId;
    if (gateKeys.has(key)) throw new Error("duplicate legacy gate identity at migration cutover " + key);
    gateKeys.add(key);
    const bucket = byGoal.get(gate.goalId) || []; bucket.push(gate); byGoal.set(gate.goalId, bucket);
  }
  const expectedInventory = [...byGoal].map(([goalId, gates]) => ({ goalId, gateIds: gates.map(gate => gate.gateId).sort() })).sort((a, b) => a.goalId.localeCompare(b.goalId));
  if (canonicalJson(manifest.inventory || []) !== canonicalJson(expectedInventory) || manifest.gateCount !== source.length) throw new Error("gate v2 manifest inventory does not match authoritative legacy source");
  const managedRefs = new Map();
  for (const [goalId, gates] of byGoal) {
    const currentFile = path.join(storageRoot, "goals", stable(goalId) + ".json");
    const legacyFile = path.join(storageRoot, "legacy", stable(goalId) + ".json");
    const current = JSON.parse(fs.readFileSync(currentFile, "utf8"));
    const legacy = JSON.parse(fs.readFileSync(legacyFile, "utf8"));
    if (current.schemaVersion !== 2 || current.goalId !== goalId || legacy.schemaVersion !== 2 || legacy.goalId !== goalId || legacy.sealed !== true) throw new Error("gate v2 migration identity validation failed for " + goalId);
    const expectedCurrent = [], expectedLegacy = [];
    for (const gate of gates) {
      const expectedSignals = [];
      for (let ordinal = 0; ordinal < (gate.signals || []).length; ordinal++) {
        const sourceSignal = JSON.parse(JSON.stringify(gate.signals[ordinal]));
        if (sourceSignal.persistenceOrdinal === undefined) sourceSignal.persistenceOrdinal = ordinal;
        const compacted = expectedCompactedSignal(publishedRoot, sourceSignal);
        expectedSignals.push(compacted.signal); externalizedBytes += compacted.externalized;
        signalCount++;
        if (sourceSignal.metadata?.bypass === "true") bypassCount++;
      }
      expectedLegacy.push({ gateId: gate.gateId, signals: expectedSignals });
      expectedCurrent.push({ ...JSON.parse(JSON.stringify(gate)), signals: [] });
    }
    if (canonicalJson(legacy.gates) !== canonicalJson(expectedLegacy)) throw new Error("sealed legacy ordering, verdict, bypass, or diagnostics metadata validation failed for " + goalId);
    const expectedTruth = new Map(expectedCurrent.map(gate => [gate.gateId, gate]));
    const currentTruth = new Map();
    for (const gate of current.gates || []) {
      if (!gate || gate.goalId !== goalId || typeof gate.gateId !== "string" || currentTruth.has(gate.gateId) || (gate.signals || []).length !== 0) throw new Error("canonical current gate identity validation failed for " + goalId);
      currentTruth.set(gate.gateId, gate);
    }
    for (const [gateId, expectedGate] of expectedTruth) {
      const actualGate = currentTruth.get(gateId);
      if (!actualGate) throw new Error("canonical current gate truth is missing " + goalId + "/" + gateId);
      if (canonicalJson(actualGate) !== canonicalJson(expectedGate) && !(Number.isFinite(actualGate.updatedAt) && actualGate.updatedAt >= manifest.migratedAt)) throw new Error("canonical current gate truth validation failed for " + goalId + "/" + gateId);
    }
    for (const [gateId, actualGate] of currentTruth) if (!expectedTruth.has(gateId) && !(Number.isFinite(actualGate.updatedAt) && actualGate.updatedAt >= manifest.migratedAt)) throw new Error("unvalidated canonical current gate identity " + goalId + "/" + gateId);
    collectValidatedRefs(legacy, publishedRoot, managedRefs);
  }
  if (manifest.signalCount !== signalCount || manifest.bypassCount !== bypassCount || manifest.externalizedBytes !== externalizedBytes) throw new Error("gate v2 manifest retained-history counts do not match authoritative legacy source");
  let payloadBytes = 0;
  for (const [hash, declaredBytes] of managedRefs) {
    const file = payloadFile(storageRoot, hash);
    let body;
    try { body = fs.readFileSync(file); } catch { throw new Error("missing migrated gate payload " + hash); }
    if (body.byteLength !== declaredBytes || createHash("sha256").update(body).digest("hex") !== hash) throw new Error("migrated gate payload byte/hash contract failed " + hash);
    payloadBytes += body.byteLength;
  }
  if (manifest.payloadBytes !== payloadBytes) throw new Error("gate v2 manifest payload bytes do not match retained managed references");
  return { sourceBytes: sourceBuffer.byteLength, sourceSha256 };
};
const canonical = value => {
  try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
};
const bindRefs = (root, value) => {
  const physicalRoot = canonical(root);
  const bind = candidate => {
    if (!candidate || typeof candidate !== "object") return candidate;
    if (Array.isArray(candidate)) {
      for (let index = candidate.length - 1; index >= 0; index--) {
        const bound = bind(candidate[index]);
        if (bound === undefined) candidate.splice(index, 1); else candidate[index] = bound;
      }
      return candidate;
    }
    if (candidate.kind === "gate-payload-v2") {
      if (!/^[a-f0-9]{64}$/.test(candidate.sha256) || !Number.isSafeInteger(candidate.bytes) || candidate.bytes < 0 || typeof candidate.path !== "string") return undefined;
      const sourcePath = path.resolve(candidate.path);
      const sourceRoot = path.dirname(path.dirname(path.dirname(sourcePath)));
      if (sourcePath !== payloadFile(sourceRoot, candidate.sha256) || canonical(sourceRoot) !== physicalRoot) return undefined;
      candidate.path = payloadFile(root, candidate.sha256);
      return candidate;
    }
    for (const key of Object.keys(candidate)) {
      const bound = bind(candidate[key]);
      if (bound === undefined) delete candidate[key]; else candidate[key] = bound;
    }
    return candidate;
  };
  return bind(value);
};
const auditFile = name => /^\d{16}-[a-f0-9]{64}\.json$/.test(name);
const auditIdentity = (gateId, signal) => gateId + "\u0000" + signal.persistenceOrdinal + "\u0000" + signal.id;
const appendAudit = (root, goalId, gateId, signal) => {
  const ordinal = signal.persistenceOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("bypass audit signal has no stable ordinal");
  const directory = path.join(root, "audit", stable(goalId), stable(gateId));
  const file = path.join(directory, String(ordinal).padStart(16, "0") + "-" + stable(signal.id) + ".json");
  if (fs.existsSync(file)) return false;
  atomic(file, { schemaVersion: 2, goalId, gateId, ordinal, signal }, "before-bypass-audit-rename");
  injectWorkerFault("after-bypass-audit-rename");
  return true;
};
const historyFile = (root, goalId, gateId) => path.join(root, "history", stable(goalId), stable(gateId) + ".json");
const repairBypassPromotion = (root, goalFile, record, partitions, auditRows, auditPayloadRefs) => {
  const sources = new Map();
  let hasEmbedded = false;
  for (const gate of record.gates || []) {
    for (const signal of [...(record.history?.[gate.gateId] || []), ...(gate.signals || [])]) {
      if (signal.metadata?.bypass !== "true") continue;
      sources.set(auditIdentity(gate.gateId, signal), { gateId: gate.gateId, signal });
      hasEmbedded = true;
    }
    const partition = partitions.get(gate.gateId)?.record;
    for (const signal of partition?.signals || []) {
      if (signal.metadata?.bypass !== "true") continue;
      sources.set(auditIdentity(gate.gateId, signal), { gateId: gate.gateId, signal });
    }
  }

  // Include already-published audit rows so a restart repairs states produced by
  // the former audit-first worker even when its embedded copy was cleaned.
  const candidates = new Map();
  for (const gate of record.gates || []) {
    const key = record.goalId + "\u0000" + gate.gateId;
    for (const signal of auditRows.get(key) || []) candidates.set(auditIdentity(gate.gateId, signal), { gateId: gate.gateId, signal });
  }
  for (const [identity, source] of sources) if (!candidates.has(identity)) candidates.set(identity, source);

  // Publish every truth repair for this goal in one atomic shard replacement
  // before publishing any immutable audit row. A newer reset wins by timestamp.
  let durable = record;
  const newestByGate = new Map();
  for (const { gateId, signal } of candidates.values()) {
    const gate = record.gates.find(candidate => candidate.gateId === gateId);
    if (!gate) throw new Error("bypass audit references missing gate " + record.goalId + "/" + gateId);
    if (gate.status === "bypassed" || !(signal.timestamp > gate.updatedAt)) continue;
    const newest = newestByGate.get(gateId);
    if (!newest || signal.timestamp > newest.timestamp || (signal.timestamp === newest.timestamp && (signal.persistenceOrdinal || 0) > (newest.persistenceOrdinal || 0))) newestByGate.set(gateId, signal);
  }
  if (newestByGate.size > 0) {
    durable = JSON.parse(JSON.stringify(record));
    for (const [gateId, signal] of newestByGate) {
      const gate = durable.gates.find(candidate => candidate.gateId === gateId);
      gate.status = "bypassed";
      gate.updatedAt = signal.timestamp;
    }
    atomic(goalFile, durable, "before-bypass-truth-rename");
  }

  for (const { gateId, signal } of sources.values()) {
    const key = durable.goalId + "\u0000" + gateId;
    const rows = auditRows.get(key) || [];
    if (appendAudit(root, durable.goalId, gateId, signal)) {
      rows.push(signal);
      auditRows.set(key, rows);
      refs(signal, auditPayloadRefs);
    }
  }

  if (hasEmbedded) {
    const cleaned = JSON.parse(JSON.stringify(durable));
    for (const gate of cleaned.gates || []) {
      gate.signals = (gate.signals || []).filter(signal => signal.metadata?.bypass !== "true");
      if (cleaned.history?.[gate.gateId]) cleaned.history[gate.gateId] = cleaned.history[gate.gateId].filter(signal => signal.metadata?.bypass !== "true");
    }
    atomic(goalFile, cleaned);
    durable = bindRefs(root, cleaned);
  }
  for (const [gateId, entry] of partitions) {
    if (!(entry.record.signals || []).some(signal => signal.metadata?.bypass === "true")) continue;
    const cleaned = { ...entry.record, signals: entry.record.signals.filter(signal => signal.metadata?.bypass !== "true") };
    atomic(entry.file, cleaned);
    partitions.set(gateId, { ...entry, record: bindRefs(root, cleaned) });
  }
  return durable;
};
const retireLegacy = (storeFile, contract) => {
  if (!fs.existsSync(storeFile)) return;
  if (!contract) throw new Error("legacy retirement requires a validated source contract");
  const source = fs.readFileSync(storeFile);
  if (source.byteLength !== contract.sourceBytes || createHash("sha256").update(source).digest("hex") !== contract.sourceSha256) throw new Error("legacy source changed after gate v2 cutover validation");
  const retired = storeFile + ".v1-retired";
  if (!fs.existsSync(retired)) { fs.renameSync(storeFile, retired); return; }
  const prior = fs.readFileSync(retired);
  if (source.length !== prior.length || !source.equals(prior)) throw new Error("legacy retirement target differs from authoritative source");
  fs.unlinkSync(storeFile);
};
const canonicalPreload = (stateDir, validateCutover = false) => {
  const root = path.join(stateDir, "gate-records", "v2");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.state !== "complete") throw new Error("invalid gate v2 manifest");
  const goalsDir = path.join(root, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });
  for (const name of fs.readdirSync(goalsDir)) {
    if (!/^[a-f0-9]{64}\.gates\.json$/.test(name)) continue;
    const stagedFile = path.join(goalsDir, name);
    const staged = bindRefs(root, JSON.parse(fs.readFileSync(stagedFile, "utf8")));
    if (staged.schemaVersion !== 2 || name !== stable(staged.goalId) + ".gates.json") throw new Error("invalid staged gate shard " + name);
    fs.renameSync(stagedFile, path.join(goalsDir, stable(staged.goalId) + ".json"));
  }
  for (const name of fs.readdirSync(goalsDir)) {
    if (/^[a-f0-9]{64}\.json(?:\.\d+)?\.tmp$/.test(name)) { try { fs.unlinkSync(path.join(goalsDir, name)); } catch {} }
  }
  const records = new Map();
  for (const name of fs.readdirSync(goalsDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort()) {
    const file = path.join(goalsDir, name);
    const record = bindRefs(root, JSON.parse(fs.readFileSync(file, "utf8")));
    if (record.schemaVersion !== 2 || !record.goalId || name !== stable(record.goalId) + ".json") throw new Error("invalid gate shard identity " + name);
    records.set(record.goalId, record);
  }
  const auditRows = new Map(), auditPayloadRefs = new Set();
  const auditRoot = path.join(root, "audit");
  if (fs.existsSync(auditRoot)) {
    for (const goalDirectory of fs.readdirSync(auditRoot).sort()) {
      if (!/^[a-f0-9]{64}$/.test(goalDirectory)) continue;
      const goalRoot = path.join(auditRoot, goalDirectory);
      for (const gateDirectory of fs.readdirSync(goalRoot).sort()) {
        if (!/^[a-f0-9]{64}$/.test(gateDirectory)) continue;
        const gateRoot = path.join(goalRoot, gateDirectory);
        for (const name of fs.readdirSync(gateRoot)) {
          if (/^\d{16}-[a-f0-9]{64}\.json\.\d+\.tmp$/.test(name)) { try { fs.unlinkSync(path.join(gateRoot, name)); } catch {} }
        }
        for (const name of fs.readdirSync(gateRoot).filter(auditFile).sort()) {
          const record = bindRefs(root, JSON.parse(fs.readFileSync(path.join(gateRoot, name), "utf8")));
          const ordinal = String(record.ordinal).padStart(16, "0");
          const expected = ordinal + "-" + stable(record.signal?.id || "") + ".json";
          if (record.schemaVersion !== 2 || stable(record.goalId) !== goalDirectory || stable(record.gateId) !== gateDirectory || record.signal?.goalId !== record.goalId || record.signal?.gateId !== record.gateId || record.signal?.persistenceOrdinal !== record.ordinal || record.signal?.metadata?.bypass !== "true" || name !== expected) throw new Error("invalid bypass audit record " + name);
          const key = record.goalId + "\u0000" + record.gateId;
          const rows = auditRows.get(key) || []; rows.push(record.signal); auditRows.set(key, rows);
          refs(record, auditPayloadRefs);
        }
      }
    }
  }
  const gates = new Map(), legacySignalIds = new Set(), legacyPayloadRefs = new Set(), partitionPayloadRefs = new Map(), gateKeys = new Set();
  for (const [goalId, loadedRecord] of records) {
    const goalFile = path.join(goalsDir, stable(goalId) + ".json");
    const partitions = new Map();
    for (const gate of loadedRecord.gates || []) {
      const partitionFile = historyFile(root, goalId, gate.gateId);
      if (!fs.existsSync(partitionFile)) continue;
      const partition = bindRefs(root, JSON.parse(fs.readFileSync(partitionFile, "utf8")));
      if (partition.schemaVersion !== 2 || partition.goalId !== goalId || partition.gateId !== gate.gateId) throw new Error("invalid gate history partition " + goalId + "/" + gate.gateId);
      partitions.set(gate.gateId, { file: partitionFile, record: partition });
    }
    const record = repairBypassPromotion(root, goalFile, loadedRecord, partitions, auditRows, auditPayloadRefs);
    records.set(goalId, record);
    for (const gate of record.gates || []) {
      const key = goalId + "\u0000" + gate.gateId;
      const rows = auditRows.get(key) || [];
      rows.sort((a, b) => (a.persistenceOrdinal || 0) - (b.persistenceOrdinal || 0) || a.id.localeCompare(b.id));
      auditRows.set(key, rows);
    }

    let legacyByGate = new Map();
    const legacyFile = path.join(root, "legacy", stable(goalId) + ".json");
    if (fs.existsSync(legacyFile)) {
      const legacy = bindRefs(root, JSON.parse(fs.readFileSync(legacyFile, "utf8")));
      if (!legacy.sealed || legacy.goalId !== goalId) throw new Error("invalid sealed legacy gate archive for " + goalId);
      refs(legacy, legacyPayloadRefs);
      legacyByGate = new Map((legacy.gates || []).map(gate => [gate.gateId, gate.signals || []]));
    }
    for (const gate of record.gates || []) {
      const auditKey = goalId + "\u0000" + gate.gateId;
      const ownerKey = goalId + "::" + gate.gateId;
      if (!gate.gateId || gate.goalId !== goalId || gateKeys.has(auditKey)) throw new Error("invalid or duplicate canonical gate " + goalId + "/" + gate.gateId);
      gateKeys.add(auditKey);
      const legacySignals = legacyByGate.get(gate.gateId) || [];
      const auditSignals = auditRows.get(auditKey) || [];
      const ownerRefs = new Set();
      // Early v2 stored history in the goal shard. Attribute those references to
      // the same replaceable gate owner as the canonical history partition.
      refs(record.history?.[gate.gateId] || [], ownerRefs);
      refs(gate.signals || [], ownerRefs);
      const partition = partitions.get(gate.gateId)?.record;
      const partitionSignals = partition?.signals || [];
      if (partition) refs(partition, ownerRefs);
      partitionPayloadRefs.set(ownerKey, ownerRefs);
      const postV2Signals = [...(record.history?.[gate.gateId] || []), ...partitionSignals, ...(gate.signals || []), ...auditSignals];
      const postV2Ids = new Set(postV2Signals.map(signal => signal.id));
      for (const signal of legacySignals) if (!postV2Ids.has(signal.id)) legacySignalIds.add(signal.id);
      const merged = [...legacySignals], indexes = new Map(merged.map((signal, index) => [signal.id, index]));
      for (const signal of postV2Signals) {
        const existing = indexes.get(signal.id);
        if (existing === undefined) { indexes.set(signal.id, merged.length); merged.push(signal); } else merged[existing] = signal;
      }
      for (let ordinal = 0; ordinal < merged.length; ordinal++) if (merged[ordinal].persistenceOrdinal === undefined) merged[ordinal].persistenceOrdinal = ordinal;
      merged.sort((a, b) => (a.persistenceOrdinal || 0) - (b.persistenceOrdinal || 0));
      gate.signals = merged; gates.set(goalId + "::" + gate.gateId, gate);
    }
  }
  const expected = new Map();
  if (validateCutover && Array.isArray(manifest.inventory)) for (const row of manifest.inventory) expected.set(row.goalId, new Set(row.gateIds || []));
  else if (validateCutover && manifest.sourceFile === "gates.json") {
    const legacyDir = path.join(root, "legacy");
    if (!fs.existsSync(legacyDir)) throw new Error("missing sealed legacy inventory");
    for (const name of fs.readdirSync(legacyDir).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const legacy = JSON.parse(fs.readFileSync(path.join(legacyDir, name), "utf8"));
      if (!legacy.sealed || name !== stable(legacy.goalId) + ".json") throw new Error("invalid sealed legacy inventory");
      expected.set(legacy.goalId, new Set((legacy.gates || []).map(gate => gate.gateId)));
    }
  }
  if (records.size < expected.size) throw new Error("canonical goal inventory does not match migration cutover");
  for (const [goalId, gateIds] of expected) {
    const record = records.get(goalId);
    if (!record) throw new Error("missing canonical goal shard " + goalId);
    const actual = new Set((record.gates || []).map(gate => gate.gateId));
    if ([...gateIds].some(id => !actual.has(id))) throw new Error("canonical gate inventory mismatch for " + goalId);
  }
  const liveRefs = new Set([...legacyPayloadRefs, ...auditPayloadRefs]);
  for (const ownerRefs of partitionPayloadRefs.values()) for (const hash of ownerRefs) liveRefs.add(hash);
  for (const hash of liveRefs) {
    const file = payloadFile(root, hash);
    let body;
    try { body = fs.readFileSync(file); } catch { throw new Error("missing canonical gate payload " + hash); }
    if (createHash("sha256").update(body).digest("hex") !== hash) throw new Error("tampered canonical gate payload " + hash);
  }
  let reclaimedPayloadBytes = 0, orphanPayloadBytes = 0, orphanPayloads = 0, reclaimFailureBytes = 0, reclaimFailures = 0;
  const reclaimDir = path.join(root, "reclaim");
  fs.mkdirSync(reclaimDir, { recursive: true });
  const payloadRoot = path.join(root, "payloads");
  if (fs.existsSync(payloadRoot)) for (const prefix of fs.readdirSync(payloadRoot)) {
    if (!/^[a-f0-9]{2}$/.test(prefix)) continue;
    const directory = path.join(payloadRoot, prefix);
    for (const name of fs.readdirSync(directory)) {
      const match = /^([a-f0-9]{64})\.payload$/.exec(name);
      if (!match || liveRefs.has(match[1])) continue;
      const source = path.join(directory, name), staged = path.join(reclaimDir, name);
      const bytes = fs.statSync(source).size; orphanPayloadBytes += bytes; orphanPayloads++;
      try { fs.renameSync(source, staged); } catch { reclaimFailureBytes += bytes; reclaimFailures++; }
    }
  }
  if (fs.existsSync(reclaimDir)) for (const name of fs.readdirSync(reclaimDir)) {
    const candidate = path.join(reclaimDir, name);
    try { const bytes = fs.statSync(candidate).size; fs.unlinkSync(candidate); reclaimedPayloadBytes += bytes; } catch { try { reclaimFailureBytes += fs.statSync(candidate).size; reclaimFailures++; } catch {} }
  }
  return { canonicalStateRoot: workerData.canonicalStateRoot, v2Root: root, manifest, gates, legacySignalIds, legacyPayloadRefs, auditPayloadRefs, partitionPayloadRefs, reclaimedPayloadBytes, orphanPayloadBytes, orphanPayloads, reclaimFailureBytes, reclaimFailures };
};
(async () => {
  const stateDir = path.resolve(workerData.stateDir);
  const storeFile = path.join(stateDir, "gates.json");
  const root = path.join(stateDir, "gate-records", "v2");
  const displacedRoot = root + ".pre-migration";
  if (!fs.existsSync(root) && fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, root);
  const manifestFile = path.join(root, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.schemaVersion !== 2 || manifest.state !== "complete") throw new Error("invalid gate v2 manifest");
    const sourceContract = fs.existsSync(storeFile) ? validateLegacyCutover(storeFile, root, root, manifest) : undefined;
    const preload = canonicalPreload(stateDir, fs.existsSync(storeFile));
    retireLegacy(storeFile, sourceContract);
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: manifest.sourceBytes || 0, externalizedBytes: manifest.externalizedBytes || 0, payloadBytes: manifest.payloadBytes || 0, durationMs: performance.now() - started, preload } });
    return;
  }
  if (!fs.existsSync(storeFile)) {
    if (fs.existsSync(root)) throw new Error("incomplete gate v2 state has no authoritative legacy source");
    const emptyStaging = root + ".staging";
    fs.rmSync(emptyStaging, { recursive: true, force: true });
    fs.mkdirSync(path.join(emptyStaging, "goals"), { recursive: true });
    fs.mkdirSync(path.join(emptyStaging, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(emptyStaging, "history"), { recursive: true });
    fs.mkdirSync(path.join(emptyStaging, "payloads"), { recursive: true });
    const now = Date.now();
    atomic(path.join(emptyStaging, "manifest.json"), { schemaVersion: 2, state: "complete", sourceFile: "none", sourceBytes: 0, sourceSha256: createHash("sha256").update("").digest("hex"), gateCount: 0, signalCount: 0, bypassCount: 0, externalizedBytes: 0, payloadBytes: 0, inventory: [], migrationMs: 0, migratedAt: now, validatedAt: now });
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(emptyStaging, root);
    const preload = canonicalPreload(stateDir, false);
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: 0, externalizedBytes: 0, payloadBytes: 0, durationMs: performance.now() - started, preload } });
    return;
  }
  const staging = root + ".staging";
  let publishedFresh = false;
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(staging, "goals"), { recursive: true });
    fs.mkdirSync(path.join(staging, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(staging, "history"), { recursive: true });
    fs.mkdirSync(path.join(staging, "payloads"), { recursive: true });
    fs.mkdirSync(path.join(staging, "audit"), { recursive: true });
    const sourceBuffer = fs.readFileSync(storeFile);
    const sourceSha256 = createHash("sha256").update(sourceBuffer).digest("hex");
    const data = JSON.parse(sourceBuffer.toString("utf8"));
    if (!Array.isArray(data)) throw new Error("legacy gates.json is not an array");
    const byGoal = new Map();
    for (const gate of data) {
      if (!gate?.gateId || !gate?.goalId) continue;
      const bucket = byGoal.get(gate.goalId) || []; bucket.push(gate); byGoal.set(gate.goalId, bucket);
    }
    let signalCount = 0, bypassCount = 0, externalizedBytes = 0;
    for (const [goalId, gates] of byGoal) {
      const legacyGates = [], currentGates = [];
      for (const gate of gates) {
        const compacted = [];
        for (let ordinal = 0; ordinal < (gate.signals || []).length; ordinal++) {
          const signal = gate.signals[ordinal];
          if (signal.persistenceOrdinal === undefined) signal.persistenceOrdinal = ordinal;
          dropSupersededRefs(signal);
          copyOwnedRefs(staging, root, signal);
          const result = compact(staging, root, signal);
          compacted.push(result.signal); externalizedBytes += result.externalized;
          if (signal.metadata?.bypass === "true") bypassCount++;
        }
        signalCount += compacted.length;
        legacyGates.push({ gateId: gate.gateId, signals: compacted });
        currentGates.push({ ...gate, signals: [] });
      }
      atomic(path.join(staging, "legacy", stable(goalId) + ".json"), { schemaVersion: 2, sealed: true, goalId, gates: legacyGates });
      atomic(path.join(staging, "goals", stable(goalId) + ".json"), { schemaVersion: 2, goalId, gates: currentGates, history: {}, retention: {} });
    }
    let payloadBytes = 0;
    const payloadRoot = path.join(staging, "payloads");
    for (const prefix of fs.readdirSync(payloadRoot)) for (const name of fs.readdirSync(path.join(payloadRoot, prefix))) payloadBytes += fs.statSync(path.join(payloadRoot, prefix, name)).size;
    const now = Date.now();
    const inventory = [...byGoal].map(([goalId, gates]) => ({ goalId, gateIds: gates.map(gate => gate.gateId).sort() })).sort((a, b) => a.goalId.localeCompare(b.goalId));
    const manifest = { schemaVersion: 2, state: "complete", sourceFile: "gates.json", sourceBytes: sourceBuffer.byteLength, sourceSha256, gateCount: data.length, signalCount, bypassCount, externalizedBytes, payloadBytes, inventory, migrationMs: performance.now() - started, migratedAt: now, validatedAt: now };
    atomic(path.join(staging, "manifest.json"), manifest);
    const validatedManifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    // One exhaustive staging validation rereads the authoritative source and
    // verifies exact truth/history plus every retained payload. Atomic rename
    // preserves those validated bytes; repeating the production-scale parse and
    // hash walk after publication only burns another full corpus of worker CPU.
    const sourceContract = validateLegacyCutover(storeFile, staging, root, validatedManifest);
    fs.mkdirSync(path.dirname(root), { recursive: true });
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    if (fs.existsSync(root)) fs.renameSync(root, displacedRoot);
    fs.renameSync(staging, root);
    publishedFresh = true;
    // Publication is not trusted until the canonical loader independently
    // validates the renamed shard inventory and every referenced payload.
    const preload = canonicalPreload(stateDir, true);
    retireLegacy(storeFile, sourceContract);
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    parentPort.postMessage({ ok: true, value: { migrated: true, sourceBytes: sourceBuffer.byteLength, externalizedBytes, payloadBytes, durationMs: performance.now() - started, preload } });
  } catch (error) {
    try {
      if (publishedFresh && fs.existsSync(storeFile) && fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
      if (!fs.existsSync(root) && fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, root);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
    throw error;
  }
})().catch(error => parentPort.postMessage({ ok: false, error: error?.stack || String(error) }));
`;

function runMigrationWorker(stateDir: string, canonicalStateRoot: string): Promise<GateStoreMigrationWorkerResult> {
	return new Promise((resolve, reject) => {
		const fault = workerFaultsForTests.get(canonicalStateRoot);
		workerFaultsForTests.delete(canonicalStateRoot);
		const worker = new Worker(MIGRATION_WORKER_SOURCE, { eval: true, workerData: { stateDir, canonicalStateRoot, fault } });
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			void worker.terminate();
			fn();
		};
		worker.on("message", (message: { ok?: boolean; value?: GateStoreMigrationWorkerResult; error?: string }) => {
			if (message.ok && message.value) finish(() => resolve(message.value!));
			else finish(() => reject(new Error(message.error ?? "gate migration worker failed")));
		});
		worker.on("error", error => finish(() => reject(error)));
		worker.on("exit", code => { if (!settled) finish(() => reject(new Error(`gate migration worker exited (${code})`))); });
	});
}

/** Install one deterministic worker publication fault for the next prepare of this isolated root. */
export function __setGateStoreMigrationWorkerFaultForTests(stateDir: string, fault?: GateStoreMigrationWorkerFault): void {
	const key = canonicalGateStoreStateRoot(stateDir);
	if (fault) workerFaultsForTests.set(key, fault);
	else workerFaultsForTests.delete(key);
}

/** Coalesce concurrent first-open attempts and fence inventory/reclaim from live publishers. */
export function prepareGateStoreMigration(stateDir: string): Promise<GateStoreMigrationWorkerResult> {
	const workerRoot = path.resolve(stateDir);
	const key = canonicalGateStoreStateRoot(workerRoot);
	const existing = migrations.get(key);
	if (existing) return existing;
	const migration = coordinateGateStoreRootPreparation(
		workerRoot,
		() => runMigrationWorker(workerRoot, key),
		result => ({
			immutable: [...result.preload.legacyPayloadRefs, ...result.preload.auditPayloadRefs],
			partitions: result.preload.partitionPayloadRefs,
		}),
	).then(({ result, claim }) => {
		result.preload.rootClaim = claim;
		return result;
	}).finally(() => migrations.delete(key));
	migrations.set(key, migration);
	return migration;
}
