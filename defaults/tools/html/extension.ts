/**
 * HTML Preview extension — open the preview side-panel in the Bobbit UI.
 *
 * Both `html=` and `file=` populate a per-session preview mount served at
 * `/preview/<sid>/`. Sibling assets resolve as relative URLs. The tool
 * result is a constant ~150-byte v3 snapshot regardless of HTML size.
 *
 * Flow:
 *   1. Read sessionId from BOBBIT_SESSION_ID. (No-session fallback writes
 *      a local file and returns.)
 *   2. PATCH /api/sessions/:id { preview: true }.
 *   3. POST /api/preview/mount?sessionId=<sid> with one of {html} or
 *      {file: absolutePath}. Returns {url, path, entry, mtime}.
 *   4. Stamp v3 marker into the tool result.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPreviewSnapshotV3Block } from "./snapshot.js";

// ── Gateway API helpers ──

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

// ── Extension registration ──

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "preview_open",
		label: "Preview Open",
		description: "Open or update the HTML preview panel. Auto-refreshes on re-call.",
		parameters: Type.Object({
			html: Type.Optional(Type.String({ description: "Raw HTML. Takes priority over `file`." })),
			file: Type.Optional(Type.String({ description: "Path to an HTML entry file." })),
			assets: Type.Optional(Type.Array(Type.String(), { description: "Sibling asset paths relative to entry. Supports single-segment globs." })),
			manifest: Type.Optional(Type.String({ description: "Path to JSON manifest { assets: [...] } relative to entry." })),
		}),

		async execute(_toolCallId, params) {
			const sessionId = process.env.BOBBIT_SESSION_ID;

			if (!params.html && !params.file) {
				return { content: [{ type: "text", text: "Error: At least one of 'html' or 'file' must be provided." }] };
			}

			// No session ID — fallback: write directly to disk.
			if (!sessionId) {
				try {
					let content = params.html ?? "";
					if (!params.html && params.file) {
						try {
							content = fs.readFileSync(params.file, "utf-8");
						} catch (err: any) {
							return { content: [{ type: "text", text: `Error reading file "${params.file}": ${err.message}` }] };
						}
					}
					const stateDir = process.env.BOBBIT_DIR
						? path.join(process.env.BOBBIT_DIR, "state")
						: path.join(os.homedir(), ".pi");
					const fallbackPath = path.join(stateDir, `preview-unknown.html`);
					fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
					fs.writeFileSync(fallbackPath, content, "utf-8");
					return { content: [{ type: "text", text: `No session ID available. Wrote preview HTML to ${fallbackPath}` }] };
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error: No session ID and failed to write fallback file: ${err.message}` }] };
				}
			}

			try {
				// Step 1: enable preview mode on the session.
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: true }),
				});
				if (!patchResp.ok) {
					const errText = await patchResp.text();
					return { content: [{ type: "text", text: `Error enabling preview mode: ${patchResp.status} ${errText}` }] };
				}

				// Step 2: build mount-endpoint body. `html` wins when both are present.
				let mountBody: { html?: string; file?: string; assets?: string[]; manifest?: string };
				if (params.html != null) {
					mountBody = { html: params.html };
				} else {
					// Resolve relative paths against process.cwd(). The agent's cwd is
					// host-visible (worktrees are bind-mounted in WP-F), so the gateway
					// can read this absolute path directly. No translation needed.
					const filePath = params.file as string;
					const absPath = path.isAbsolute(filePath)
						? filePath
						: path.resolve(process.cwd(), filePath);
					mountBody = { file: absPath };
					if (Array.isArray(params.assets) && params.assets.length > 0) {
						mountBody.assets = params.assets as string[];
					}
					if (typeof params.manifest === "string" && params.manifest.length > 0) {
						mountBody.manifest = params.manifest;
					}
				}

				// Step 3: POST the mount endpoint.
				const mountResp = await gatewayFetch(
					`/api/preview/mount?sessionId=${encodeURIComponent(sessionId)}`,
					{
						method: "POST",
						body: JSON.stringify(mountBody),
					},
				);
				if (!mountResp.ok) {
					const errText = await mountResp.text().catch(() => "");
					return {
						content: [{
							type: "text",
							text: `Error opening preview: ${mountResp.status} ${errText}`,
						}],
					};
				}
				const mountResult = await mountResp.json().catch(() => ({} as any)) as {
					url?: string;
					path?: string;
					relPath?: string;
					entry?: string;
					mtime?: number;
				};
				if (typeof mountResult.url !== "string" || mountResult.url.length === 0 ||
					typeof mountResult.path !== "string" || mountResult.path.length === 0) {
					return {
						content: [{
							type: "text",
							text: `Error opening preview: malformed response from /api/preview/mount`,
						}],
					};
				}

				// Step 4: stamp v3 marker. Constant-size payload regardless of HTML.
				//
				// Prefer the short, host-invariant `<sid>/<entry>` form returned by
				// newer gateways (see `MountResult.relPath` in src/server/preview/mount.ts).
				// Fall back to the host-absolute `path` when talking to an older
				// gateway build that doesn't populate `relPath` — the v3 contract
				// only requires a non-empty string here, so the marker still parses.
				const snapshotPath = (typeof mountResult.relPath === "string" && mountResult.relPath.length > 0)
					? mountResult.relPath
					: mountResult.path;
				return {
					content: [
						{ type: "text", text: "Preview panel is open and will auto-update." },
						{ type: "text", text: buildPreviewSnapshotV3Block(mountResult.url, snapshotPath) },
					],
				};
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error opening preview: ${err.message}` }] };
			}
		},
	});
};

export default extension;
