import type JSZip from "jszip";
import {
	extractPdfTextInIsolate,
	MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES,
} from "./uploaded-pdf-extractor-isolate.js";

/**
 * Server-derived document text is only an admission excerpt. Keeping this well
 * above the model context's 2 KiB per-file budget preserves its truncation
 * signal without allowing extracted data to grow the immutable manifest.
 */
export { MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES } from "./uploaded-pdf-extractor-isolate.js";

const MAX_SPECIALIZED_INPUT_BYTES = 20 * 1024 * 1024;
const MAX_PRESENTATION_PAGES = 32;
const MAX_ZIP_ENTRIES = 512;
const MAX_SELECTED_ZIP_ENTRIES = 64;
const MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES = 1024 * 1024;
const MAX_ZIP_SELECTED_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const MAX_XML_TEXT_NODES = 20_000;

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

type SpecializedKind = "pdf" | "docx" | "pptx";

export interface SpecializedDocumentExtraction {
	recognized: boolean;
	text?: string;
}

function specializedKind(fileName: string, mimeType: string, bytes: Uint8Array): SpecializedKind | undefined {
	const lowerName = fileName.toLowerCase();
	const lowerMime = mimeType.toLowerCase();
	if (lowerName.endsWith(".pdf") || lowerMime === PDF_MIME || Buffer.from(bytes.subarray(0, 5)).equals(Buffer.from("%PDF-"))) return "pdf";
	if (lowerName.endsWith(".docx") || lowerMime === DOCX_MIME) return "docx";
	if (lowerName.endsWith(".pptx") || lowerMime === PPTX_MIME) return "pptx";
	return undefined;
}

function appendBounded(current: string, addition: string): { text: string; full: boolean } {
	let text = current;
	let bytes = Buffer.byteLength(text, "utf8");
	for (const codePoint of addition) {
		const nextBytes = Buffer.byteLength(codePoint, "utf8");
		if (bytes + nextBytes > MAX_SERVER_DERIVED_DOCUMENT_TEXT_BYTES) return { text, full: true };
		text += codePoint;
		bytes += nextBytes;
	}
	return { text, full: false };
}

export function boundServerDerivedDocumentText(text: string): string {
	// JSON expands low control characters by up to six bytes. Normalize them
	// before bounding so ten worst-case excerpts still fit the manifest cap.
	const manifestSafe = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ");
	return appendBounded("", manifestSafe).text;
}

function normalizeExtractedText(text: string): string | undefined {
	const normalized = text.replace(/[\t ]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
	return normalized || undefined;
}

function advertisedUncompressedSize(entry: JSZip.JSZipObject): number | undefined {
	const value = (entry as unknown as { _data?: { uncompressedSize?: unknown } })._data?.uncompressedSize;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function readBoundedZipEntry(entry: JSZip.JSZipObject, remainingBytes: number): Promise<string> {
	const limit = Math.min(MAX_ZIP_ENTRY_UNCOMPRESSED_BYTES, remainingBytes);
	const advertised = advertisedUncompressedSize(entry);
	if (limit <= 0 || advertised === undefined || advertised > limit) throw new Error("Suspicious ZIP entry size");
	return await new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let total = 0;
		let settled = false;
		const stream = entry.nodeStream("nodebuffer");
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			(stream as unknown as { destroy(): void }).destroy();
			reject(error);
		};
		stream.on("data", (chunk: Buffer) => {
			total += chunk.length;
			if (total > limit) {
				fail(new Error("ZIP entry exceeded extraction limit"));
				return;
			}
			chunks.push(chunk);
		});
		stream.on("error", fail);
		stream.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks, total).toString("utf8"));
		});
	});
}

function decodeXmlText(value: string): string {
	return value.replace(/&#(x[0-9a-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi, (entity, numeric: string | undefined, named: string | undefined) => {
		if (numeric) {
			const codePoint = Number.parseInt(numeric.startsWith("x") ? numeric.slice(1) : numeric, numeric.startsWith("x") ? 16 : 10);
			return Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		return ({ amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" } as Record<string, string>)[named?.toLowerCase() ?? ""] ?? entity;
	});
}

function matchesAsciiCaseInsensitiveAt(value: string, expected: string, offset: number): boolean {
	if (offset < 0 || offset + expected.length > value.length) return false;
	for (let index = 0; index < expected.length; index++) {
		const actualCode = value.charCodeAt(offset + index);
		const expectedCode = expected.charCodeAt(index);
		const foldedActual = actualCode >= 65 && actualCode <= 90 ? actualCode + 32 : actualCode;
		const foldedExpected = expectedCode >= 65 && expectedCode <= 90 ? expectedCode + 32 : expectedCode;
		if (foldedActual !== foldedExpected) return false;
	}
	return true;
}

function isXmlWhitespace(value: string | undefined): boolean {
	return value === " " || value === "\t" || value === "\n" || value === "\r";
}

function findClosingTag(xml: string, closingTag: string, from: number): number {
	let cursor = from;
	while (cursor < xml.length) {
		const candidate = xml.indexOf("<", cursor);
		if (candidate < 0) return -1;
		if (matchesAsciiCaseInsensitiveAt(xml, closingTag, candidate)) return candidate;
		cursor = candidate + 1;
	}
	return -1;
}

function extractXmlText(xml: string, tag: "w:t" | "a:t"): string {
	const openingTag = `<${tag}`;
	const closingTag = `</${tag}>`;
	const parts: string[] = [];
	let cursor = 0;
	let nodes = 0;

	while (cursor < xml.length && nodes < MAX_XML_TEXT_NODES) {
		const candidate = xml.indexOf("<", cursor);
		if (candidate < 0) break;
		cursor = candidate + 1;
		if (!matchesAsciiCaseInsensitiveAt(xml, openingTag, candidate)) continue;

		const boundary = xml[candidate + openingTag.length];
		if (boundary !== ">" && !isXmlWhitespace(boundary)) continue;
		const openingEnd = xml.indexOf(">", candidate + openingTag.length);
		const nestedOpening = xml.indexOf("<", candidate + openingTag.length);
		if (openingEnd < 0 || (nestedOpening >= 0 && nestedOpening < openingEnd)) {
			throw new Error("Malformed OOXML text opening tag");
		}

		const contentStart = openingEnd + 1;
		const closingStart = findClosingTag(xml, closingTag, contentStart);
		if (closingStart < 0) throw new Error("Unclosed OOXML text node");

		nodes++;
		const text = decodeXmlText(xml.slice(contentStart, closingStart)).trim();
		if (text) parts.push(text);
		cursor = closingStart + closingTag.length;
	}
	return parts.join(" ");
}

function assertBoundedZipDirectory(bytes: Uint8Array): void {
	// Reject huge central directories before JSZip allocates one object per
	// attacker-controlled entry. ZIP64 sentinel values are intentionally not
	// accepted for browser-sized attachments.
	const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const searchStart = Math.max(0, view.length - 65_557);
	for (let offset = view.length - 22; offset >= searchStart; offset--) {
		if (view.readUInt32LE(offset) !== 0x06054b50) continue;
		const diskEntries = view.readUInt16LE(offset + 8);
		const totalEntries = view.readUInt16LE(offset + 10);
		const centralSize = view.readUInt32LE(offset + 12);
		const centralOffset = view.readUInt32LE(offset + 16);
		if (diskEntries === totalEntries
			&& totalEntries <= MAX_ZIP_ENTRIES
			&& centralOffset + centralSize <= offset) return;
	}
	throw new Error("ZIP end record is missing");
}

async function loadZip(bytes: Uint8Array): Promise<JSZip> {
	assertBoundedZipDirectory(bytes);
	const { default: JSZipConstructor } = await import("jszip");
	const zip = await JSZipConstructor.loadAsync(bytes, { createFolders: false, checkCRC32: false });
	if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) throw new Error("ZIP contains too many entries");
	return zip;
}

async function extractXmlEntries(zip: JSZip, names: string[], tag: "w:t" | "a:t", label: (name: string, index: number) => string): Promise<string | undefined> {
	if (names.length === 0 || names.length > MAX_SELECTED_ZIP_ENTRIES) return undefined;
	let remaining = MAX_ZIP_SELECTED_UNCOMPRESSED_BYTES;
	let output = "";
	for (let index = 0; index < names.length; index++) {
		const entry = zip.file(names[index]);
		if (!entry || entry.dir) continue;
		const advertised = advertisedUncompressedSize(entry);
		if (advertised === undefined || advertised > remaining) throw new Error("Suspicious ZIP aggregate size");
		const xml = await readBoundedZipEntry(entry, remaining);
		remaining -= Buffer.byteLength(xml, "utf8");
		const extracted = extractXmlText(xml, tag);
		if (!extracted) continue;
		const appended = appendBounded(output, `${output ? "\n" : ""}${label(names[index], index)}${extracted}`);
		output = appended.text;
		if (appended.full) break;
	}
	return normalizeExtractedText(output);
}

async function extractDocx(bytes: Uint8Array): Promise<string | undefined> {
	const zip = await loadZip(bytes);
	if (!zip.file("word/document.xml")) return undefined;
	const names = Object.keys(zip.files)
		.filter((name) => /^word\/(?:document|header\d+|footer\d+)\.xml$/i.test(name))
		.sort((left, right) => left === "word/document.xml" ? -1 : right === "word/document.xml" ? 1 : left.localeCompare(right));
	return extractXmlEntries(zip, names, "w:t", (name) => name === "word/document.xml" ? "" : `\n[${name}]\n`);
}

function numericEntrySort(left: string, right: string): number {
	const leftNumber = Number.parseInt(left.match(/(\d+)\.xml$/)?.[1] ?? "0", 10);
	const rightNumber = Number.parseInt(right.match(/(\d+)\.xml$/)?.[1] ?? "0", 10);
	return leftNumber - rightNumber;
}

async function extractPptx(bytes: Uint8Array): Promise<string | undefined> {
	const zip = await loadZip(bytes);
	const slides = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort(numericEntrySort).slice(0, MAX_PRESENTATION_PAGES);
	if (slides.length === 0) return undefined;
	const notes = Object.keys(zip.files).filter((name) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(name)).sort(numericEntrySort).slice(0, MAX_PRESENTATION_PAGES);
	return extractXmlEntries(zip, [...slides, ...notes], "a:t", (name, index) => {
		const number = name.match(/(\d+)\.xml$/)?.[1] ?? String(index + 1);
		return name.includes("notesSlides") ? `[Slide ${number} notes]\n` : `[Slide ${number}]\n`;
	});
}

/**
 * Derive bounded text only from the exact admitted bytes. Client-provided
 * extraction is intentionally not accepted by this API. Malformed, empty, or
 * suspicious specialized documents fail closed to pointer-only delivery.
 */
export async function deriveSpecializedDocumentText(input: {
	fileName: string;
	mimeType: string;
	bytes: Uint8Array;
}): Promise<SpecializedDocumentExtraction> {
	const kind = specializedKind(input.fileName, input.mimeType, input.bytes);
	if (!kind) return { recognized: false };
	if (input.bytes.byteLength > MAX_SPECIALIZED_INPUT_BYTES) return { recognized: true };
	try {
		const text = kind === "pdf"
			? await extractPdfTextInIsolate(input.bytes)
			: kind === "docx"
				? await extractDocx(input.bytes)
				: await extractPptx(input.bytes);
		return text === undefined ? { recognized: true } : { recognized: true, text };
	} catch {
		return { recognized: true };
	}
}
