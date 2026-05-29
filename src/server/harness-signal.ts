#!/usr/bin/env node

/**
 * Sends a restart signal to the dev server harness by touching the sentinel file.
 *
 * Usage:
 *   node dist/server/harness-signal.js
 *   npm run restart-server
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bobbitStateDir } from "./bobbit-dir.js";

export function restartSentinelPath(): string {
	return path.join(bobbitStateDir(), "gateway-restart");
}

export function touchGatewayRestartSentinel(now = Date.now()): string {
	const sentinel = restartSentinelPath();
	const dir = path.dirname(sentinel);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}

	// Write a timestamp to change the mtime
	fs.writeFileSync(sentinel, now.toString(), "utf-8");
	return sentinel;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	touchGatewayRestartSentinel();
	console.log("[restart-server] Signal sent — harness will rebuild and restart.");
}
