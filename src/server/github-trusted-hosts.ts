import type { Clock, CommandRunner } from "./gateway-deps.js";
import { normalizeTrustedHosts } from "../shared/pr-walkthrough/url-safety.js";

const DEFAULT_CACHE_TTL_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const DISCOVERY_MAX_BUFFER_BYTES = 64 * 1024;
const STRIPPED_GH_ENV_KEYS = new Set([
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_HOST",
	"GH_REPO",
]);

export interface GithubTrustedHostResolverOptions {
	commandRunner: CommandRunner;
	clock: Pick<Clock, "now">;
	getManagedHosts: () => unknown;
	cacheTtlMs?: number;
	env?: Readonly<Record<string, string | undefined>>;
}

interface DiscoveryCache {
	hosts: string[];
	expiresAt: number;
}

/** Resolves Bobbit-managed and host-specific gh CLI GitHub hosts without reading tokens. */
export class GithubTrustedHostResolver {
	private readonly commandRunner: CommandRunner;
	private readonly clock: Pick<Clock, "now">;
	private readonly getManagedHosts: () => unknown;
	private readonly cacheTtlMs: number;
	private readonly discoveryEnv: NodeJS.ProcessEnv;
	private discoveryCache: DiscoveryCache | undefined;
	private discoveryInFlight: Promise<string[]> | undefined;

	constructor(options: GithubTrustedHostResolverOptions) {
		this.commandRunner = options.commandRunner;
		this.clock = options.clock;
		this.getManagedHosts = options.getManagedHosts;
		this.cacheTtlMs = Number.isFinite(options.cacheTtlMs) && (options.cacheTtlMs ?? 0) >= 0
			? options.cacheTtlMs!
			: DEFAULT_CACHE_TTL_MS;
		this.discoveryEnv = sanitizedDiscoveryEnv(options.env ?? process.env);
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
			const result = await this.commandRunner.execFile(
				"gh",
				["auth", "status", "--json", "hosts", "--jq", ".hosts | keys[]"],
				{
					encoding: "utf8",
					env: this.discoveryEnv,
					maxBuffer: DISCOVERY_MAX_BUFFER_BYTES,
					timeout: DISCOVERY_TIMEOUT_MS,
					windowsHide: true,
				},
			);
			const hostKeys = result.stdout.toString().split(/\r?\n/)
				.filter(host => !host.includes("://"));
			hosts = normalizeTrustedHosts(hostKeys);
		} catch {
			// Fail closed. In particular, never expose or log command output/errors.
		}
		this.discoveryCache = {
			hosts,
			expiresAt: this.clock.now() + this.cacheTtlMs,
		};
		return hosts;
	}
}

function sanitizedDiscoveryEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
	const sanitized: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (STRIPPED_GH_ENV_KEYS.has(key.toUpperCase())) continue;
		sanitized[key] = value;
	}
	return sanitized;
}
