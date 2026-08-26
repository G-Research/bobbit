import { Worker } from "node:worker_threads";

/** PDF.js is intentionally confined to short-lived, resource-capped processes. */
export const MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES = 3 * 1024;
export const MAX_CONCURRENT_PDF_EXTRACTIONS = 2;
const MAX_PDF_INPUT_BYTES = 20 * 1024 * 1024;
const PDF_EXTRACTION_TIMEOUT_MS = 5_000;
const PDF_CHILD_OLD_GENERATION_MB = 64;
const PDF_CHILD_SEMI_SPACE_MB = 8;
const PDF_CHILD_STACK_KB = 4 * 1024;
const PDF_LAUNCHER_OLD_GENERATION_MB = 32;
const PDF_LAUNCHER_YOUNG_GENERATION_MB = 4;
const PDF_LAUNCHER_STACK_MB = 2;
// JSON can double a bounded excerpt made entirely of quotes, backslashes, or
// retained whitespace escapes. The transport cap covers that worst case only.
const MAX_CHILD_OUTPUT_BYTES = MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES * 2 + 128;

interface PdfWorkerResult {
	kind: "result";
	text?: string;
}

interface PdfWorkerPid {
	kind: "pid";
	pid: number;
}

interface PdfExtractionWorker {
	on(event: "message", listener: (value: unknown) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "exit", listener: (code: number) => void): this;
	removeListener(event: "message", listener: (value: unknown) => void): this;
	removeListener(event: "error", listener: (error: Error) => void): this;
	removeListener(event: "exit", listener: (code: number) => void): this;
	terminate(): Promise<number>;
}

export interface PdfExtractionWorkerOptions {
	eval: true;
	resourceLimits: {
		maxOldGenerationSizeMb: number;
		maxYoungGenerationSizeMb: number;
		stackSizeMb: number;
	};
	workerData: {
		bytes: Uint8Array;
		childSource: string;
		execPath: string;
		childArgs: readonly string[];
		timeoutMs: number;
		maxOutputBytes: number;
	};
	transferList: ArrayBuffer[];
}

/** Narrow dependency seam for deterministic timeout/error/concurrency tests. */
export interface PdfExtractionIsolationOptions {
	timeoutMs?: number;
	workerFactory?: (source: string, options: PdfExtractionWorkerOptions) => PdfExtractionWorker;
}

let activeExtractions = 0;
const pdfjsModuleUrl = import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs");

/*
 * This fixed bootstrap is passed directly to the trusted Node executable. The
 * only untrusted value crossing the boundary is the admission-bounded stdin
 * byte stream. PDF.js and every decompressed object stay in the capped child.
 */
const PDF_CHILD_SOURCE = String.raw`
const fs = require("node:fs");
const MAX_INPUT_BYTES = ${MAX_PDF_INPUT_BYTES};
const MAX_OUTPUT_BYTES = ${MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES};
const MAX_PAGES = 32;
const MAX_TEXT_ITEMS_PER_PAGE = 10000;

function appendBounded(current, addition) {
	let output = current;
	let bytes = Buffer.byteLength(output, "utf8");
	for (const codePoint of addition) {
		const nextBytes = Buffer.byteLength(codePoint, "utf8");
		if (bytes + nextBytes > MAX_OUTPUT_BYTES) return { text: output, full: true };
		output += codePoint;
		bytes += nextBytes;
	}
	return { text: output, full: false };
}

function normalize(text) {
	const normalized = text
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
		.replace(/[\t ]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return normalized || undefined;
}

async function extract(bytes) {
	const pdfjs = await import(${JSON.stringify(pdfjsModuleUrl)});
	const loadingTask = pdfjs.getDocument({
		data: new Uint8Array(bytes),
		disableFontFace: true,
		isEvalSupported: false,
		useSystemFonts: false,
		stopAtErrors: true,
		verbosity: 0,
	});
	let pdf;
	try {
		pdf = await loadingTask.promise;
		let output = "";
		const pageCount = Math.min(pdf.numPages, MAX_PAGES);
		for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
			const page = await pdf.getPage(pageNumber);
			try {
				const content = await page.getTextContent();
				let pageStarted = false;
				let itemCount = 0;
				for (const item of content.items) {
					if (itemCount++ >= MAX_TEXT_ITEMS_PER_PAGE) break;
					if (!item || typeof item !== "object" || typeof item.str !== "string" || !/\S/.test(item.str)) continue;
					if (!pageStarted) {
						const header = appendBounded(output, (output ? "\n" : "") + "[Page " + pageNumber + "]\n");
						output = header.text;
						if (header.full) return normalize(output);
						pageStarted = true;
					}
					const appended = appendBounded(output, (output.endsWith("\n") ? "" : " ") + item.str);
					output = appended.text;
					if (appended.full) return normalize(output);
				}
			} finally {
				page.cleanup();
			}
		}
		return normalize(output);
	} finally {
		if (pdf) await pdf.destroy();
		else await loadingTask.destroy();
	}
}

(async () => {
	try {
		const bytes = fs.readFileSync(0);
		if (bytes.length > MAX_INPUT_BYTES) throw new Error("PDF input exceeded limit");
		const text = await extract(bytes);
		process.stdout.write(JSON.stringify(text === undefined ? { kind: "result" } : { kind: "result", text }));
	} catch {
		process.stdout.write(JSON.stringify({ kind: "result" }));
	}
})().catch(() => { process.exitCode = 1; });
`;

/*
 * Tier-1 source tests fence child_process in their gateway isolate. A tiny
 * launcher worker owns the native spawn and stream lifecycle so production and
 * source execution use the exact same resource-capped PDF child path.
 */
const PDF_LAUNCHER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { parentPort, workerData } = require("node:worker_threads");
let child;
let settled = false;
let outputBytes = 0;
const output = [];
let timer;

function finish(result, terminate) {
	if (settled) return;
	settled = true;
	clearTimeout(timer);
	if (child) {
		child.removeListener("error", onError);
		child.removeListener("close", onClose);
		child.stdin.removeListener("error", onError);
		child.stdout.removeListener("data", onData);
		child.stdout.removeListener("error", onError);
		if (terminate) {
			try { child.kill("SIGKILL"); } catch {}
		}
		child.stdin.destroy();
		child.stdout.destroy();
	}
	parentPort.postMessage(result);
	parentPort.close();
}
function onData(chunk) {
	const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
	outputBytes += data.length;
	if (outputBytes > workerData.maxOutputBytes) return finish({ kind: "result" }, true);
	output.push(data);
}
function onError() { finish({ kind: "result" }, true); }
function onClose(code) {
	if (code !== 0) return finish({ kind: "result" }, false);
	try {
		finish(JSON.parse(Buffer.concat(output, outputBytes).toString("utf8")), false);
	} catch {
		finish({ kind: "result" }, false);
	}
}
try {
	child = spawn(workerData.execPath, [...workerData.childArgs, "-e", workerData.childSource], {
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: true,
	});
	if (Number.isSafeInteger(child.pid) && child.pid > 0) parentPort.postMessage({ kind: "pid", pid: child.pid });
	child.on("error", onError);
	child.on("close", onClose);
	child.stdin.on("error", onError);
	child.stdout.on("data", onData);
	child.stdout.on("error", onError);
	timer = setTimeout(() => finish({ kind: "result" }, true), workerData.timeoutMs);
	child.stdin.end(Buffer.from(workerData.bytes));
} catch {
	finish({ kind: "result" }, true);
}
`;

function isValidWorkerResult(value: unknown): value is PdfWorkerResult {
	if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "result") return false;
	const text = (value as { text?: unknown }).text;
	if (text === undefined) return true;
	if (typeof text !== "string" || text.length === 0) return false;
	if (Buffer.byteLength(text, "utf8") > MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES) return false;
	return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

function isValidWorkerPid(value: unknown): value is PdfWorkerPid {
	return !!value && typeof value === "object"
		&& (value as { kind?: unknown }).kind === "pid"
		&& Number.isSafeInteger((value as { pid?: unknown }).pid)
		&& ((value as { pid: number }).pid > 0);
}

function defaultWorkerFactory(source: string, options: PdfExtractionWorkerOptions): PdfExtractionWorker {
	return new Worker(source, options) as PdfExtractionWorker;
}

function killPdfChild(pid: number | undefined): void {
	if (pid === undefined) return;
	try { process.kill(pid, "SIGKILL"); } catch { /* already unavailable */ }
}

function runPdfChild(bytes: Uint8Array, options: PdfExtractionIsolationOptions): Promise<string | undefined> {
	const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
		? Math.min(PDF_EXTRACTION_TIMEOUT_MS, Math.floor(options.timeoutMs!))
		: PDF_EXTRACTION_TIMEOUT_MS;
	// Copy before the async boundary so later caller mutation cannot alter the
	// admitted snapshot. Transfer that private copy to the launcher without a
	// second 20 MiB clone.
	const snapshot = Uint8Array.from(bytes);
	const workerOptions: PdfExtractionWorkerOptions = {
		eval: true,
		resourceLimits: {
			maxOldGenerationSizeMb: PDF_LAUNCHER_OLD_GENERATION_MB,
			maxYoungGenerationSizeMb: PDF_LAUNCHER_YOUNG_GENERATION_MB,
			stackSizeMb: PDF_LAUNCHER_STACK_MB,
		},
		workerData: {
			bytes: snapshot,
			childSource: PDF_CHILD_SOURCE,
			execPath: process.execPath,
			childArgs: [
				`--max-old-space-size=${PDF_CHILD_OLD_GENERATION_MB}`,
				`--max-semi-space-size=${PDF_CHILD_SEMI_SPACE_MB}`,
				`--stack-size=${PDF_CHILD_STACK_KB}`,
			],
			timeoutMs,
			maxOutputBytes: MAX_CHILD_OUTPUT_BYTES,
		},
		transferList: [snapshot.buffer],
	};
	let worker: PdfExtractionWorker;
	try {
		worker = (options.workerFactory ?? defaultWorkerFactory)(PDF_LAUNCHER_SOURCE, workerOptions);
	} catch {
		return Promise.resolve(undefined);
	}

	return new Promise<string | undefined>((resolve) => {
		let settled = false;
		let childPid: number | undefined;
		let result: PdfWorkerResult | undefined;
		let timer: ReturnType<typeof setTimeout>;
		const finish = (text: string | undefined, terminate: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			worker.removeListener("message", onMessage);
			worker.removeListener("error", onError);
			worker.removeListener("exit", onExit);
			if (!terminate) {
				resolve(text);
				return;
			}
			killPdfChild(childPid);
			// Retain the capacity slot until the launcher has stopped so rapid
			// failures and retries cannot exceed the physical child ceiling.
			try {
				void worker.terminate().then(() => resolve(text), () => resolve(text));
			} catch {
				resolve(text);
			}
		};
		const onMessage = (value: unknown): void => {
			if (isValidWorkerPid(value) && childPid === undefined && result === undefined) {
				childPid = value.pid;
				return;
			}
			if (result !== undefined || !isValidWorkerResult(value)) {
				finish(undefined, true);
				return;
			}
			result = value;
		};
		const onError = (): void => finish(undefined, true);
		const onExit = (code: number): void => {
			finish(code === 0 ? result?.text : undefined, code !== 0);
		};
		worker.on("message", onMessage);
		worker.on("error", onError);
		worker.on("exit", onExit);
		// The launcher enforces the exact child deadline. This small outer grace
		// only covers kill/exit delivery if the launcher itself becomes unhealthy.
		timer = setTimeout(() => finish(undefined, true), timeoutMs + Math.min(timeoutMs, 250));
	});
}

/**
 * Extract a PDF admission excerpt without ever parsing attacker-controlled PDF
 * bytes in the gateway process. Capacity exhaustion fails immediately—there is
 * deliberately no waiter queue. Every other failure is pointer-only as well.
 */
export async function extractPdfTextInIsolate(
	bytes: Uint8Array,
	options: PdfExtractionIsolationOptions = {},
): Promise<string | undefined> {
	if (bytes.byteLength > MAX_PDF_INPUT_BYTES || activeExtractions >= MAX_CONCURRENT_PDF_EXTRACTIONS) return undefined;
	activeExtractions++;
	try {
		return await runPdfChild(bytes, options);
	} finally {
		activeExtractions--;
	}
}
