/**
 * orient extension — self-description ("whoami") tool.
 *
 * Registers a single `orient()` tool that proxies to the gateway endpoint
 * `GET /api/internal/orient`. The server-side endpoint assembles the payload
 * from state it already holds (SessionInfo/PersistedSession, GoalRecord,
 * RegisteredProject, package.json version) — see
 * `src/server/agent/orient.ts` for the shape and design rationale
 * (Finding W2.15).
 *
 * Response shape from the gateway:
 *   { gateway, apiRouteFamilies, session, project, goal }   // success
 *   { error: string }                                        // failure
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const urlPath = path.join(bobbitDir, "state", "gateway-url");
	return fs.readFileSync(urlPath, "utf-8").trim();
}

function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	const bobbitDir = process.env.BOBBIT_DIR || path.join(os.homedir(), ".bobbit");
	const tokenPath = path.join(bobbitDir, "state", "token");
	return fs.readFileSync(tokenPath, "utf-8").trim();
}

async function callOrient(): Promise<any> {
	const gwUrl = getGatewayUrl();
	const token = getGatewayToken();
	const url = new URL(gwUrl + "/api/internal/orient");
	const mod: any = url.protocol === "https:" ? await import("node:https") : await import("node:http");
	return await new Promise((resolve, reject) => {
		const req = mod.request(url, {
			method: "GET",
			headers: {
				"Authorization": "Bearer " + token,
				"X-Bobbit-Session-Id": process.env.BOBBIT_SESSION_ID || "",
			},
			...(url.protocol === "https:" ? { rejectUnauthorized: false } : {}),
		}, (res: any) => {
			let data = "";
			res.on("data", (chunk: Buffer | string) => { data += chunk; });
			res.on("end", () => {
				try { resolve(JSON.parse(data)); }
				catch { resolve({ error: data || `HTTP ${res.statusCode}` }); }
			});
		});
		req.on("error", reject);
		req.end();
	});
}

const extension: ExtensionFactory = (pi) => {
	pi.registerTool({
		name: "orient",
		label: "Orient",
		description: "Return your own session/goal/project identity and gateway facts (whoami). No parameters.",
		promptSnippet:
			"orient() - Who/where am I: session id, goal, role, project, worktree, gateway version/URL. No params.",
		promptGuidelines: [
			"Call orient() instead of guessing your own session id, goal, role, or worktree path from context.",
			"orient() reports only YOUR OWN identity — for the whole team roster use team_list (team-lead only).",
		],
		parameters: Type.Object({}),

		async execute() {
			let result: any;
			try {
				result = await callOrient();
			} catch (err: any) {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${err?.message ?? String(err)}` }],
				};
			}
			if (result && typeof result.error === "string") {
				return {
					isError: true,
					content: [{ type: "text", text: `error: ${result.error}` }],
				};
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
			};
		},
	});
};

export default extension;
