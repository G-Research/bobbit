// Shared helpers for resolving Bobbit gateway URL + auth token from the on-disk
// state directory (or env overrides). Used by tool extensions that need to call
// back into the gateway (e.g. image-generation, tool activation).
//
// NOTE: `defaults/tools/agent/tool-activation.ts` has a near-identical copy of
// these helpers. Deduplicating there is left to a follow-up PR so this file's
// initial introduction is conflict-free with PR #369's review fixes.

import fs from "node:fs";
import path from "node:path";

function stateDir(): string {
	if (process.env.BOBBIT_DIR) return path.join(process.env.BOBBIT_DIR, "state");
	// No silent fallback to ~/.pi: tool extensions run inside an agent process
	// whose env is set up by the gateway. If BOBBIT_DIR is missing, the caller
	// is mis-configured and we want a loud error rather than guessing a path.
	throw new Error("BOBBIT_DIR not set; cannot resolve gateway");
}

export function getGatewayUrl(): string {
	if (process.env.BOBBIT_GATEWAY_URL) {
		return process.env.BOBBIT_GATEWAY_URL.replace(/\/+$/, "");
	}
	return fs.readFileSync(path.join(stateDir(), "gateway-url"), "utf-8").trim().replace(/\/+$/, "");
}

export function getGatewayToken(): string {
	if (process.env.BOBBIT_TOKEN) return process.env.BOBBIT_TOKEN;
	return fs.readFileSync(path.join(stateDir(), "token"), "utf-8").trim();
}
