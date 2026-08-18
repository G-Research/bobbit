import fs from "node:fs";
import path from "node:path";
import type { Clock, CommandRunner } from "./gateway-deps.js";
import { normalizeTrustedHost, normalizeTrustedHosts } from "../shared/pr-walkthrough/url-safety.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DISCOVERY_MAX_BYTES = 64 * 1024;
const DISCOVERY_READ_CHUNK_BYTES = 4 * 1024;

export interface GithubTrustedHostResolverOptions {
	/** Retained for constructor compatibility. Host discovery never executes gh. */
	commandRunner: CommandRunner;
	clock: Pick<Clock, "now">;
	getManagedHosts: () => unknown;
	cacheTtlMs?: number;
	env?: Readonly<Record<string, string | undefined>>;
	fileSystem?: Pick<typeof fs.promises, "open">;
	platform?: NodeJS.Platform;
}

interface DiscoveryCache {
	hosts: string[];
	expiresAt: number;
}

/** Resolves Bobbit-managed and host-specific gh CLI GitHub hosts without reading tokens. */
export class GithubTrustedHostResolver {
	private readonly clock: Pick<Clock, "now">;
	private readonly getManagedHosts: () => unknown;
	private readonly cacheTtlMs: number;
	private readonly env: Readonly<Record<string, string | undefined>>;
	private readonly fileSystem: Pick<typeof fs.promises, "open">;
	private readonly platform: NodeJS.Platform;
	private discoveryCache: DiscoveryCache | undefined;
	private discoveryInFlight: Promise<string[]> | undefined;

	constructor(options: GithubTrustedHostResolverOptions) {
		this.clock = options.clock;
		this.getManagedHosts = options.getManagedHosts;
		this.cacheTtlMs = Number.isFinite(options.cacheTtlMs) && (options.cacheTtlMs ?? 0) >= 0
			? options.cacheTtlMs!
			: DEFAULT_CACHE_TTL_MS;
		this.env = options.env ?? process.env;
		this.fileSystem = options.fileSystem ?? fs.promises;
		this.platform = options.platform ?? process.platform;
	}

	async resolve(): Promise<string[]> {
		const discoveredHosts = await this.resolveDiscoveredHosts();
		return normalizeTrustedHosts([
			...normalizeTrustedHosts(this.getManagedHosts()),
			...discoveredHosts,
		]);
	}

	private async resolveDiscoveredHosts(): Promise<string[]> {
		const cached = this.discoveryCache;
		if (cached && this.clock.now() < cached.expiresAt) return cached.hosts;
		if (this.discoveryInFlight) return this.discoveryInFlight;

		const refresh = this.discoverHosts();
		this.discoveryInFlight = refresh;
		try {
			return await refresh;
		} finally {
			if (this.discoveryInFlight === refresh) this.discoveryInFlight = undefined;
		}
	}

	private async discoverHosts(): Promise<string[]> {
		let hosts: string[] = [];
		try {
			const configPath = resolveGhHostsConfigPath(this.env, this.platform);
			if (configPath) hosts = await readGhHostKeys(configPath, this.fileSystem);
		} catch {
			// Fail closed. Never expose or log the path, config contents, or read errors.
		}
		this.discoveryCache = {
			hosts,
			expiresAt: this.clock.now() + this.cacheTtlMs,
		};
		return hosts;
	}
}

function resolveGhHostsConfigPath(
	env: Readonly<Record<string, string | undefined>>,
	platform: NodeJS.Platform,
): string | undefined {
	const configured = envValue(env, "GH_CONFIG_DIR", platform);
	if (configured) return path.join(configured, "hosts.yml");

	const xdgConfigHome = envValue(env, "XDG_CONFIG_HOME", platform);
	if (xdgConfigHome) return path.join(xdgConfigHome, "gh", "hosts.yml");

	if (platform === "win32") {
		const appData = envValue(env, "APPDATA", platform);
		if (appData) return path.join(appData, "GitHub CLI", "hosts.yml");
	}

	const home = envValue(env, "HOME", platform);
	return home ? path.join(home, ".config", "gh", "hosts.yml") : undefined;
}

function envValue(
	env: Readonly<Record<string, string | undefined>>,
	name: string,
	platform: NodeJS.Platform,
): string | undefined {
	const exact = env[name];
	if (exact || platform !== "win32") return exact || undefined;
	for (const [key, value] of Object.entries(env)) {
		if (key.toUpperCase() === name && value) return value;
	}
	return undefined;
}

async function readGhHostKeys(
	configPath: string,
	fileSystem: Pick<typeof fs.promises, "open">,
): Promise<string[]> {
	const handle = await fileSystem.open(configPath, "r");
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > DISCOVERY_MAX_BYTES) return [];

		const chunk = Buffer.allocUnsafe(DISCOVERY_READ_CHUNK_BYTES);
		const hostKeys: string[] = [];
		let topLevelLine: number[] | undefined = [];
		let skipLineRemainder = false;
		let bytesReadTotal = 0;
		let position = 0;

		const finishLine = (): boolean => {
			if (topLevelLine && !scanGhConfigLine(Uint8Array.from(topLevelLine), hostKeys)) return false;
			topLevelLine = [];
			skipLineRemainder = false;
			return true;
		};

		while (true) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			bytesReadTotal += bytesRead;
			if (bytesReadTotal > DISCOVERY_MAX_BYTES) return [];

			for (const byte of chunk.subarray(0, bytesRead)) {
				if (byte === 0x0a) {
					if (!finishLine()) return [];
					continue;
				}
				if (skipLineRemainder || !topLevelLine) continue;
				if (topLevelLine.length === 0 && (byte === 0x20 || byte === 0x09 || byte === 0x23)) {
					// Indented values and comments can contain credentials. Do not decode or retain them.
					topLevelLine = undefined;
					continue;
				}
				if (byte === 0x23) skipLineRemainder = true;
				topLevelLine.push(byte);
				// A gh hostname mapping prefix is always short. Reject rather than retain
				// an unexpected top-level scalar or other unbounded YAML construct.
				if (topLevelLine.length > 512) return [];
			}
		}

		if ((topLevelLine?.length ?? 0) > 0 && !finishLine()) return [];
		return normalizeTrustedHosts(hostKeys);
	} finally {
		await handle.close();
	}
}

function scanGhConfigLine(lineBytes: Uint8Array, hostKeys: string[]): boolean {
	let candidateLine: string;
	try {
		candidateLine = new TextDecoder("utf-8", { fatal: true }).decode(lineBytes).replace(/\r$/, "");
	} catch {
		return false;
	}
	if (candidateLine.startsWith("\uFEFF")) candidateLine = candidateLine.slice(1);
	if (!candidateLine || candidateLine === "#" || /^(?:---|\.\.\.)$/.test(candidateLine)) return true;

	// gh writes each configured host as a bare top-level mapping key. Indented
	// values and comment bodies never reach this decoder.
	const match = /^([A-Za-z0-9][A-Za-z0-9.-]*):[ \t]*(?:#)?$/.exec(candidateLine);
	if (!match) return false;
	const normalized = normalizeTrustedHost(match[1]);
	if (!normalized) return false;
	hostKeys.push(normalized);
	return true;
}
