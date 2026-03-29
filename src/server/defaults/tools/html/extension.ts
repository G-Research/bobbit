/**
 * HTML Preview extension — open and close an HTML preview panel in the Bobbit UI.
 *
 * Registers `preview_open` and `preview_close` tools that let agents show
 * live HTML previews alongside the chat.
 */

import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ── Gateway API helpers (copied from agent/extension.ts) ──

function getGatewayUrl(): string {
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

	// Disable TLS verification for self-signed certs
	process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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
		description:
			"Open an HTML preview panel in the Bobbit UI. Provide raw HTML content or a path to an HTML file. " +
			"The preview panel appears alongside the chat and auto-updates when you call this tool again.",
		parameters: Type.Object({
			html: Type.Optional(Type.String({ description: "Raw HTML content to preview. Takes priority over 'file' if both are provided." })),
			file: Type.Optional(Type.String({ description: "Path to an HTML file to load and preview." })),
		}),

		async execute(_toolCallId, params) {
			const sessionId = process.env.BOBBIT_SESSION_ID;

			// Resolve HTML content
			let content: string;
			if (params.html) {
				content = params.html;
			} else if (params.file) {
				try {
					content = fs.readFileSync(params.file, "utf-8");
				} catch (err: any) {
					return { content: [{ type: "text", text: `Error reading file "${params.file}": ${err.message}` }] };
				}
			} else {
				return { content: [{ type: "text", text: "Error: At least one of 'html' or 'file' must be provided." }] };
			}

			if (!sessionId) {
				// Fallback: write directly to disk
				try {
					const stateDir = process.env.BOBBIT_DIR
						? path.join(process.env.BOBBIT_DIR, "state")
						: path.join(os.homedir(), ".pi");
					const fallbackPath = path.join(stateDir, `preview-${sessionId || "unknown"}.html`);
					fs.mkdirSync(path.dirname(fallbackPath), { recursive: true });
					fs.writeFileSync(fallbackPath, content, "utf-8");
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

				// Step 2: Write the HTML content to the preview endpoint
				const postResp = await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
					method: "POST",
					body: JSON.stringify({ html: content }),
				});
				if (!postResp.ok) {
					const errText = await postResp.text();
					return { content: [{ type: "text", text: `Error writing preview HTML: ${postResp.status} ${errText}` }] };
				}

				return { content: [{ type: "text", text: "Preview panel is open and will auto-update." }] };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error opening preview: ${err.message}` }] };
			}
		},
	});

	pi.registerTool({
		name: "preview_close",
		label: "Preview Close",
		description: "Close the HTML preview panel in the Bobbit UI.",
		parameters: Type.Object({}),

		async execute() {
			const sessionId = process.env.BOBBIT_SESSION_ID;

			if (!sessionId) {
				return { content: [{ type: "text", text: "No session ID available — preview panel may already be closed." }] };
			}

			try {
				// Step 1: Disable preview mode
				const patchResp = await gatewayFetch(`/api/sessions/${sessionId}`, {
					method: "PATCH",
					body: JSON.stringify({ preview: false }),
				});
				if (!patchResp.ok) {
					const errText = await patchResp.text();
					return { content: [{ type: "text", text: `Error disabling preview mode: ${patchResp.status} ${errText}` }] };
				}

				// Step 2: Clear the preview content
				const postResp = await gatewayFetch(`/api/preview?sessionId=${encodeURIComponent(sessionId)}`, {
					method: "POST",
					body: JSON.stringify({ html: "" }),
				});
				if (!postResp.ok) {
					const errText = await postResp.text();
					return { content: [{ type: "text", text: `Error clearing preview content: ${postResp.status} ${errText}` }] };
				}

				return { content: [{ type: "text", text: "Preview panel is closed." }] };
			} catch (err: any) {
				return { content: [{ type: "text", text: `Error closing preview: ${err.message}` }] };
			}
		},
	});
};

export default extension;
