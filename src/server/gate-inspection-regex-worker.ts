import { Worker } from "node:worker_threads";

export const GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES = 1024;
export const GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES = 64 * 1024;
export const GATE_INSPECTION_REGEX_TIMEOUT_MS = 100;
const GATE_INSPECTION_REGEX_START_TIMEOUT_MS = 5_000;

export type GateInspectionRegexErrorCode = "GATE_INSPECT_REGEX_INVALID" | "GATE_INSPECT_REGEX_TOO_LONG" | "GATE_INSPECT_REGEX_TIMEOUT" | "GATE_INSPECT_REGEX_UNAVAILABLE";

/** A bounded, response-safe inspection error. Paths, refs, and worker stacks are never included. */
export class GateInspectionRegexError extends Error {
	readonly status: number;
	readonly code: GateInspectionRegexErrorCode;

	constructor(code: GateInspectionRegexErrorCode, message: string, status = code === "GATE_INSPECT_REGEX_TIMEOUT" ? 408 : 400) {
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
  regex = new RegExp(workerData.pattern);
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "invalid", message: error && error.message ? error.message : String(error) });
}
parentPort.on("message", message => {
  if (!regex || !message || message.type !== "test") return;
  try {
    regex.lastIndex = 0;
    const matched = regex.test(message.candidate);
    regex.lastIndex = 0;
    parentPort.postMessage({ type: "result", id: message.id, matched });
  } catch (error) {
    parentPort.postMessage({ type: "failure", id: message.id });
  }
});
`;

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

export interface GateInspectionRegexMatcher {
	test(candidate: string): Promise<boolean>;
	dispose(): Promise<void>;
}

/**
 * Compile and evaluate an inspection regex only inside a terminate-able worker.
 * Each matcher permits exactly one in-flight candidate and every evaluation has
 * a positive wall deadline; callers must dispose it in a finally block.
 */
export async function createGateInspectionRegexMatcher(pattern: string): Promise<GateInspectionRegexMatcher> {
	if (!pattern) throw new GateInspectionRegexError("GATE_INSPECT_REGEX_INVALID", "grep mode requires a non-empty pattern");
	if (Buffer.byteLength(pattern) > GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES) {
		throw new GateInspectionRegexError(
			"GATE_INSPECT_REGEX_TOO_LONG",
			`grep pattern exceeds ${GATE_INSPECTION_REGEX_MAX_PATTERN_BYTES} byte limit`,
		);
	}

	const worker = new Worker(REGEX_WORKER_SOURCE, {
		eval: true,
		workerData: { pattern },
		resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4, stackSizeMb: 1 },
	});
	let disposed = false;
	let inFlight = false;
	let requestId = 0;
	let termination: Promise<number> | undefined;
	const terminateWorker = (): Promise<number> => termination ??= worker.terminate();

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
		const timer = setTimeout(() => finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", "Regex inspection timed out"))), GATE_INSPECTION_REGEX_START_TIMEOUT_MS);
		worker.on("message", onMessage);
		worker.once("error", onError);
		worker.once("exit", onExit);
	}).catch(async error => {
		disposed = true;
		await terminateWorker().catch(() => undefined);
		throw error;
	});

	return {
		async test(candidate: string): Promise<boolean> {
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
					const onFailure = (): void => finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_UNAVAILABLE", "Regex inspection worker is unavailable", 503)));
					const timer = setTimeout(() => {
						disposed = true;
						void terminateWorker();
						finish(() => reject(new GateInspectionRegexError("GATE_INSPECT_REGEX_TIMEOUT", `Regex inspection exceeded ${GATE_INSPECTION_REGEX_TIMEOUT_MS}ms wall timeout`)));
					}, GATE_INSPECTION_REGEX_TIMEOUT_MS);
					worker.on("message", onMessage);
					worker.once("error", onFailure);
					worker.once("exit", onFailure);
					worker.postMessage({ type: "test", id, candidate: boundedCandidate(candidate) });
				});
			} finally {
				inFlight = false;
			}
		},
		async dispose(): Promise<void> {
			if (!disposed) disposed = true;
			await terminateWorker().catch(() => undefined);
		},
	};
}
