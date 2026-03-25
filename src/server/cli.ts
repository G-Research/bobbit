#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setProjectRoot, bobbitConfigDir, bobbitStateDir } from "./bobbit-dir.js";
import { scaffoldBobbitDir } from "./scaffold.js";
import { loadOrCreateToken, readToken } from "./auth/token.js";
import { ensureTlsCert } from "./auth/tls.js";
import { loadDesecConfig, updateDesecIp } from "./auth/desec.js";
import { createGateway } from "./server.js";

interface CliArgs {
	host: string;
	port: number;
	portExplicit: boolean;
	cwd: string;
	newToken: boolean;
	showToken: boolean;
	noUi: boolean;
	tls: boolean;
	tlsExplicit: boolean;
	staticDir?: string;
	agentCliPath?: string;
}

/** Find the NordLynx (NordVPN mesh) interface IPv4 address, or null if not found. */
function findNordLynxIp(): string | null {
	const interfaces = os.networkInterfaces();
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		if (!name.toLowerCase().includes("nordlynx")) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				return addr.address;
			}
		}
	}
	return null;
}

function parseArgs(argv: string[]): CliArgs {
	const result: CliArgs = {
		host: "",  // resolved after parsing
		port: 3001,
		portExplicit: false,
		cwd: process.cwd(),
		newToken: false,
		showToken: false,
		noUi: false,
		tls: true,  // on by default
		tlsExplicit: false,
	};

	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--host":
				result.host = argv[++i];
				break;
			case "--port":
				result.port = parseInt(argv[++i], 10);
				result.portExplicit = true;
				break;
			case "--cwd":
				result.cwd = path.resolve(argv[++i]);
				break;
			case "--new-token":
				result.newToken = true;
				break;
			case "--show-token":
				result.showToken = true;
				break;
			case "--static":
				result.staticDir = path.resolve(argv[++i]);
				break;
			case "--agent-cli":
				result.agentCliPath = path.resolve(argv[++i]);
				break;
			case "--no-ui":
				result.noUi = true;
				break;
			case "--tls":
				result.tls = true;
				result.tlsExplicit = true;
				break;
			case "--no-tls":
				result.tls = false;
				result.tlsExplicit = true;
				break;
			case "--nord": {
				const nordIp = findNordLynxIp();
				if (nordIp) {
					result.host = nordIp;
				} else {
					console.error("No NordLynx interface found. Is NordVPN meshnet active?");
					process.exit(1);
				}
				break;
			}
		}
	}

	// Auto-detect embedded UI (dist/ui/) unless --no-ui or explicit --static
	if (!result.noUi && !result.staticDir) {
		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const embeddedUi = path.join(__dirname, "..", "ui");
		if (fs.existsSync(path.join(embeddedUi, "index.html"))) {
			result.staticDir = embeddedUi;
		}
	}

	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));

	// --show-token: print token and exit
	if (args.showToken) {
		const token = readToken();
		if (token) {
			console.log(token);
		} else {
			console.error("No token found. Run the gateway first to generate one.");
			process.exit(1);
		}
		return;
	}

	// Default to localhost unless --host or --nord was given
	if (!args.host) {
		args.host = "localhost";
	}

	// Set project root early — all stores resolve paths from this
	setProjectRoot(args.cwd);

	// Warn about legacy ~/.pi state BEFORE scaffolding (scaffold creates .bobbit/)
	const legacyPiDir = path.join(os.homedir(), ".pi");
	if (fs.existsSync(path.join(legacyPiDir, "gateway-sessions.json")) && !fs.existsSync(path.join(args.cwd, ".bobbit"))) {
		console.warn(
			`\n⚠  Found legacy state in ~/.pi/ but no .bobbit/ folder.\n` +
			`   Bobbit now stores state in <project-root>/.bobbit/state/.\n` +
			`   Your existing sessions/goals will not be visible until migrated.\n` +
			`   Copy files manually from ~/.pi/ to .bobbit/state/, or start fresh.\n`
		);
	}

	// Scaffold .bobbit/ on first run (creates config, extensions, state dirs)
	scaffoldBobbitDir(args.cwd);

	const authToken = loadOrCreateToken(args.newToken);

	// Resolve custom system prompt from .bobbit/config/
	const systemPromptFile = path.join(bobbitConfigDir(), "system-prompt.md");
	const systemPromptPath = fs.existsSync(systemPromptFile) ? systemPromptFile : undefined;
	if (systemPromptPath) {
		console.log(`  System prompt: ${systemPromptPath}`);
	}

	// Auto-disable TLS for loopback to avoid self-signed cert warnings on localhost
	const isLoopback = args.host === "127.0.0.1" || args.host === "::1" || args.host === "localhost";
	if (isLoopback && !args.tlsExplicit) {
		args.tls = false;
		console.log("  Binding to localhost — TLS disabled (use --tls to override).");
	}

	// Load deSEC config early — domain is needed for TLS cert SAN
	const desecConfig = loadDesecConfig();
	const extraDomains = desecConfig ? [desecConfig.domain] : [];

	// TLS setup — auto-generate cert (mkcert CA preferred, openssl fallback)
	const tls = args.tls ? await ensureTlsCert(args.host, extraDomains) : undefined;

	// Update deSEC dynDNS if configured (keeps domain pointing to current mesh IP)
	// Skip for loopback addresses (e.g. E2E tests with --host 127.0.0.1) to avoid
	// clobbering the DNS record with an unreachable IP.
	if (desecConfig && !isLoopback) {
		updateDesecIp(desecConfig, args.host); // fire and forget
	}

	const gateway = createGateway({
		host: args.host,
		port: args.port,
		portExplicit: args.portExplicit,
		authToken,
		defaultCwd: args.cwd,
		staticDir: args.staticDir,
		agentCliPath: args.agentCliPath,
		systemPromptPath,
		tls,
	});

	const actualPort = await gateway.start();

	// Collect reachable addresses for display
	const interfaces = os.networkInterfaces();
	const addresses: string[] = [];
	for (const [name, addrs] of Object.entries(interfaces)) {
		if (!addrs) continue;
		for (const addr of addrs) {
			if (addr.family === "IPv4" && !addr.internal) {
				addresses.push(`${addr.address} (${name})`);
			}
		}
	}

	const proto = args.tls ? "https" : "http";
	const baseUrl = `${proto}://${args.host}:${actualPort}`;
	const fullUrl = `${baseUrl}/?token=${encodeURIComponent(authToken)}`;

	// Write gateway URL to a discoverable file so Vite proxy and extensions can find it.
	const gatewayUrlPath = path.join(bobbitStateDir(), "gateway-url");
	fs.writeFileSync(gatewayUrlPath, baseUrl, "utf-8");

	console.log(`\nPi Gateway v0.1.0`);
	console.log(`  Listening:  ${baseUrl}`);
	console.log(`  Auth token: ${authToken}`);
	console.log(`  Agent CWD:  ${args.cwd}`);
	if (args.staticDir) {
		console.log(`  UI:         ${fullUrl}`);
	}
	if (addresses.length > 0) {
		console.log(`  Accessible from: ${addresses.join(", ")}`);
	}
	console.log();
	console.log(`  \u26A0 This token grants full shell access to this machine.`);
	console.log(`  Keep it secret. Regenerate with --new-token.`);
	console.log();

	// Auto-open browser when serving the UI, passing token so the UI auto-connects
	if (args.staticDir) {
		const cmd =
			process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
		import("node:child_process").then(({ exec }) => exec(`${cmd} ${fullUrl}`));
	}

	// Graceful shutdown
	const shutdown = async () => {
		console.log("\nShutting down...");
		await gateway.shutdown();
		process.exit(0);
	};

	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// Global error handlers — prevent silent zombification from stray rejections
process.on("unhandledRejection", (reason) => {
	console.error("[gateway] Unhandled rejection:", reason);
});

process.on("uncaughtException", (err) => {
	console.error("[gateway] Uncaught exception:", err);
	process.exit(1);
});

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
