#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setProjectRoot, bobbitStateDir, globalAgentDir, initializeAgentDirRuntime } from "./bobbit-dir.js";
import { scaffoldBobbitDir } from "./scaffold.js";
import { stageBundledBinaries } from "./binaries.js";
import { resolveSystemPromptPath } from "./agent/system-prompt.js";
import { loadOrCreateToken, readToken } from "./auth/token.js";
import { ensureTlsCert } from "./auth/tls.js";
import { loadDesecConfig, updateDesecIp } from "./auth/desec.js";
import { createGateway } from "./server.js";
import { bootLog, bootMark } from "./boot-profile.js";
import { isLoopbackHost, loopbackForBind } from "./cli-loopback.js";
import { resolveCliGatewayDeps } from "./cli-gateway-deps.js";
import { normalizeBasePath } from "../shared/base-path.js";

export { isLoopbackHost, loopbackForBind };

export function readPackageVersion(): string {
	const cliDir = path.dirname(fileURLToPath(import.meta.url));
	return (JSON.parse(fs.readFileSync(path.resolve(cliDir, "../../package.json"), "utf-8")) as { version: string }).version;
}

export function hasVersionFlag(argv: string[]): boolean {
	for (let i = 0; i < argv.length; i++) {
		switch (argv[i]) {
			case "--version":
				return true;
			case "--host":
			case "--port":
			case "--cwd":
			case "--static":
			case "--agent-cli":
			case "--base-path":
				i++;
				break;
		}
	}
	return false;
}

export interface CliArgs {
	host: string;
	port: number;
	portExplicit: boolean;
	cwd: string;
	newToken: boolean;
	showToken: boolean;
	noUi: boolean;
	tls: boolean;
	tlsExplicit: boolean;
	forceAuth: boolean;
	staticDir?: string;
	agentCliPath?: string;
	basePath: string;
}

export interface StartupUrls {
	protocol: "http" | "https";
	authEnforced: boolean;
	listenUrl: string;
	peerUrl: string;
	uiUrl: string;
	openUrl: string;
}

function urlHost(host: string): string {
	const normalized = host.trim();
	return normalized.includes(":") && !normalized.startsWith("[") ? `[${normalized}]` : normalized;
}

export function buildStartupUrls(input: {
	protocol: "http" | "https";
	host: string;
	port: number;
	basePath?: string;
	token: string;
	forceAuth?: boolean;
}): StartupUrls {
	const basePath = normalizeBasePath(input.basePath);
	const authEnforced = Boolean(input.forceAuth) || !isLoopbackHost(input.host);
	const listenUrl = `${input.protocol}://${urlHost(input.host)}:${input.port}${basePath}`;
	const peerUrl = `${input.protocol}://${urlHost(loopbackForBind(input.host))}:${input.port}${basePath}`;
	const uiUrl = authEnforced
		? `${peerUrl}/?token=${encodeURIComponent(input.token)}`
		: `${peerUrl}/`;
	return { protocol: input.protocol, authEnforced, listenUrl, peerUrl, uiUrl, openUrl: uiUrl };
}

export function formatStartupBanner(input: {
	version: string;
	urls: StartupUrls;
	token: string;
	cwd: string;
	staticDir?: string;
	addresses?: readonly string[];
}): string {
	const lines = ["", `Bobbit Gateway v${input.version}`, `  Listening:  ${input.urls.listenUrl}`];
	if (input.urls.authEnforced) lines.push(`  Auth token: ${input.token}`);
	lines.push(`  Agent CWD:  ${input.cwd}`);
	if (input.staticDir) lines.push(`  UI:         ${input.urls.uiUrl}`);
	if (input.addresses?.length) lines.push(`  Accessible from: ${input.addresses.join(", ")}`);
	lines.push("");
	if (input.urls.authEnforced) {
		lines.push("  ⚠ This token grants full shell access to this machine.");
		lines.push("  Keep it secret. Regenerate with --new-token.");
	} else {
		lines.push("  Token authentication is disabled on this loopback bind.");
		lines.push("  Any local process can access the gateway. Use --auth to require the token.");
	}
	lines.push("");
	return lines.join("\n");
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

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
	const envPort = env.PORT ? parseInt(env.PORT, 10) : NaN;
	const result: CliArgs = {
		host: "",  // resolved after parsing
		port: !isNaN(envPort) ? envPort : 3001,
		portExplicit: !isNaN(envPort),
		cwd: process.cwd(),
		newToken: false,
		showToken: false,
		noUi: false,
		tls: true,  // on by default
		tlsExplicit: false,
		forceAuth: false,
		basePath: "",
	};
	let basePathFlagPresent = false;
	let basePathFlagValue: string | undefined;

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
			case "--base-path":
				basePathFlagPresent = true;
				if (i + 1 >= argv.length || argv[i + 1]!.startsWith("--")) {
					throw new Error("--base-path requires a value (use / for a root mount)");
				}
				basePathFlagValue = argv[++i]!;
				break;
			case "--no-ui":
				result.noUi = true;
				break;
			case "--auth":
				result.forceAuth = true;
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

	const selectedBasePath = basePathFlagPresent
		? basePathFlagValue
		: Object.prototype.hasOwnProperty.call(env, "BOBBIT_BASE_PATH") ? env.BOBBIT_BASE_PATH : undefined;
	result.basePath = normalizeBasePath(selectedBasePath);

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
	const argv = process.argv.slice(2);
	if (hasVersionFlag(argv)) {
		process.stdout.write(`v${readPackageVersion()}\n`);
		return;
	}

	// Wall-clock anchor for boot instrumentation — process-start (approx) to listen.
	const bootWallT0 = Date.now();
	const args = parseArgs(argv);

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

	// Scaffold .bobbit/ on first run (creates config, extensions, state dirs)
	scaffoldBobbitDir(args.cwd);

	// Resolve the agent dir once for this process. Settings changes only affect the
	// next start; runtime callers keep using this startup-resolved directory.
	initializeAgentDirRuntime({ projectRoot: args.cwd, stateDir: bobbitStateDir(args.cwd) });

	// Stage bundled fd/rg binaries into <agentDir>/bin so pi-coding-agent
	// finds them via its existing getToolPath() lookup. Idempotent; failures
	// log a single warning but never crash startup. See src/server/binaries.ts.
	try {
		await stageBundledBinaries(globalAgentDir());
	} catch (e) {
		console.warn(`[binaries] Staging failed: ${(e as Error).message}`);
	}

	const authToken = loadOrCreateToken(args.newToken);

	// Resolve active system prompt: user override under .bobbit/config/ or shipped default.
	const systemPromptPath = resolveSystemPromptPath();
	if (systemPromptPath) {
		console.log(`  System prompt: ${systemPromptPath}`);
	}

	// Auto-disable TLS for loopback to avoid self-signed cert warnings on localhost
	const isLoopback = isLoopbackHost(args.host);
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

	bootMark(`BOOT ${new Date().toISOString()}`);
	bootLog(`[boot] prologue (binaries/token/tls) in ${Date.now() - bootWallT0}ms`);
	const protocol = args.tls ? "https" as const : "http" as const;
	let startupUrls: StartupUrls | undefined;
	const ctorT0 = Date.now();
	const gateway = createGateway({
		host: args.host,
		port: args.port,
		portExplicit: args.portExplicit,
		authToken,
		defaultCwd: args.cwd,
		staticDir: args.staticDir,
		basePath: args.basePath,
		onBound: (actualPort) => {
			startupUrls = buildStartupUrls({
				protocol,
				host: args.host,
				port: actualPort,
				basePath: args.basePath,
				token: authToken,
				forceAuth: args.forceAuth,
			});
			return startupUrls.peerUrl;
		},
		agentCliPath: args.agentCliPath,
		systemPromptPath,
		tls,
		forceAuth: args.forceAuth,
	}, resolveCliGatewayDeps());
	bootLog(`[boot] createGateway construction in ${Date.now() - ctorT0}ms`);

	const startT0 = Date.now();
	const actualPort = await gateway.start();
	bootLog(`[boot] gateway.start() (pre-listen critical path) in ${Date.now() - startT0}ms`);
	bootLog(`[boot] TOTAL process-start \u2192 listening in ${Date.now() - bootWallT0}ms`);

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

	// createGateway publishes during bind, before persisted sessions resume. Keep a
	// defensive fallback for custom implementations that do not invoke onBound.
	const effectiveStartupUrls = startupUrls ?? buildStartupUrls({
		protocol,
		host: args.host,
		port: actualPort,
		basePath: args.basePath,
		token: authToken,
		forceAuth: args.forceAuth,
	});

	const pkgVersion = readPackageVersion();
	// Set terminal tab title
	process.stdout.write(`\x1b]0;Bobbit Server\x07`);
	console.log(formatStartupBanner({
		version: pkgVersion,
		urls: effectiveStartupUrls,
		token: authToken,
		cwd: args.cwd,
		staticDir: args.staticDir,
		addresses,
	}));

	// Auto-open browser when serving the UI, passing token so the UI auto-connects.
	// Skipped when:
	//   - BOBBIT_NO_OPEN is set (explicit opt-out)
	//   - NODE_ENV === "test" (manual integration tests + any test harness; prevents
	//     browser tab spam from per-test gateway spawns)
	const suppressOpen = process.env.BOBBIT_NO_OPEN || process.env.NODE_ENV === "test";
	if (args.staticDir && !suppressOpen) {
		const cmd =
			process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
		import("node:child_process").then(({ exec }) => exec(`${cmd} ${effectiveStartupUrls.openUrl}`));
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

process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
	// EPIPE from writing to a dead child process stdin — not fatal, the session
	// will see a "process exited" error and handle it. Don't crash the gateway.
	if (err.code === "EPIPE") {
		console.warn("[gateway] EPIPE (ignored — child process stdin closed)");
		return;
	}
	// ENOTCONN on Windows when spawning a child process — the socket pair for
	// stdin/stdout/stderr fails transiently (e.g. under high fd pressure).
	// Same class of error as EPIPE — the calling code will see the spawn failure
	// and handle it. Don't crash the gateway.
	if (err.code === "ENOTCONN") {
		console.warn("[gateway] ENOTCONN (ignored — child process socket creation failed)");
		return;
	}
	console.error("[gateway] Uncaught exception:", err);
	process.exit(1);
});

// npm exposes POSIX bins through symlinks, while Node resolves the loaded module.
function canonicalPath(candidate: string): string {
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

function isCliEntrypoint(invokedPath: string | undefined): boolean {
	if (!invokedPath) return false;
	const invokedRealPath = canonicalPath(invokedPath);
	const moduleRealPath = canonicalPath(fileURLToPath(import.meta.url));
	return process.platform === "win32"
		? invokedRealPath.toLowerCase() === moduleRealPath.toLowerCase()
		: invokedRealPath === moduleRealPath;
}

if (isCliEntrypoint(process.argv[1])) {
	main().catch((err) => {
		console.error("Fatal:", err instanceof Error ? err.message : err);
		process.exit(1);
	});
}
