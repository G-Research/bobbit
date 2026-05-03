/**
 * HTML Preview extension — open and close an HTML preview panel in the Bobbit UI.
 *
 * Registers the `preview_open` tool that lets agents show
 * live HTML previews alongside the chat.
 *
 * Two modes:
 *   - inline (`html:` parameter): bytes round-trip through the gateway and
 *     the chat transcript via the v1 snapshot marker.
 *   - file   (`file:` parameter): the gateway serves the HTML and sibling
 *     assets over HTTP. Only a tiny v2 marker carrying the file path is
 *     stamped into the tool result. Falls back to inline if the host
 *     gateway can't see the path (e.g. mis-mapped sandbox bind mount).
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PREVIEW_SNAPSHOT_MARKER, buildFileSnapshotBlock } from "./snapshot.js";

// ── Gateway API helpers (copied from agent/extension.ts) ──

function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	const stateDir = process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(os.homedir(), ".pi");
	const urlPath = path.join(stateDir, "gateway-url");
	if (fs.existsSync(urlPath)) {
		return fs.readFileSync(urlPath, "utf-8").trim();
	}
	throw new Error(`Gateway URL not found at ${urlPath} — is the gateway running?`);
}

function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	const stateDir = process.env.BOBBIT_DIR
		? path.join(process.env.BOBBIT_DIR, "state")
		: path.join(os.homedir(), ".pi");
	const tokenFile = process.env.BOBBIT_DIR ? "token" : "gateway-token";
	const tokenPath = path.join(stateDir, tokenFile);
	if (fs.existsSync(tokenPath)) {
		return fs.readFileSync(tokenPath, "utf-8").trim();
	}
	throw new Error(`Gateway token not found at ${tokenPath}`);
}

async function gatewayFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
	const url = getGatewayUrl();
	const token = getGatewayToken();

	return fetch(`${url}${endpoint}`, {
		...options,
		headers: {
			"Authorization": `Bearer ${token}`,
			"Content-Type": "application/json",
			...options.headers,
		},
	});
}

/**
 * Translate an in-container file path to its host equivalent when the agent
 * runs inside a sandbox. The gateway sets `BOBBIT_HOST_CWD` on every
 * sandboxed spawn to the host-side path that maps to `process.cwd()`. If
 * the input path falls under `process.cwd()`, we can rewrite it; otherwise
 * we return null and the caller falls back to inline mode.
 */
function translateToHostPath(filePath: string): string | null {
	const hostCwd = process.env.BOBBIT_HOST_CWD;
	if (!hostCwd) return filePath; // not sandboxed → trivially host-visible
	const cwd = process.cwd();
	const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
	const rel = path.relative(cwd, abs);
	if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
	// Use POSIX joining for the host path — the host might be Windows but
	// `BOBBIT_HOST_CWD` is preserved as-is (gateway-author's responsibility).
	return path.posix.join(hostCwd.replace(/\\/g, "/"), rel.replace(/\\/g, "/"));
}

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "preview_open",
		label: "Preview Open",
		description:
			"Open an HTML preview panel in the Bobbit UI. Provide raw HTML content or a path to an HTML file. " +
			"The preview panel appears alongside the chat and auto-updates when you call this tool again.",
		parameters: Type.Object({
			html: Type.Optional(Type.String({ description: "Raw HTML content to preview. Takes priority over 'file' if both are provided." })),
			file: Type.Optional(Type.String({ description: "Path to an HTML file to load and preview." })),
		}),

		async execute(_toolCallId, params) {
			const sessionId = process.env.BOBBIT_SESSION_ID;

			// Resolve mode: html: takes priority over file: when both supplied.
			const wantsFileMode = !params.html && !!params.file;
			let inlineContent: string | null = null;

			if (params.html) {
				inlineContent = params.html;
			} else if (params.file) {
				// Will read bytes lazily — only if the file mode falls back to inline.
				inlineContent = null;
			} else {
				return { content: [{ type: "text", text: "Error: At least one of 'html' or 'file' must be provided." }] };
			}

			// Helper: read file bytes for inline fallback.
			const readFileBytes = (filePath: string): { ok: true; bytes: string } | { ok: false; err: string } => {
				try {
					return { ok: true, bytes: fs.readFileSync(filePath, "utf-8") };
				} catch (err: any) {
					return { ok: false, err: err.message };
				}
			};

			// No session ID — fallback: write directly to disk.
			if (!sessionId) {
				try {
					if (inlineContent == null && params.file) {
						const r = readFileBytes(params.file);
						if (!r.ok) {
							return { content: [{ type: "text", text: `Error reading file "${params.file}": ${r.err}` }] };
						}
						inlineContent = r.bytes;
					}
					const stateDir = process.env.BOBBIT_DIR
						? path.join(process.env.BOBBIT_DIR, "state")
						: path.join(os.homedir(), ".pi");
					const fallbackPath = path.join(stateDir, `preview-unknown.html`);
					fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
					fs.writeFileSync(fallbackPath, inlineContent ?? "", "utf-8");
					return { content: [{ type: "text", text: `No session ID available. Wrote preview HTML to ${fallbackPath}` }] };
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: No session ID and failed to write fallback file: ${err.message}` }] };
				}
			}

			try {
				// Step 1: Enable preview mode on the session
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				if (!patchResp.ok) {
					const errText = await patchResp.text();
					return { content: [{ type: "text", text: `Error enabling preview mode: ${patchResp.status} ${errText}` }] };
				}

				// Step 2: try file mode first when the agent supplied file:.
				let warnings = "";
				if (wantsFileMode && params.file) {
					const hostPath = translateToHostPath(params.file);
					if (hostPath) {
						const fileResp = await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
							method: "POST",
							body: JSON.stringify({ kind: "file", path: hostPath }),
						});
						if (fileResp.ok) {
							return {
								content: [
									{ type: "text", text: "Preview panel is open and will auto-update." },
									{ type: "text", text: buildFileSnapshotBlock(hostPath) },
								],
							};
						}
						// Server rejected the path (e.g. not host-visible) — fall back.
						const errText = await fileResp.text().catch(() => "");
						warnings = `\n[preview_open] file-mode rejected (${fileResp.status} ${errText.slice(0, 200)}); falling back to inline.`;
					} else {
						warnings = "\n[preview_open] could not translate path to host (BOBBIT_HOST_CWD not set or path outside cwd); falling back to inline.";
					}
				}

				// Step 3: inline mode (existing behaviour).
				if (inlineContent == null && params.file) {
					const r = readFileBytes(params.file);
					if (!r.ok) {
						return { content: [{ type: "text", text: `Error reading file "${params.file}": ${r.err}` }] };
					}
					inlineContent = r.bytes;
				}
				const content = inlineContent ?? "";
				const postResp = await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
					method: "POST",
					body: JSON.stringify({ html: content }),
				});
				if (!postResp.ok) {
					const errText = await postResp.text();
					return { content: [{ type: "text", text: `Error writing preview HTML: ${postResp.status} ${errText}` }] };
				}

				return {
					content: [
						{ type: "text", text: "Preview panel is open and will auto-update." + warnings },
						{ type: "text", text: PREVIEW_SNAPSHOT_MARKER + content },
					],
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error opening preview: ${err.message}` }] };
			}
		},
	});


};

export default extension;
