#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
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
			case "--public-origin":
			case "--vite-origin":
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
	/** Explicit externally reachable gateway origins. */
	publicOrigins: string[];
	/** Explicit development UI origins allowed to proxy to this gateway. */
	viteOrigins: string[];
}

export interface RequestAdmissionCliConfig {
	publicOrigins: string[];
	viteOrigins: string[];
	tlsHostnames: string[];
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

function buildStartupPeerUrl(input: {
	protocol: "http" | "https";
	host: string;
	port: number;
	basePath?: string;
}): string {
	return `${input.protocol}://${urlHost(loopbackForBind(input.host))}:${input.port}${normalizeBasePath(input.basePath)}`;
}

export function buildStartupUrls(input: {
	protocol: "http" | "https";
	host: string;
	port: number;
	basePath?: string;
	token: string;
	forceAuth?: boolean;
	/** Final coarse trust result exposed by the successfully started gateway. */
	trustedLocal: boolean;
}): StartupUrls {
	const basePath = normalizeBasePath(input.basePath);
	const authEnforced = Boolean(input.forceAuth) || !input.trustedLocal;
	const listenUrl = `${input.protocol}://${urlHost(input.host)}:${input.port}${basePath}`;
	const peerUrl = buildStartupPeerUrl(input);
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

function normalizeConfiguredHostname(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Invalid ${label} hostname: ${JSON.stringify(value)}`);
	const raw = value.trim();
	if (!raw || /[\s,/?#\\@]/u.test(raw)) throw new Error(`Invalid ${label} hostname: ${JSON.stringify(value)}`);
	const bracketed = raw.startsWith("[") && raw.endsWith("]");
	if (raw.startsWith("[") !== raw.endsWith("]")) throw new Error(`Invalid ${label} hostname: ${JSON.stringify(value)}`);
	const candidate = bracketed ? raw.slice(1, -1) : raw;
	if (net.isIP(candidate)) {
		const parsed = new URL(`http://${net.isIP(candidate) === 6 ? `[${candidate}]` : candidate}`);
		return parsed.hostname.replace(/^\[|\]$/gu, "");
	}
	const hostname = candidate.toLowerCase().replace(/\.$/u, "");
	if (!hostname || hostname.length > 253 || /^\d+(?:\.\d+)*$/u.test(hostname)) {
		throw new Error(`Invalid ${label} hostname: ${JSON.stringify(value)}`);
	}
	const labels = hostname.split(".");
	if (labels.some((part) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(part))) {
		throw new Error(`Invalid ${label} hostname: ${JSON.stringify(value)}`);
	}
	return hostname;
}

/** Validate and canonicalize one configured HTTP(S) origin. */
export function normalizeConfiguredOrigin(value: string, label = "origin"): string {
	const raw = value.trim();
	if (
		!raw
		|| /\s/u.test(raw)
		|| !/^https?:\/\/[^/]+\/?$/iu.test(raw)
		|| raw.includes("?")
		|| raw.includes("#")
	) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	if (
		(parsed.protocol !== "http:" && parsed.protocol !== "https:")
		|| parsed.username
		|| parsed.password
		|| parsed.pathname !== "/"
		|| parsed.search
		|| parsed.hash
	) {
		throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
	}
	const hostname = normalizeConfiguredHostname(parsed.hostname, label);
	const authorityHost = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	return `${parsed.protocol}//${authorityHost}${parsed.port ? `:${parsed.port}` : ""}`;
}

function configuredOriginList(value: string | undefined, label: string): string[] {
	if (value === undefined || value.trim() === "") return [];
	const entries = value.split(",");
	if (entries.some((entry) => entry.trim() === "")) throw new Error(`Invalid ${label} list: empty entry`);
	return entries.map((entry) => normalizeConfiguredOrigin(entry, label));
}

function appendConfiguredOrigin(target: string[], value: string | undefined, label: string): void {
	if (value === undefined || value.startsWith("--")) throw new Error(`${label} requires a value`);
	target.push(normalizeConfiguredOrigin(value, label));
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

const STANDARD_VITE_PORT = 5173;
const STANDARD_VITE_LIFECYCLES = new Set(["dev", "dev:harness", "dev:watchdog"]);

/** Derive the one finite browser origin used by the standard Vite development launcher. */
function standardViteOrigin(env: NodeJS.ProcessEnv): string[] {
	// npm's lifecycle marker survives the standard scripts' launcher chain;
	// BOBBIT_NORD separately identifies the dedicated Nord launcher.
	const standardLauncher = STANDARD_VITE_LIFECYCLES.has(env.npm_lifecycle_event ?? "");
	if (!standardLauncher || env.BOBBIT_NORD === "1") return [];
	const rawHost = env.VITE_HOST || "localhost";
	if (rawHost !== rawHost.trim()) throw new Error(`Invalid Vite hostname: ${JSON.stringify(rawHost)}`);
	const hostname = normalizeConfiguredHostname(rawHost, "Vite");
	if (hostname === "0.0.0.0" || hostname === "::") {
		throw new Error(`Invalid Vite hostname: wildcard listener ${JSON.stringify(rawHost)}`);
	}
	const authorityHost = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
	// Standard launchers serve Vite over deterministic HTTP regardless of host.
	// Nord is the separate, pre-provisioned HTTPS path handled by nordViteOrigins().
	return [normalizeConfiguredOrigin(`http://${authorityHost}:${STANDARD_VITE_PORT}`, "Vite origin")];
}

/** Build the finite admission inputs that correspond to CLI and TLS configuration. */
export function buildRequestAdmissionCliConfig(input: {
	publicOrigins?: readonly string[];
	viteOrigins?: readonly string[];
	bindHost: string;
	tlsHostnames?: readonly string[];
}): RequestAdmissionCliConfig {
	const tlsNames: string[] = [];
	for (const candidate of [input.bindHost, "127.0.0.1", "localhost", ...(input.tlsHostnames ?? [])]) {
		const hostname = normalizeConfiguredHostname(candidate, "TLS");
		if (hostname === "0.0.0.0" || hostname === "::") continue;
		tlsNames.push(hostname);
	}
	return {
		publicOrigins: unique((input.publicOrigins ?? []).map((origin) => normalizeConfiguredOrigin(origin, "public origin"))),
		viteOrigins: unique((input.viteOrigins ?? []).map((origin) => normalizeConfiguredOrigin(origin, "Vite origin"))),
		tlsHostnames: unique(tlsNames),
	};
}

/** Known finite origins used by the `dev:nord` workflow. */
export function nordViteOrigins(input: {
	bindHost: string;
	publicHostnames?: readonly string[];
	port?: number;
}): string[] {
	const port = input.port ?? 5173;
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Vite development port");
	return unique([input.bindHost, ...(input.publicHostnames ?? [])].map((hostname) => {
		const normalized = normalizeConfiguredHostname(hostname, "Vite");
		if (normalized === "0.0.0.0" || normalized === "::") {
			throw new Error(`Invalid Vite hostname: wildcard listener ${JSON.stringify(hostname)}`);
		}
		return normalizeConfiguredOrigin(`https://${net.isIP(normalized) === 6 ? `[${normalized}]` : normalized}:${port}`, "Vite origin");
	}));
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
		publicOrigins: [],
		viteOrigins: [],
	};
	let basePathFlagPresent = false;
	let basePathFlagValue: string | undefined;
	let publicOriginFlagPresent = false;
	let viteOriginFlagPresent = false;

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
			case "--public-origin":
				publicOriginFlagPresent = true;
				appendConfiguredOrigin(result.publicOrigins, argv[++i], "--public-origin");
				break;
			case "--vite-origin":
				viteOriginFlagPresent = true;
				appendConfiguredOrigin(result.viteOrigins, argv[++i], "--vite-origin");
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
	result.publicOrigins = unique(publicOriginFlagPresent
		? result.publicOrigins
		: configuredOriginList(env.BOBBIT_PUBLIC_ORIGINS, "public origin"));
	if (viteOriginFlagPresent) {
		result.viteOrigins = unique(result.viteOrigins);
	} else {
		const configuredViteOrigins = configuredOriginList(env.BOBBIT_VITE_ORIGINS, "Vite origin");
		result.viteOrigins = unique(configuredViteOrigins.length > 0
			? configuredViteOrigins
			: standardViteOrigin(env));
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
	const extraDomains = desecConfig ? [normalizeConfiguredHostname(desecConfig.domain, "deSEC")] : [];

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
	const viteOrigins = process.env.BOBBIT_NORD === "1"
		? unique([...args.viteOrigins, ...nordViteOrigins({
			bindHost: args.host,
			publicHostnames: extraDomains,
		})])
		: args.viteOrigins;
	const requestAdmissionConfig = buildRequestAdmissionCliConfig({
		publicOrigins: args.publicOrigins,
		viteOrigins,
		bindHost: args.host,
		tlsHostnames: extraDomains,
	});
	const ctorT0 = Date.now();
	const gateway = createGateway({
		...requestAdmissionConfig,
		host: args.host,
		port: args.port,
		portExplicit: args.portExplicit,
		authToken,
		defaultCwd: args.cwd,
		staticDir: args.staticDir,
		basePath: args.basePath,
		// Publication participates in policy compilation, so keep this callback
		// query-free and defer display/open authentication state until start resolves.
		onBound: (actualPort) => buildStartupPeerUrl({
			protocol,
			host: args.host,
			port: actualPort,
			basePath: args.basePath,
		}),
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

	// Build user-visible and auto-open URLs only after the gateway has compiled its
	// complete authority policy. The published peer URL above remains query-free.
	const effectiveStartupUrls = buildStartupUrls({
		protocol,
		host: args.host,
		port: actualPort,
		basePath: args.basePath,
		token: authToken,
		forceAuth: args.forceAuth,
		trustedLocal: gateway.trustedLocal,
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

	// Graceful shutdown. A repeated signal is an explicit escape hatch; it must
	// never start a competing teardown against the same Git and sandbox state.
	let shutdownRequested = false;
	const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
		if (shutdownRequested) {
			console.warn("\nShutdown interrupted; exiting immediately (worktrees may be left behind).");
			process.exit(signal === "SIGINT" ? 130 : 143);
		}
		shutdownRequested = true;
		console.log(`\nShutting down (${signal})... Press Ctrl+C again to exit immediately.`);
		try {
			await gateway.shutdown();
			process.exit(0);
		} catch (error) {
			console.error("[gateway] Shutdown failed:", error);
			process.exit(1);
		}
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
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
