/**
 * Global teardown for coverage runs.
 *
 * On Windows, Playwright hard-kills the webServer process (no graceful shutdown),
 * which prevents V8 from flushing NODE_V8_COVERAGE data. This teardown sends
 * a POST /api/shutdown request to the server BEFORE Playwright kills it,
 * giving the process time to call process.exit(0) and flush coverage.
 *
 * After the server exits, it also cleans up the ephemeral .bobbit directory.
 */

import http from "node:http";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

function shutdownServer(port: number, token: string): Promise<void> {
	return new Promise((resolve) => {
		const req = http.request(
			{
				hostname: "127.0.0.1",
				port,
				path: "/api/shutdown",
				method: "POST",
				timeout: 5000,
				headers: {
					Authorization: `Bearer ${token}`,
				},
			},
			() => resolve(),
		);
		req.on("error", () => resolve()); // server may already be gone
		req.on("timeout", () => {
			req.destroy();
			resolve();
		});
		req.end();
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export default async function globalTeardown() {
	const port = Number(process.env.E2E_PORT);
	if (port) {
		// Read the auth token from the ephemeral bobbit dir
		let token = "";
		const bobbitDir = process.env.BOBBIT_DIR;
		if (bobbitDir) {
			try {
				token = readFileSync(path.join(bobbitDir, "state", "token"), "utf-8").trim();
			} catch {
				// token file may not exist
			}
		}
		if (token) {
			await shutdownServer(port, token);
			// Give the process time to flush V8 coverage data and exit
			await sleep(2000);
		}
	}

	// Clean up ephemeral bobbit dir
	const bobbitDir = process.env.BOBBIT_DIR;
	if (bobbitDir && bobbitDir.includes(".e2e-bobbit-")) {
		try {
			rmSync(bobbitDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup
		}
	}
}
