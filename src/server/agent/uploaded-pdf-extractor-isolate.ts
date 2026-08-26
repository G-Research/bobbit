import { spawn } from "node:child_process";

/** PDF.js is intentionally confined to short-lived, resource-capped processes. */
export const MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES = 3 * 1024;
export const MAX_CONCURRENT_PDF_EXTRACTIONS = 2;
const PDF_EXTRACTION_TIMEOUT_MS = 5_000;
const PDF_CHILD_OLD_GENERATION_MB = 64;
const PDF_CHILD_SEMI_SPACE_MB = 8;
const PDF_CHILD_STACK_KB = 4 * 1024;
// JSON can double a bounded excerpt made entirely of quotes, backslashes, or
// retained whitespace escapes. The transport cap covers that worst case only.
const MAX_CHILD_OUTPUT_BYTES = MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES * 2 + 128;

interface PdfChildResult {
	kind: "result";
	text?: string;
}

interface PdfExtractionChild {
	stdin: NodeJS.WritableStream & { destroy(error?: Error): void };
	stdout: NodeJS.ReadableStream & { destroy(error?: Error): void };
	on(event: "error", listener: (error: Error) => void): this;
	on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	removeListener(event: "error", listener: (error: Error) => void): this;
	removeListener(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
	kill(signal?: NodeJS.Signals | number): boolean;
}

export interface PdfExtractionChildOptions {
	args: readonly string[];
	windowsHide: boolean;
}

/** Narrow dependency seam for deterministic timeout/error/concurrency tests. */
export interface PdfExtractionIsolationOptions {
	timeoutMs?: number;
	childFactory?: (source: string, options: PdfExtractionChildOptions) => PdfExtractionChild;
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
const MAX_INPUT_BYTES = 20 * 1024 * 1024;
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

function isValidChildResult(value: unknown): value is PdfChildResult {
	if (!value || typeof value !== "object" || (value as { kind?: unknown }).kind !== "result") return false;
	const text = (value as { text?: unknown }).text;
	if (text === undefined) return true;
	if (typeof text !== "string" || text.length === 0) return false;
	if (Buffer.byteLength(text, "utf8") > MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES) return false;
	return !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

function defaultChildFactory(source: string, options: PdfExtractionChildOptions): PdfExtractionChild {
	return spawn(process.execPath, [...options.args, "-e", source], {
		stdio: ["pipe", "pipe", "ignore"],
		windowsHide: options.windowsHide,
	}) as PdfExtractionChild;
}

function runPdfChild(bytes: Uint8Array, options: PdfExtractionIsolationOptions): Promise<string | undefined> {
	const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
		? Math.min(PDF_EXTRACTION_TIMEOUT_MS, Math.floor(options.timeoutMs!))
		: PDF_EXTRACTION_TIMEOUT_MS;
	const childOptions: PdfExtractionChildOptions = {
		args: [
			`--max-old-space-size=${PDF_CHILD_OLD_GENERATION_MB}`,
			`--max-semi-space-size=${PDF_CHILD_SEMI_SPACE_MB}`,
			`--stack-size=${PDF_CHILD_STACK_KB}`,
		],
		windowsHide: true,
	};
	let child: PdfExtractionChild;
	try {
		child = (options.childFactory ?? defaultChildFactory)(PDF_CHILD_SOURCE, childOptions);
	} catch {
		return Promise.resolve(undefined);
	}

	return new Promise<string | undefined>((resolve) => {
		let settled = false;
		let outputBytes = 0;
		const output: Buffer[] = [];
		let timer: ReturnType<typeof setTimeout>;
		const finish = (text: string | undefined, terminate: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.removeListener("error", onError);
			child.removeListener("close", onClose);
			child.stdin.removeListener("error", onStdinError);
			child.stdout.removeListener("data", onData);
			child.stdout.removeListener("error", onStdoutError);
			if (terminate) {
				try { child.kill("SIGKILL"); } catch { /* already unavailable */ }
			}
			child.stdin.destroy();
			child.stdout.destroy();
			resolve(text);
		};
		const onData = (chunk: Buffer | string): void => {
			const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			outputBytes += data.length;
			if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
				finish(undefined, true);
				return;
			}
			output.push(data);
		};
		const onError = (): void => finish(undefined, true);
		const onStdinError = (): void => finish(undefined, true);
		const onStdoutError = (): void => finish(undefined, true);
		const onClose = (code: number | null): void => {
			if (code !== 0) {
				finish(undefined, false);
				return;
			}
			try {
				const parsed: unknown = JSON.parse(Buffer.concat(output, outputBytes).toString("utf8"));
				finish(isValidChildResult(parsed) ? parsed.text : undefined, false);
			} catch {
				finish(undefined, false);
			}
		};
		child.on("error", onError);
		child.on("close", onClose);
		child.stdin.on("error", onStdinError);
		child.stdout.on("data", onData);
		child.stdout.on("error", onStdoutError);
		timer = setTimeout(() => finish(undefined, true), timeoutMs);
		// Buffer.copy prevents mutation of the admitted snapshot while the async
		// pipe is draining; the copy remains bounded by the 20 MiB admission cap.
		child.stdin.end(Buffer.from(bytes));
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
	if (activeExtractions >= MAX_CONCURRENT_PDF_EXTRACTIONS) return undefined;
	activeExtractions++;
	try {
		return await runPdfChild(bytes, options);
	} finally {
		activeExtractions--;
	}
}
