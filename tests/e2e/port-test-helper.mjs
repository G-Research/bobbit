/**
 * Helper script for port auto-increment tests.
 * 
 * Environment variables:
 *   BOBBIT_DIR     — isolated .bobbit directory
 *   TEST_PORT      — port to attempt binding
 *   TEST_EXPLICIT  — "true" if portExplicit should be true
 *   MOCK_AGENT     — path to mock agent
 *   TEST_MODE      — "bind-and-report" | "bind-and-serve" | "explicit-fail"
 */
import { createGateway } from "../../dist/server/server.js";
import { setProjectRoot } from "../../dist/server/bobbit-dir.js";
import { scaffoldBobbitDir } from "../../dist/server/scaffold.js";
import { loadOrCreateToken } from "../../dist/server/auth/token.js";
import fs from "node:fs";
import path from "node:path";

setProjectRoot(process.cwd());
scaffoldBobbitDir(process.cwd());
const authToken = loadOrCreateToken(false);

const port = parseInt(process.env.TEST_PORT, 10);
const portExplicit = process.env.TEST_EXPLICIT === "true";
const mode = process.env.TEST_MODE || "bind-and-report";
const bobbitDir = process.env.BOBBIT_DIR;

const gateway = createGateway({
	host: "127.0.0.1",
	port,
	portExplicit,
	authToken,
	defaultCwd: process.cwd(),
	agentCliPath: process.env.MOCK_AGENT,
});

try {
	const actualPort = await gateway.start();

	if (mode === "bind-and-serve") {
		// Write actual port to state dir and keep running
		const stateDir = path.join(bobbitDir, "state");
		fs.writeFileSync(path.join(stateDir, "actual-port"), String(actualPort));
		fs.writeFileSync(path.join(stateDir, "gateway-url"), `http://127.0.0.1:${actualPort}`);
		console.log(`BOUND:${actualPort}`);
		// Keep alive until killed
		await new Promise(() => {});
	} else {
		// Report and exit
		console.log(`OK:${actualPort}`);
		await gateway.shutdown();
		process.exit(0);
	}
} catch (err) {
	if (err.code === "EADDRINUSE") {
		console.log("EADDRINUSE");
		process.exit(0);
	}
	console.error("ERROR:" + err.message);
	process.exit(1);
}
