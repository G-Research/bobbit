/**
 * Review extension — open and close markdown documents in the review pane.
 *
 * Registers `review_open` and `review_close` tools. Unlike preview_open,
 * these tools do NOT call gateway APIs — they return JSON in the tool result
 * for the client to parse and act on.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";

const extension: ExtensionFactory = (pi) => {
	// ── review_open ──

	pi.registerTool({
		name: "review_open",
		label: "Review Open",
		description:
			"Open a markdown document in the review pane for inline commenting and annotation. " +
			"Pass `markdown` for inline content or `file` to load from disk.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Tab label. Defaults to filename or \"Review\"." })),
			markdown: Type.Optional(Type.String({ description: "Inline markdown content." })),
			file: Type.Optional(Type.String({ description: "Path to a markdown file on disk." })),
			replace: Type.Optional(Type.Boolean({ description: "Replace existing tab content (default: true)." })),
		}),

		async execute(_toolCallId, params) {
			// Resolve content
			let content: string;

			if (params.markdown) {
				content = params.markdown;
			} else if (params.file) {
				const cwd = process.env.BOBBIT_CWD || process.cwd();
				const filePath = path.isAbsolute(params.file)
					? params.file
					: path.resolve(cwd, params.file);

				// Validate exists and is a file
				let stat: fs.Stats;
				try {
					stat = fs.statSync(filePath);
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: File not found: "${params.file}"` }] };
				}
				if (!stat.isFile()) {
					return { content: [{ type: "text", text: `Error: "${params.file}" is not a file.` }] };
				}

				// Check for binary content (null bytes in first 8KB)
				const fd = fs.openSync(filePath, "r");
				try {
					const buf = Buffer.alloc(8192);
					const bytesRead = fs.readSync(fd, buf, 0, 8192, 0);
					for (let i = 0; i < bytesRead; i++) {
						if (buf[i] === 0) {
							return { content: [{ type: "text", text: `Error: "${params.file}" appears to be a binary file.` }] };
						}
					}
				} finally {
					fs.closeSync(fd);
				}

				try {
					content = fs.readFileSync(filePath, "utf-8");
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error reading file "${params.file}": ${err.message}` }] };
				}
			} else {
				return { content: [{ type: "text", text: "Error: At least one of 'markdown' or 'file' must be provided." }] };
			}

			// Resolve title
			const title = params.title
				|| (params.file ? path.basename(params.file) : "Review");

			const result = {
				action: "review_open",
				title,
				markdown: content,
				replace: params.replace !== false,
			};

			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		},
	});

	// ── review_close ──

	pi.registerTool({
		name: "review_close",
		label: "Review Close",
		description: "Close a review document tab or all review tabs.",
		parameters: Type.Object({
			title: Type.Optional(Type.String({ description: "Close specific tab. Omit to close all tabs." })),
		}),

		async execute(_toolCallId, params) {
			const result = {
				action: "review_close",
				title: params.title || null,
			};

			return { content: [{ type: "text", text: JSON.stringify(result) }] };
		},
	});
};

export default extension;
