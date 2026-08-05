import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";

import type { GateState } from "./gate-store.js";
import type { GateStoreV2Manifest } from "./gate-store-v2-persistence.js";

export interface GateStorePreloadedState {
	canonicalStateRoot: string;
	v2Root: string;
	manifest: GateStoreV2Manifest;
	gates: Map<string, GateState>;
	legacySignalIds: Set<string>;
	legacyPayloadRefs: Set<string>;
	auditPayloadRefs: Set<string>;
	goalPayloadRefs: Map<string, Set<string>>;
	reclaimedPayloadBytes: number;
}

export interface GateStoreMigrationWorkerResult {
	migrated: boolean;
	sourceBytes: number;
	externalizedBytes: number;
	payloadBytes: number;
	durationMs: number;
	preload: GateStorePreloadedState;
}

const migrations = new Map<string, Promise<GateStoreMigrationWorkerResult>>();
const claimedPreloads = new WeakSet<GateStorePreloadedState>();

/** Physical identity used for worker coalescing and preload handoff validation. */
export function canonicalGateStoreStateRoot(stateDir: string): string {
	const resolved = path.resolve(stateDir);
	try { return fs.realpathSync.native(resolved); } catch { return resolved; }
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
const atomic = (file, value) => {
  const json = JSON.stringify(value);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, json, "utf8");
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
      const retained = step.diagnostics && [step.diagnostics.stdout?.path, step.diagnostics.stderr?.path].some(file => file && fs.existsSync(file));
      if (!retained) step.outputRef = payload(staging, published, step.output).ref;
      externalized += Buffer.byteLength(step.output); step.output = "";
    }
    if (step.artifact?.content) {
      const stored = payload(staging, published, step.artifact.content);
      step.artifact.contentRef = stored.ref; externalized += stored.bytes; step.artifact.content = "";
    }
    for (const artifact of step.diagnostics?.artifacts || []) {
      if (!artifact.content) continue;
      if (!fs.existsSync(artifact.path)) artifact.contentRef = payload(staging, published, artifact.content).ref;
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
const canonical = value => { try { return fs.realpathSync.native(value); } catch { return path.resolve(value); } };
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
const appendAudit = (root, goalId, gateId, signal) => {
  const ordinal = signal.persistenceOrdinal;
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("bypass audit signal has no stable ordinal");
  const directory = path.join(root, "audit", stable(goalId), stable(gateId));
  const file = path.join(directory, String(ordinal).padStart(16, "0") + "-" + stable(signal.id) + ".json");
  if (fs.existsSync(file)) return;
  atomic(file, { schemaVersion: 2, goalId, gateId, ordinal, signal });
};
const repairEmbeddedAudit = (root, file, record) => {
  let found = false;
  for (const gate of record.gates || []) {
    for (const signal of [...(record.history?.[gate.gateId] || []), ...(gate.signals || [])]) {
      if (signal.metadata?.bypass !== "true") continue;
      appendAudit(root, record.goalId, gate.gateId, signal); found = true;
    }
  }
  if (!found) return record;
  for (const gate of record.gates || []) {
    gate.signals = (gate.signals || []).filter(signal => signal.metadata?.bypass !== "true");
    if (record.history?.[gate.gateId]) record.history[gate.gateId] = record.history[gate.gateId].filter(signal => signal.metadata?.bypass !== "true");
  }
  atomic(file, record);
  return record;
};
const canonicalPreload = stateDir => {
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
    let record = bindRefs(root, JSON.parse(fs.readFileSync(file, "utf8")));
    if (record.schemaVersion !== 2 || !record.goalId || name !== stable(record.goalId) + ".json") throw new Error("invalid gate shard identity " + name);
    record = repairEmbeddedAudit(root, file, record);
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
  for (const rows of auditRows.values()) rows.sort((a, b) => (a.persistenceOrdinal || 0) - (b.persistenceOrdinal || 0) || a.id.localeCompare(b.id));
  const gates = new Map(), legacySignalIds = new Set(), legacyPayloadRefs = new Set(), goalPayloadRefs = new Map(), gateKeys = new Set();
  for (const [goalId, record] of records) {
    let legacyByGate = new Map();
    const legacyFile = path.join(root, "legacy", stable(goalId) + ".json");
    if (fs.existsSync(legacyFile)) {
      const legacy = bindRefs(root, JSON.parse(fs.readFileSync(legacyFile, "utf8")));
      if (!legacy.sealed || legacy.goalId !== goalId) throw new Error("invalid sealed legacy gate archive for " + goalId);
      refs(legacy, legacyPayloadRefs);
      legacyByGate = new Map((legacy.gates || []).map(gate => [gate.gateId, gate.signals || []]));
    }
    goalPayloadRefs.set(goalId, refs(record));
    for (const gate of record.gates || []) {
      const key = goalId + "\u0000" + gate.gateId;
      if (!gate.gateId || gate.goalId !== goalId || gateKeys.has(key)) throw new Error("invalid or duplicate canonical gate " + goalId + "/" + gate.gateId);
      gateKeys.add(key);
      const legacySignals = legacyByGate.get(gate.gateId) || [];
      const auditSignals = auditRows.get(key) || [];
      const postV2Signals = [...(record.history?.[gate.gateId] || []), ...(gate.signals || []), ...auditSignals];
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
  let reclaimedPayloadBytes = 0;
  const reclaimDir = path.join(root, "reclaim");
  if (fs.existsSync(reclaimDir)) for (const name of fs.readdirSync(reclaimDir)) {
    const candidate = path.join(reclaimDir, name);
    try { reclaimedPayloadBytes += fs.statSync(candidate).size; fs.unlinkSync(candidate); } catch {}
  }
  return { canonicalStateRoot: canonical(stateDir), v2Root: root, manifest, gates, legacySignalIds, legacyPayloadRefs, auditPayloadRefs, goalPayloadRefs, reclaimedPayloadBytes };
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
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    if (fs.existsSync(storeFile)) { try { fs.renameSync(storeFile, storeFile + ".v1-retired"); } catch {} }
    const preload = canonicalPreload(stateDir);
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: manifest.sourceBytes || 0, externalizedBytes: manifest.externalizedBytes || 0, payloadBytes: manifest.payloadBytes || 0, durationMs: performance.now() - started, preload } });
    return;
  }
  if (!fs.existsSync(storeFile)) {
    if (fs.existsSync(root)) throw new Error("incomplete gate v2 state has no authoritative legacy source");
    const emptyStaging = root + ".staging";
    fs.rmSync(emptyStaging, { recursive: true, force: true });
    fs.mkdirSync(path.join(emptyStaging, "goals"), { recursive: true });
    fs.mkdirSync(path.join(emptyStaging, "legacy"), { recursive: true });
    fs.mkdirSync(path.join(emptyStaging, "payloads"), { recursive: true });
    const now = Date.now();
    atomic(path.join(emptyStaging, "manifest.json"), { schemaVersion: 2, state: "complete", sourceFile: "none", sourceBytes: 0, sourceSha256: createHash("sha256").update("").digest("hex"), gateCount: 0, signalCount: 0, bypassCount: 0, externalizedBytes: 0, payloadBytes: 0, migrationMs: 0, migratedAt: now, validatedAt: now });
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.renameSync(emptyStaging, root);
    const preload = canonicalPreload(stateDir);
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: 0, externalizedBytes: 0, payloadBytes: 0, durationMs: performance.now() - started, preload } });
    return;
  }
  const staging = root + ".staging";
  fs.rmSync(staging, { recursive: true, force: true });
  try {
    fs.mkdirSync(path.join(staging, "goals"), { recursive: true });
    fs.mkdirSync(path.join(staging, "legacy"), { recursive: true });
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
    const manifest = { schemaVersion: 2, state: "complete", sourceFile: "gates.json", sourceBytes: sourceBuffer.byteLength, sourceSha256, gateCount: data.length, signalCount, bypassCount, externalizedBytes, payloadBytes, migrationMs: performance.now() - started, migratedAt: now, validatedAt: now };
    atomic(path.join(staging, "manifest.json"), manifest);
    const validatedManifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    let validatedGates = 0, validatedSignals = 0;
    const keys = new Set(), payloadRefs = new Set();
    for (const [goalId] of byGoal) {
      const current = JSON.parse(fs.readFileSync(path.join(staging, "goals", stable(goalId) + ".json"), "utf8"));
      const legacy = JSON.parse(fs.readFileSync(path.join(staging, "legacy", stable(goalId) + ".json"), "utf8"));
      if (current.goalId !== goalId || legacy.goalId !== goalId || !legacy.sealed) throw new Error("gate v2 migration identity validation failed for " + goalId);
      validatedGates += current.gates.length;
      for (const gate of legacy.gates) {
        const key = goalId + "::" + gate.gateId;
        if (keys.has(key)) throw new Error("duplicate migrated gate " + key);
        keys.add(key); validatedSignals += gate.signals.length;
      }
      refs(legacy, payloadRefs);
    }
    for (const hash of payloadRefs) {
      const file = payloadFile(staging, hash);
      if (!fs.existsSync(file)) throw new Error("missing migrated gate payload " + hash);
      const body = fs.readFileSync(file);
      if (createHash("sha256").update(body).digest("hex") !== hash) throw new Error("tampered migrated gate payload " + hash);
    }
    if (validatedManifest.sourceSha256 !== sourceSha256 || validatedManifest.signalCount !== signalCount || validatedManifest.gateCount !== data.length || validatedGates !== data.length || validatedSignals !== signalCount || validatedManifest.state !== "complete") throw new Error("gate v2 migration validation failed");
    fs.mkdirSync(path.dirname(root), { recursive: true });
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    if (fs.existsSync(root)) fs.renameSync(root, displacedRoot);
    fs.renameSync(staging, root);
    if (fs.existsSync(displacedRoot)) fs.rmSync(displacedRoot, { recursive: true, force: true });
    try { fs.renameSync(storeFile, storeFile + ".v1-retired"); } catch {}
    const preload = canonicalPreload(stateDir);
    parentPort.postMessage({ ok: true, value: { migrated: true, sourceBytes: sourceBuffer.byteLength, externalizedBytes, payloadBytes, durationMs: performance.now() - started, preload } });
  } catch (error) {
    try {
      if (!fs.existsSync(root) && fs.existsSync(displacedRoot)) fs.renameSync(displacedRoot, root);
      fs.rmSync(staging, { recursive: true, force: true });
    } catch {}
    throw error;
  }
})().catch(error => parentPort.postMessage({ ok: false, error: error?.stack || String(error) }));
`;

function runMigrationWorker(stateDir: string): Promise<GateStoreMigrationWorkerResult> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(MIGRATION_WORKER_SOURCE, { eval: true, workerData: { stateDir } });
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

/** Coalesce concurrent first-open attempts for one canonical project state root. */
export function prepareGateStoreMigration(stateDir: string): Promise<GateStoreMigrationWorkerResult> {
	const workerRoot = path.resolve(stateDir);
	const key = canonicalGateStoreStateRoot(workerRoot);
	const existing = migrations.get(key);
	if (existing) return existing;
	const migration = runMigrationWorker(workerRoot).finally(() => migrations.delete(key));
	migrations.set(key, migration);
	return migration;
}
