/**
 * Helper script for port-auto-increment E2E tests.
 *
 * Environment variables:
 *   BOBBIT_DIR    — isolated .bobbit directory
 *   TEST_PORT     — port to attempt binding
 *   TEST_MODE     — "bind-and-serve" (stay running) or "bind-and-report" (print result + exit)
 *   TEST_EXPLICIT — "true" or "false" for portExplicit
 *   MOCK_AGENT    — path to mock agent script
 */
import { setProjectRoot, bobbitStateDir } from "../../dist/server/bobbit-dir.js";
import { scaffoldBobbitDir } from "../../dist/server/scaffold.js";
import { createGateway } from "../../dist/server/server.js";
import { loadOrCreateToken } from "../../dist/server/auth/token.js";
import fs from "node:fs";
import path from "node:path";

const bobbitDir = process.env.BOBBIT_DIR;
const port = parseInt(process.env.TEST_PORT, 10);
const mode = process.env.TEST_MODE; // "bind-and-serve" | "bind-and-report"
const portExplicit = process.env.TEST_EXPLICIT === "true";
const mockAgent = process.env.MOCK_AGENT;

if (!bobbitDir || !port || !mode) {
	console.error("Missing required env vars: BOBBIT_DIR, TEST_PORT, TEST_MODE");
	process.exit(2);
}

// Set up project root and scaffold
setProjectRoot(bobbitDir);
scaffoldBobbitDir(bobbitDir);

const authToken = loadOrCreateToken(false);

const gateway = createGateway({
	host: "127.0.0.1",
	port,
	portExplicit,
	authToken,
	defaultCwd: bobbitDir,
	agentCliPath: mockAgent,
	forceAuth: true,
});

try {
	const actualPort = await gateway.start();

	// Write state files that cli.ts normally writes — tests check these
	const stateDir = bobbitStateDir();
	fs.writeFileSync(path.join(stateDir, "actual-port"), String(actualPort), "utf-8");
	fs.writeFileSync(path.join(stateDir, "gateway-url"), `http://127.0.0.1:${actualPort}`, "utf-8");

	if (mode === "bind-and-report") {
		console.log(`OK:${actualPort}`);
		await gateway.shutdown();
		process.exit(0);
	}
	// bind-and-serve: keep running — the test will kill us
} catch (err) {
	if (err.code === "EADDRINUSE" || (err.message && err.message.includes("EADDRINUSE"))) {
		console.error(`EADDRINUSE: port ${port} is occupied`);
		if (mode === "bind-and-report") {
			process.exit(0);
		}
	}
	console.error(err);
	process.exit(1);
}
