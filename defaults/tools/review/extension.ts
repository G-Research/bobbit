/**
 * Review extension — open and close markdown documents in the review pane.
 *
 * Registers `review_open` and `review_close` tools. Unlike preview_open,
 * these tools do NOT call gateway APIs — they return JSON in the tool result
 * for the client to parse and act on.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const commonOpenProperties = {
	title: Type.Optional(Type.String({ description: "Review title. Defaults to filename or 'Review'." })),
	replace: Type.Optional(Type.Boolean({ description: "Replace an existing same-title review. Default true." })),
};

const reviewFileSchema = Type.Union([
	Type.Object({
		title: Type.Optional(Type.String({ description: "File tab title. Defaults to 'File N'." })),
		markdown: Type.String({ description: "Inline Markdown content." }),
	}, { additionalProperties: false }),
	Type.Object({
		title: Type.Optional(Type.String({ description: "File tab title. Defaults to the file basename." })),
		file: Type.String({ description: "Path to a Markdown file on disk." }),
	}, { additionalProperties: false }),
]);

const reviewOpenSchema = Type.Union([
	Type.Object({
		...commonOpenProperties,
		markdown: Type.String({ description: "Inline Markdown content." }),
	}, { additionalProperties: false }),
	Type.Object({
		...commonOpenProperties,
		file: Type.String({ description: "Path to a Markdown file on disk." }),
	}, { additionalProperties: false }),
	Type.Object({
		...commonOpenProperties,
		files: Type.Array(reviewFileSchema, {
			minItems: 1,
			description: "Ordered Markdown files belonging to this review.",
		}),
	}, { additionalProperties: false }),
]);

type ReviewFileInput = { title?: string; markdown: string } | { title?: string; file: string };
type ReviewOpenInput =
	| { title?: string; replace?: boolean; markdown: string }
	| { title?: string; replace?: boolean; file: string }
	| { title?: string; replace?: boolean; files: ReviewFileInput[] };

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function validateKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, context: string): string | null {
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	return unexpected ? `${context} contains unexpected property '${unexpected}'.` : null;
}

function validateReviewOpenInput(value: unknown): string | null {
	if (!isRecord(value)) return "Parameters must be an object.";

	const keyError = validateKeys(value, new Set(["title", "replace", "markdown", "file", "files"]), "Parameters");
	if (keyError) return keyError;
	if (hasOwn(value, "title") && typeof value.title !== "string") return "'title' must be a string.";
	if (hasOwn(value, "replace") && typeof value.replace !== "boolean") return "'replace' must be a boolean.";

	const sourceKeys = ["markdown", "file", "files"].filter((key) => hasOwn(value, key));
	if (sourceKeys.length !== 1) {
		return "Exactly one of 'markdown', 'file', or 'files' must be provided.";
	}
	if (sourceKeys[0] === "markdown") {
		return typeof value.markdown === "string" ? null : "'markdown' must be a string.";
	}
	if (sourceKeys[0] === "file") {
		return typeof value.file === "string" ? null : "'file' must be a string.";
	}
	if (!Array.isArray(value.files) || value.files.length === 0) {
		return "'files' must be a non-empty array.";
	}
	for (let index = 0; index < value.files.length; index++) {
		const entry = value.files[index];
		if (!isRecord(entry)) return `'files[${index}]' must be an object.`;
		const entryError = validateKeys(entry, new Set(["title", "markdown", "file"]), `'files[${index}]'`);
		if (entryError) return entryError;
		if (hasOwn(entry, "title") && typeof entry.title !== "string") {
			return `'files[${index}].title' must be a string.`;
		}
		const entrySources = ["markdown", "file"].filter((key) => hasOwn(entry, key));
		if (entrySources.length !== 1) {
			return `'files[${index}]' must provide exactly one of 'markdown' or 'file'.`;
		}
		if (typeof entry[entrySources[0]] !== "string") {
			return `'files[${index}].${entrySources[0]}' must be a string.`;
		}
	}
	return null;
}

function errorResult(message: string) {
	return { content: [{ type: "text" as const, text: `Error: ${message}` }], details: undefined };
}

function readMarkdownFile(file: string): { markdown: string } | { error: string } {
	const cwd = process.env.BOBBIT_CWD || process.cwd();
	const filePath = path.isAbsolute(file) ? file : path.resolve(cwd, file);

	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return { error: `File not found: "${file}"` };
	}
	if (!stat.isFile()) return { error: `"${file}" is not a file.` };

	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buffer = Buffer.alloc(8192);
		const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
		for (let index = 0; index < bytesRead; index++) {
			if (buffer[index] === 0) return { error: `"${file}" appears to be a binary file.` };
		}
	} catch (error) {
		return { error: `Error reading file "${file}": ${error instanceof Error ? error.message : String(error)}` };
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}

	try {
		return { markdown: fs.readFileSync(filePath, "utf-8") };
	} catch (error) {
		return { error: `Error reading file "${file}": ${error instanceof Error ? error.message : String(error)}` };
	}
}

const extension: ExtensionFactory = (pi) => {
	// ── review_open ──

	pi.registerTool({
		name: "review_open",
		label: "Review Open",
		description: "Open one or more Markdown files as a single review for inline commenting.",
		parameters: reviewOpenSchema,

		async execute(_toolCallId, rawParams) {
			const validationError = validateReviewOpenInput(rawParams);
			if (validationError) return errorResult(validationError);
			const params = rawParams as ReviewOpenInput;
			const isMultiFile = "files" in params;
			const inputs: ReviewFileInput[] = isMultiFile
				? params.files
				: ["markdown" in params ? { markdown: params.markdown } : { file: params.file }];
			const defaultReviewTitle = !isMultiFile && "file" in params
				? path.basename(params.file)
				: "Review";
			const title = params.title ?? defaultReviewTitle;
			const files: Array<{ fileId: string; title: string; markdown: string }> = [];

			for (let index = 0; index < inputs.length; index++) {
				const input = inputs[index];
				let markdown: string;
				if ("markdown" in input) {
					markdown = input.markdown;
				} else {
					const loaded = readMarkdownFile(input.file);
					if ("error" in loaded) return errorResult(loaded.error);
					markdown = loaded.markdown;
				}
				const fileTitle = isMultiFile
					? input.title ?? ("file" in input ? path.basename(input.file) : `File ${index + 1}`)
					: title;
				files.push({ fileId: randomUUID(), title: fileTitle, markdown });
			}

			const result = {
				action: "review_open",
				reviewId: randomUUID(),
				title,
				files,
				replace: params.replace !== false,
			};
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});

	// ── review_close ──

	pi.registerTool({
		name: "review_close",
		label: "Review Close",
		description: "Close a review document tab or all review tabs.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Specific tab. Omit to close all." })),
		}),

		async execute(_toolCallId, params) {
			const result = {
				action: "review_close",
				title: params.title || null,
			};

			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});
};

export default extension;
