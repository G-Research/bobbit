import { Worker } from "node:worker_threads";

export const GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES = 1024;
export const GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES = 64 * 1024;
export const GATE_INSPECTION_REGEX_TIMEOUT_MS = 100;
export const GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS = 2_500;
export const GATE_INSPECTION_REGEX_MAX_WORKERS = 4;
export const GATE_INSPECTION_REGEX_MAX_QUEUE = 4;
const GATE_INSPECTION_REGEX_ADMISSION_TIMEOUT_MS = 250;
const GATE_INSPECTION_REGEX_START_TIMEOUT_MS = 5_000;

export type GateInspectionRegexErrorCode =
	| "GATE_INSPECT_REGEX_INVALID"
	| "GATE_INSPECT_REGEX_TOO_LONG"
	| "GATE_INSPECT_REGEX_TIMEOUT"
	| "GATE_INSPECT_REGEX_SATURATED"
	| "GATE_INSPECT_REGEX_UNAVAILABLE";

/** A bounded, response-safe inspection error. Paths, refs, and worker stacks are never included. */
export class GateInspectionRegexError extends Error {
	readonly status: number;
	readonly code: GateInspectionRegexErrorCode;

	constructor(code: GateInspectionRegexErrorCode, message: string, status = code === "GATE_INSPECT_REGEX_TIMEOUT" ? 408 : code === "GATE_INSPECT_REGEX_SATURATED" ? 429 : 400) {
		super(message);
		this.name = "GateInspectionRegexError";
		this.code = code;
		this.status = status;
	}
}

export class GateInspectionReadError extends Error {
	readonly status = 400;
	readonly code = "GATE_INSPECT_BODY_UNAVAILABLE";

	constructor(message: string) {
		super(message);
		this.name = "GateInspectionReadError";
	}
}

const REGEX_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let regex;
try {
  regex = new RegExp(workerData.pattern, "gd");
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "invalid", message: error && error.message ? error.message : String(error) });
}
parentPort.on("message", message => {
  if (!regex || !message || message.type !== "test") return;
  try {
    // NUL guards keep ^ and $ from treating a rolling-window boundary as a
    // real line boundary. Matches touching a guard are ignored.
    const prefix = message.lineStart === false ? "\\u0000" : "";
    const suffix = message.lineEnd === false ? "\\u0000" : "";
    const candidate = prefix + message.candidate + suffix;
    const from = prefix.length;
    const to = from + message.candidate.length;
    let matched = false;
    regex.lastIndex = 0;
    for (;;) {
      const result = regex.exec(candidate);
      if (!result) break;
      const range = result.indices && result.indices[0];
      if (range && range[0] >= from && range[1] <= to) { matched = true; break; }
      if (result[0] === "") regex.lastIndex++;
    }
    regex.lastIndex = 0;
    parentPort.postMessage({ type: "result", id: message.id, matched });
  } catch (error) {
    parentPort.postMessage({ type: "failure", id: message.id });
  }
});
`;

interface AdmissionWaiter {
	settled: boolean;
	timer: NodeJS.Timeout;
	resolve: (permit: RegexWorkerPermit) => void;
	reject: (error: GateInspectionRegexError) => void;
}

interface RegexWorkerPermit {
	release(): void;
}

let activeRegexWorkers = 0;
const regexWorkerWaiters: AdmissionWaiter[] = [];

function saturationError(): GateInspectionRegexError {
	return new GateInspectionRegexError("GATE_INSPECT_REGEX_SATURATED", "Regex inspection capacity is saturated", 429);
}

function makePermit(): RegexWorkerPermit {
	let released = false;
	return {
		release(): void {
			if (released) return;
			released = true;
			for (;;) {
				const waiter = regexWorkerWaiters.shift();
				if (!waiter) {
					activeRegexWorkers--;
					return;
				}
				if (waiter.settled) continue;
				waiter.settled = true;
				clearTimeout(waiter.timer);
				// Transfer this active slot directly to the oldest waiter.
				waiter.resolve(makePermit());
				return;
			}
		},
	};
}

async function acquireRegexWorkerPermit(maxWaitMs: number): Promise<RegexWorkerPermit> {
	if (activeRegexWorkers < GATE_INSPECTION_REGEX_MAX_WORKERS) {
		activeRegexWorkers++;
		return makePermit();
	}
	if (regexWorkerWaiters.length >= GATE_INSPECTION_REGEX_MAX_QUEUE || maxWaitMs <= 0) throw saturationError();
	return await new Promise<RegexWorkerPermit>((resolve, reject) => {
		const waiter: AdmissionWaiter = {
			settled: false,
			resolve,
			reject,
			timer: setTimeout(() => {
				if (waiter.settled) return;
				waiter.settled = true;
				const index = regexWorkerWaiters.indexOf(waiter);
				if (index >= 0) regexWorkerWaiters.splice(index, 1);
				reject(saturationError());
			}, Math.max(1, Math.min(maxWaitMs, GATE_INSPECTION_REGEX_ADMISSION_TIMEOUT_MS))),
		};
		regexWorkerWaiters.push(waiter);
	});
}

function boundedCandidate(candidate: string): string {
	if (Buffer.byteLength(candidate) <= GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES) return candidate;
	let used = 0;
	let output = "";
	for (let index = candidate.length; index > 0;) {
		const end = index;
		index--;
		if (index > 0 && /[\uDC00-\uDFFF]/.test(candidate[index]!) && /[\uD800-\uDBFF]/.test(candidate[index - 1]!)) index--;
		const character = candidate.slice(index, end);
		const bytes = Buffer.byteLength(character);
		if (used + bytes > GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES) break;
		output = character + output;
		used += bytes;
	}
	return output;
}

export interface GateInspectionRegexCandidateBoundaries {
	lineStart?: boolean;
	lineEnd?: boolean;
}

export interface GateInspectionRegexMatcher {
	test(candidate: string, boundaries?: GateInspectionRegexCandidateBoundaries): Promise<boolean>;
	/** Race stream reads against the whole-selection wall deadline. */
	guard<T>(operation: Promise<T>): Promise<T>;
	dispose(): Promise<void>;
}

/**
 * Compile and evaluate an inspection regex only inside a terminate-able worker.
 * Worker admission is process-wide and bounded. Each evaluation and the whole
 * selection have positive wall deadlines; callers must dispose in a finally.
 */
export async function createGateInspectionRegexMatcher(pattern: string): Promise<GateInspectionRegexMatcher> {
	const startedAt = Date.now();
	if (!pattern) throw new GateInspectionRegexError("GATE_INSPECT_REGEX_INVALID", "grep mode requires a non-empty pattern");
	if (Buffer.byteLength(pattern) > GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES) {
		throw new GateInspectionRegexError(
			"GATE_INSPECT_REGEX_TOO_LONG",
			`grep pattern exceeds ${GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES} byte limit`,
		);
	}

	const permit = await acquireRegexWorkerPermit(GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS - (Date.now() - startedAt));
	let worker: Worker;
	try {
		worker = new Worker(REGEX_WORKER_SOURCE, {
			eval: true,
			workerData: { pattern },
			resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
		});
	} catch (error) {
		permit.release();
		throw new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503);
	}

	let disposed = false;
	let inFlight = false;
	let requestId = 0;
	let terminalError: GateInspectionRegexError | undefined;
	let termination: Promise<number> | undefined;
	let rejectDeadline!: (error: GateInspectionRegexError) => void;
	const deadlineFailure = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
	void deadlineFailure.catch(() => undefined);
	const releasePermit = (): void => permit.release();
	worker.once("exit", releasePermit);
	const terminateWorker = (): Promise<number> => termination ??= worker.terminate().finally(releasePermit);
	const failTerminal = (error: GateInspectionRegexError): void => {
		if (terminalError) return;
		terminalError = error;
		disposed = true;
		rejectDeadline(error);
		void terminateWorker().catch(() => undefined);
	};

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				worker.off("message", onMessage);
				worker.off("error", onError);
				worker.off("exit", onExit);
				fn();
			};
			const onMessage = (message: any): void => {
				if (message?.type === "ready") finish(resolve);
				else if (message?.type === "invalid") finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_INVALID", `Invalid regex pattern: ${String(message.message || "invalid pattern").slice(0, 240)}`)));
			};
			const unavailable = (): GateInspectionRegexError => new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503);
			const onError = (): void => finish(() => reject(unavailable()));
			const onExit = (): void => finish(() => reject(unavailable()));
			const remaining = GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
			const timer = setTimeout(() => finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", "Regex inspection timed out"))), Math.max(1, Math.min(GATE_INSPECTION_REGEX_START_TIMEOUT_MS, remaining)));
			worker.on("message", onMessage);
			worker.once("error", onError);
			worker.once("exit", onExit);
		});
	} catch (error) {
		disposed = true;
		await terminateWorker().catch(() => undefined);
		throw error;
	}

	worker.on("error", () => failTerminal(new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503)));
	const remaining = GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
	if (remaining <= 0) {
		const error = new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", `Regex inspection exceeded ${GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS}ms total wall timeout`);
		failTerminal(error);
		throw error;
	}
	const aggregateTimer = setTimeout(() => failTerminal(new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", `Regex inspection exceeded ${GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS}ms total wall timeout`)), remaining);

	return {
		async test(candidate: string, boundaries: GateInspectionRegexCandidateBoundaries = {}): Promise<boolean> {
			if (terminalError) throw terminalError;
			if (disposed) throw new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503);
			if (inFlight) throw new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection already has an in-flight candidate", 503);
			inFlight = true;
			const id = ++requestId;
			try {
				return await new Promise<boolean>((resolve, reject) => {
					let settled = false;
					const finish = (fn: () => void): void => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						worker.off("message", onMessage);
						worker.off("error", onFailure);
						worker.off("exit", onFailure);
						fn();
					};
					const onMessage = (message: any): void => {
						if (message?.id !== id) return;
						if (message.type === "result") finish(() => resolve(message.matched === true));
						else if (message.type === "failure") finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_INVALID", "Regex evaluation failed")));
					};
					const onFailure = (): void => finish(() => reject(terminalError ?? new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503)));
					const remainingTotal = GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
					if (remainingTotal <= 0) {
						const error = new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", `Regex inspection exceeded ${GATE_INSPECTION_REGEX_TOTAL_TIMEOUT_MS}ms total wall timeout`);
						failTerminal(error);
						finish(() => reject(error));
						return;
					}
					const timer = setTimeout(() => {
						const error = new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", `Regex inspection exceeded ${Math.min(GATE_INSPECTION_REGEX_TIMEOUT_MS, remainingTotal)}ms wall timeout`);
						failTerminal(error);
						finish(() => reject(error));
					}, Math.max(1, Math.min(GATE_INSPECTION_REGEX_TIMEOUT_MS, remainingTotal)));
					worker.on("message", onMessage);
					worker.once("error", onFailure);
					worker.once("exit", onFailure);
					worker.postMessage({
						type: "test",
						id,
						candidate: boundedCandidate(candidate),
						lineStart: boundaries.lineStart !== false,
						lineEnd: boundaries.lineEnd !== false,
					});
				});
			} finally {
				inFlight = false;
			}
		},
		async guard<T>(operation: Promise<T>): Promise<T> {
			if (terminalError) throw terminalError;
			return await Promise.race([operation, deadlineFailure]);
		},
		async dispose(): Promise<void> {
			clearTimeout(aggregateTimer);
			if (!disposed) disposed = true;
			await terminateWorker().catch(() => undefined);
		},
	};
}
