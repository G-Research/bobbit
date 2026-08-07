import { Worker } from "node:worker_threads";

import type { GateSignal } from "./gate-store.js";
import { HUMAN_BYPASS_SIGNAL_PREDICATE_SOURCE } from "./gate-bypass-provenance.js";
import { buildVerificationCacheProjection, type GateVerificationCacheEntry } from "./gate-store-v2-persistence.js";

export interface PreparedGateSignals {
	signals: GateSignal[];
	signalBytes: number[];
	externalizedBytes: number;
	payloadBytesWritten: number;
	cacheProjection: GateVerificationCacheEntry[];
}

let afterPayloadFinalizationForTests: (() => void | Promise<void>) | undefined;

/** Deterministic race seam after final payload rename but before shard snapshot publication. */
export function __setGatePayloadFinalizationPauseForTests(hook?: () => void | Promise<void>): void {
	afterPayloadFinalizationForTests = hook;
}

const PAYLOAD_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const isHumanBypassSignal = ${HUMAN_BYPASS_SIGNAL_PREDICATE_SOURCE};
const payloadFile = (root, hash) => path.join(root, "payloads", hash.slice(0, 2), hash + ".payload");
const invalidatedAt = workerData.verificationCacheInvalidatedAt ?? Number.NEGATIVE_INFINITY;
let cacheProjection = Array.isArray(workerData.cacheProjection) ? workerData.cacheProjection : [];
const cacheStep = step => ({
  name: step.name, type: step.type, passed: step.passed,
  ...(step.skipped === undefined ? {} : { skipped: step.skipped }),
  output: step.output, duration_ms: step.duration_ms,
  ...(step.expect === undefined ? {} : { expect: step.expect }),
  ...(step.status === undefined ? {} : { status: step.status }),
  ...(step.timeout === undefined ? {} : { timeout: step.timeout }),
  ...(step.phase === undefined ? {} : { phase: step.phase }),
});
const updateCache = signal => {
  if (!signal.commitSha || signal.timestamp <= invalidatedAt || signal.verification?.status === "running" || isHumanBypassSignal(signal)) return;
  let entry = cacheProjection.find(candidate => candidate.commitSha === signal.commitSha);
  if (!entry) { entry = { commitSha: signal.commitSha, updatedAt: signal.timestamp, stepResults: [] }; cacheProjection.push(entry); }
  entry.updatedAt = Math.max(entry.updatedAt, signal.timestamp);
  const cachedNames = new Set(entry.stepResults.map(result => result.step.name));
  for (const step of signal.verification?.steps || []) {
    if (step.type === "human-signoff" || !step.passed || step.outputRef || cachedNames.has(step.name)) continue;
    entry.stepResults.push({ sourceSignalId: signal.id, sourceTimestamp: signal.timestamp, step: cacheStep(step) }); cachedNames.add(step.name);
  }
  if (!entry.reusableSignal && signal.verification.status === "passed"
      && !(signal.verification.steps || []).some(step => step.type === "human-signoff" || !!step.outputRef)) {
    entry.reusableSignal = { sourceSignalId: signal.id, sourceTimestamp: signal.timestamp, steps: signal.verification.steps.map(cacheStep) };
  }
};
const boundCache = () => {
  cacheProjection = cacheProjection
    .map(entry => ({ ...entry,
      stepResults: (entry.stepResults || []).filter(result => result.sourceTimestamp > invalidatedAt),
      ...(entry.reusableSignal?.sourceTimestamp > invalidatedAt ? {} : { reusableSignal: undefined }),
    }))
    .filter(entry => entry.stepResults.length > 0 || entry.reusableSignal)
    .sort((left, right) => left.updatedAt - right.updatedAt || left.commitSha.localeCompare(right.commitSha))
    .slice(-32);
  while (cacheProjection.length > 0 && Buffer.byteLength(JSON.stringify(cacheProjection)) > 1024 * 1024) cacheProjection.shift();
  return cacheProjection;
};
const store = content => {
  const bytes = Buffer.byteLength(content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  const target = payloadFile(workerData.v2Root, sha256);
  let written = 0;
  if (!fs.existsSync(target)) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, content, "utf8");
    try { fs.renameSync(tmp, target); written = bytes; }
    catch (error) { if (!fs.existsSync(target)) throw error; try { fs.unlinkSync(tmp); } catch {} }
  }
  return { ref: { kind: "gate-payload-v2", sha256, bytes, path: target }, bytes, written };
};
const compact = signal => {
  let externalizedBytes = 0, payloadBytesWritten = 0;
  if (isHumanBypassSignal(signal) && signal.content) {
    const result = store(signal.content); signal.contentRef = result.ref;
    externalizedBytes += result.bytes; payloadBytesWritten += result.written; signal.content = "";
  }
  if (isHumanBypassSignal(signal)) {
    for (const [key, value] of Object.entries(signal.metadata)) {
      if (Buffer.byteLength(value) <= 16384) continue;
      const result = store(value); signal.auditMetadataRefs ||= {}; signal.auditMetadataRefs[key] = result.ref;
      if (key === "whyBypassed") signal.bypassReasonRef = result.ref;
      externalizedBytes += result.bytes; payloadBytesWritten += result.written;
      signal.metadata[key] = Buffer.from(value).subarray(0, 16384).toString("utf8"); signal.metadata[key + "Truncated"] = "true";
    }
  }
  for (const step of signal.verification?.steps || []) {
    if (step.output) {
      const result = store(step.output); step.outputRef = result.ref; payloadBytesWritten += result.written;
      externalizedBytes += Buffer.byteLength(step.output); step.output = "";
    }
    if (step.artifact?.content) {
      const result = store(step.artifact.content); step.artifact.contentRef = result.ref;
      externalizedBytes += result.bytes; payloadBytesWritten += result.written; step.artifact.content = "";
    }
    for (const artifact of step.diagnostics?.artifacts || []) {
      if (!artifact.content) continue;
      const result = store(artifact.content); artifact.contentRef = result.ref; payloadBytesWritten += result.written;
      externalizedBytes += Buffer.byteLength(artifact.content); delete artifact.content;
    }
  }
  return { signal, signalBytes: Buffer.byteLength(JSON.stringify(signal)), externalizedBytes, payloadBytesWritten };
};
parentPort.on("message", message => {
  try {
    if (message.finalize) { parentPort.postMessage({ ok: true, final: true, cacheProjection: boundCache() }); return; }
    updateCache(message.signal);
    parentPort.postMessage({ ok: true, index: message.index, value: compact(message.signal) });
  } catch (error) { parentPort.postMessage({ ok: false, index: message.index, error: error?.stack || String(error) }); }
});
`;

/** Hash and publish payload bodies in a worker before their refs enter a shard. */
export function prepareGateSignalsInWorker(
	v2Root: string,
	signals: GateSignal[],
	cacheProjection: GateVerificationCacheEntry[] = [],
	verificationCacheInvalidatedAt?: number,
): Promise<PreparedGateSignals> {
	if (signals.length === 0) return Promise.resolve({
		signals: [], signalBytes: [], externalizedBytes: 0, payloadBytesWritten: 0,
		cacheProjection: buildVerificationCacheProjection([], verificationCacheInvalidatedAt, cacheProjection),
	});
	return new Promise((resolve, reject) => {
		const worker = new Worker(PAYLOAD_WORKER_SOURCE, { eval: true, workerData: { v2Root, cacheProjection, verificationCacheInvalidatedAt } });
		const compacted: GateSignal[] = new Array(signals.length);
		const signalBytes: number[] = new Array(signals.length);
		let nextIndex = 0;
		let externalizedBytes = 0;
		let payloadBytesWritten = 0;
		let settled = false;
		const finish = (fn: () => void): void => {
			if (settled) return;
			settled = true;
			void worker.terminate();
			fn();
		};
		const sendNext = (): void => {
			if (nextIndex >= signals.length) {
				worker.postMessage({ finalize: true });
				return;
			}
			const index = nextIndex++;
			// Bound structured-clone work to one signal and yield between signals so
			// a retained history cannot become one giant tick-zero transfer.
			setImmediate(() => { if (!settled) worker.postMessage({ index, signal: signals[index] }); });
		};
		worker.on("online", sendNext);
		worker.on("message", async (message: { ok?: boolean; final?: boolean; cacheProjection?: GateVerificationCacheEntry[]; index?: number; value?: { signal: GateSignal; signalBytes: number; externalizedBytes: number; payloadBytesWritten: number }; error?: string }) => {
			if (message.ok && message.final && message.cacheProjection) {
				finish(() => resolve({ signals: compacted, signalBytes, externalizedBytes, payloadBytesWritten, cacheProjection: message.cacheProjection! }));
				return;
			}
			if (!message.ok || message.index === undefined || !message.value) {
				finish(() => reject(new Error(message.error ?? "gate payload worker failed")));
				return;
			}
			try {
				await afterPayloadFinalizationForTests?.();
			} catch (error) {
				finish(() => reject(error));
				return;
			}
			if (settled) return;
			compacted[message.index] = message.value.signal;
			signalBytes[message.index] = message.value.signalBytes;
			externalizedBytes += message.value.externalizedBytes;
			payloadBytesWritten += message.value.payloadBytesWritten;
			sendNext();
		});
		worker.on("error", error => finish(() => reject(error)));
		worker.on("exit", code => { if (!settled) finish(() => reject(new Error(`gate payload worker exited (${code})`))); });
	});
}
