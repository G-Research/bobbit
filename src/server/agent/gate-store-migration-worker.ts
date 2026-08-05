import path from "node:path";
import { Worker } from "node:worker_threads";

export interface GateStoreMigrationWorkerResult {
	migrated: boolean;
	sourceBytes: number;
	externalizedBytes: number;
	payloadBytes: number;
	durationMs: number;
}

const migrations = new Map<string, Promise<GateStoreMigrationWorkerResult>>();

// Keep the worker self-contained: production runs compiled JavaScript while the
// test runner transforms TypeScript in-process and cannot resolve a sibling TS
// worker without a separate prebundle. No source data crosses the MessagePort.
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
(async () => {
  const stateDir = path.resolve(workerData.stateDir);
  const storeFile = path.join(stateDir, "gates.json");
  const root = path.join(stateDir, "gate-records", "v2");
  const manifestFile = path.join(root, "manifest.json");
  if (fs.existsSync(manifestFile)) {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (manifest.schemaVersion !== 2 || manifest.state !== "complete") throw new Error("invalid gate v2 manifest");
    if (fs.existsSync(storeFile)) { try { fs.renameSync(storeFile, storeFile + ".v1-retired"); } catch {} }
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: manifest.sourceBytes || 0, externalizedBytes: manifest.externalizedBytes || 0, payloadBytes: manifest.payloadBytes || 0, durationMs: performance.now() - started } });
    return;
  }
  if (!fs.existsSync(storeFile)) {
    parentPort.postMessage({ ok: true, value: { migrated: false, sourceBytes: 0, externalizedBytes: 0, payloadBytes: 0, durationMs: performance.now() - started } });
    return;
  }
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
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
    fs.renameSync(staging, root);
    try { fs.renameSync(storeFile, storeFile + ".v1-retired"); } catch {}
    parentPort.postMessage({ ok: true, value: { migrated: true, sourceBytes: sourceBuffer.byteLength, externalizedBytes, payloadBytes, durationMs: performance.now() - started } });
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch {}
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
	const key = path.resolve(stateDir);
	const existing = migrations.get(key);
	if (existing) return existing;
	const migration = runMigrationWorker(key).finally(() => migrations.delete(key));
	migrations.set(key, migration);
	return migration;
}
