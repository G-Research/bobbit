/**
 * AgentMemoryManager — top-level control plane for the AgentMemory
 * integration. Owns:
 *
 * - System preferences resolver (default OFF).
 * - REST client.
 * - Managed-process supervisor (lazy, explicit start only).
 * - Status cache with a short TTL.
 *
 * The manager is intentionally small. Tool gating, prompt injection,
 * and auto-capture wiring live in their respective modules and read
 * via this manager.
 */

import path from "node:path";
import { AgentMemoryClient, type ApiResult, type SmartSearchArgs } from "./agentmemory-client.js";
import { AgentMemoryProcessManager, type ProcStatus, type ProcessSpawnOpts } from "./agentmemory-process-manager.js";
import {
	type AgentMemorySystemPrefs,
	type AgentMemoryResolvedProjectPrefs,
	type PrefReader,
	type ProjectConfigReader,
	PREF_KEYS,
	SECRET_KEY,
	DEFAULT_VIEWER_URL,
	readSystemPrefs,
	resolveProjectPrefs,
	isAgentMemoryMode,
	clampTokenBudget,
} from "./agentmemory-preferences.js";
import type { SecretWriter } from "./agentmemory-secret-store.js";
import { redactPayload, redactString } from "./agentmemory-redaction.js";
import { normalizeResults, type NormalizedMemoryItem } from "./agentmemory-format.js";

export interface PrefWriter extends PrefReader {
	set(key: string, value: unknown): void;
	remove(key: string): void;
}

export interface AgentMemoryStatus {
	enabled: boolean;
	mode: AgentMemorySystemPrefs["mode"];
	url: string;
	viewerUrl: string;
	health: "unknown" | "healthy" | "unreachable" | "degraded" | "disabled";
	lastCheckedAt: number | null;
	managed: {
		supported: true;
		process: ProcStatus;
	};
	warnings: string[];
	defaults: {
		autoCapture: boolean;
		defaultInject: boolean;
		globalRecall: boolean;
		tokenBudget: number;
		managedPackage: string;
		managedDataDir: string | null;
	};
	hasSecret: boolean;
}

export interface AgentMemoryManagerOptions {
	stateDir: string;
	preferences: PrefWriter;
	secrets: SecretWriter;
	/** Override for tests. */
	clientFactory?: (opts: { getBaseUrl: () => string; getBearer: () => string | undefined }) => AgentMemoryClient;
	/** Override for tests. */
	processManager?: AgentMemoryProcessManager;
	/** Notification callback when status changes (used by server to broadcast). */
	onStatusChanged?: (s: AgentMemoryStatus) => void;
}

const HEALTH_CACHE_TTL_MS = 15_000;

export class AgentMemoryManager {
	private readonly stateDir: string;
	private readonly preferences: PrefWriter;
	private readonly secrets: SecretWriter;
	private readonly client: AgentMemoryClient;
	private readonly process: AgentMemoryProcessManager;
	private readonly onStatusChanged: ((s: AgentMemoryStatus) => void) | undefined;
	private healthState: AgentMemoryStatus["health"] = "unknown";
	private lastCheckedAt: number | null = null;
	private lastWarnings: string[] = [];

	constructor(opts: AgentMemoryManagerOptions) {
		this.stateDir = opts.stateDir;
		this.preferences = opts.preferences;
		this.secrets = opts.secrets;
		this.onStatusChanged = opts.onStatusChanged;
		const makeClient = opts.clientFactory ?? ((o) => new AgentMemoryClient(o));
		this.client = makeClient({
			getBaseUrl: () => this.readSystem().url,
			getBearer: () => this.secrets.get(SECRET_KEY),
		});
		this.process = opts.processManager ?? new AgentMemoryProcessManager({
			onStateChange: () => { this.emitStatus(); },
		});
	}

	/** Read system-level preferences with defaults. */
	readSystem(): AgentMemorySystemPrefs {
		return readSystemPrefs(this.preferences);
	}

	/** Resolve per-project preferences. */
	resolveProject(project: ProjectConfigReader | null | undefined): AgentMemoryResolvedProjectPrefs {
		return resolveProjectPrefs(this.readSystem(), project);
	}

	isEnabled(): boolean {
		return this.readSystem().enabled;
	}

	hasSecret(): boolean {
		const v = this.secrets.get(SECRET_KEY);
		return typeof v === "string" && v.length > 0;
	}

	/** Current cached status snapshot. Does NOT include secret values. */
	getStatus(): AgentMemoryStatus {
		const sys = this.readSystem();
		const procStatus = this.process.getStatus();
		const warnings = [...this.lastWarnings];
		if (sys.enabled && sys.mode === null) {
			warnings.push("Choose a connection mode (External, Managed, or MCP-only).");
		}
		return {
			enabled: sys.enabled,
			mode: sys.mode,
			url: sys.url,
			viewerUrl: DEFAULT_VIEWER_URL,
			health: sys.enabled ? this.healthState : "disabled",
			lastCheckedAt: this.lastCheckedAt,
			managed: { supported: true, process: procStatus },
			warnings,
			defaults: {
				autoCapture: sys.autoCapture,
				defaultInject: sys.defaultInject,
				globalRecall: sys.globalRecall,
				tokenBudget: sys.tokenBudget,
				managedPackage: sys.managedPackage,
				managedDataDir: sys.managedDataDir,
			},
			hasSecret: this.hasSecret(),
		};
	}

	/** Run a health check, updating cached status. */
	async checkHealth(force = false): Promise<AgentMemoryStatus> {
		const sys = this.readSystem();
		if (!sys.enabled) {
			this.healthState = "disabled";
			this.lastCheckedAt = Date.now();
			this.emitStatus();
			return this.getStatus();
		}
		const now = Date.now();
		if (!force && this.lastCheckedAt && now - this.lastCheckedAt < HEALTH_CACHE_TTL_MS) {
			return this.getStatus();
		}
		const res = await this.client.health();
		this.lastCheckedAt = Date.now();
		if (res.ok) {
			this.healthState = "healthy";
			this.lastWarnings = [];
		} else {
			this.healthState = res.code === "TIMEOUT" || res.code === "NETWORK" ? "unreachable" : "degraded";
			this.lastWarnings = [res.error];
		}
		this.emitStatus();
		return this.getStatus();
	}

	/** Run a search through the configured client. Resolves project precedence client-side too. */
	async search(args: SmartSearchArgs, opts?: { allowDisabled?: boolean }): Promise<ApiResult<{ items: NormalizedMemoryItem[]; raw: Record<string, unknown> }>> {
		const sys = this.readSystem();
		if (!sys.enabled && !opts?.allowDisabled) {
			return { ok: false, status: 0, error: "AgentMemory is disabled", code: "DISABLED" };
		}
		const res = await this.client.smartSearch(args);
		if (!res.ok) return res;
		const items = normalizeResults(res.data as { project?: unknown[]; global?: unknown[]; results?: unknown[] });
		return { ok: true, status: res.status, data: { items, raw: res.data } };
	}

	/** Save a memory. Caller-provided content is redacted before send. */
	async remember(args: { content: string; type?: string; scope?: "project" | "global"; projectKey?: string; concepts?: string[]; files?: string[] }): Promise<ApiResult<Record<string, unknown>>> {
		const sys = this.readSystem();
		if (!sys.enabled) return { ok: false, status: 0, error: "AgentMemory is disabled", code: "DISABLED" };
		const payload = redactPayload({
			...args,
			content: redactString(args.content ?? ""),
		});
		return this.client.remember(payload as typeof args);
	}

	/** Fire-and-forget capture. Failures are swallowed. */
	async observe(args: { sessionId: string; hookType: string; projectKey?: string; cwd?: string; data: Record<string, unknown> }): Promise<void> {
		const sys = this.readSystem();
		if (!sys.enabled) return;
		try {
			const payload = redactPayload(args);
			await this.client.observe(payload as typeof args);
		} catch { /* fire and forget */ }
	}

	/** Test the configured connection — optionally with a sample query. */
	async test(opts?: { query?: string }): Promise<{
		health: ApiResult<unknown>;
		search?: ApiResult<unknown>;
	}> {
		const health = await this.client.health();
		this.lastCheckedAt = Date.now();
		this.healthState = health.ok ? "healthy" : health.code === "TIMEOUT" || health.code === "NETWORK" ? "unreachable" : "degraded";
		this.emitStatus();
		if (!opts?.query) return { health };
		const search = await this.client.smartSearch({ query: opts.query, limit: 3 });
		return { health, search };
	}

	/** Mutate system preferences from a REST PUT. Returns warnings (no throws on bad input — fields are validated, secrets stay out). */
	updateSettings(input: Record<string, unknown>): { warnings: string[]; errors: string[] } {
		const warnings: string[] = [];
		const errors: string[] = [];

		const setBool = (key: keyof typeof PREF_KEYS, prefKey: string) => {
			if (!(key in input)) return;
			const v = input[key];
			if (v === null || v === undefined) { this.preferences.remove(prefKey); return; }
			if (typeof v !== "boolean") { errors.push(`${key} must be boolean`); return; }
			this.preferences.set(prefKey, v);
		};

		setBool("enabled", PREF_KEYS.enabled);
		setBool("autoCapture", PREF_KEYS.autoCapture);
		setBool("globalRecall", PREF_KEYS.globalRecall);
		setBool("defaultInject", PREF_KEYS.defaultInject);

		if ("mode" in input) {
			const v = input.mode;
			if (v === null) this.preferences.remove(PREF_KEYS.mode);
			else if (isAgentMemoryMode(v)) this.preferences.set(PREF_KEYS.mode, v);
			else errors.push("mode must be 'external', 'managed', 'mcp-only', or null");
		}

		if ("url" in input) {
			const v = input.url;
			if (v === null || v === "") this.preferences.remove(PREF_KEYS.url);
			else if (typeof v !== "string") errors.push("url must be a string");
			else {
				try {
					const u = new URL(v);
					if (u.protocol !== "http:" && u.protocol !== "https:") {
						errors.push("url must use http or https");
					} else {
						this.preferences.set(PREF_KEYS.url, v.trim());
					}
				} catch {
					errors.push("url is not a valid URL");
				}
			}
		}

		if ("tokenBudget" in input) {
			const v = input.tokenBudget;
			if (v === null || v === undefined) this.preferences.remove(PREF_KEYS.tokenBudget);
			else {
				const clamped = clampTokenBudget(v);
				this.preferences.set(PREF_KEYS.tokenBudget, clamped);
				const n = Number(v);
				if (Number.isFinite(n) && n !== clamped) warnings.push(`tokenBudget clamped to ${clamped}`);
			}
		}

		if ("managedPackage" in input) {
			const v = input.managedPackage;
			if (v === null || v === "") this.preferences.remove(PREF_KEYS.managedPackage);
			else if (typeof v !== "string") errors.push("managedPackage must be a string");
			else {
				// Reject anything that looks like a shell expression or path traversal.
				if (/[\s;&|`<>$]/.test(v)) errors.push("managedPackage must not contain shell metacharacters");
				else this.preferences.set(PREF_KEYS.managedPackage, v.trim());
			}
		}

		if ("managedDataDir" in input) {
			const v = input.managedDataDir;
			if (v === null || v === "") this.preferences.remove(PREF_KEYS.managedDataDir);
			else if (typeof v !== "string") errors.push("managedDataDir must be a string");
			else this.preferences.set(PREF_KEYS.managedDataDir, v.trim());
		}

		// Forbid sneaking the secret in through settings.
		if ("secret" in input || "bearer" in input || "bearerToken" in input) {
			errors.push("Secrets must be sent via /api/agentmemory/secret — not via settings");
		}

		this.emitStatus();
		return { warnings, errors };
	}

	/** Update the bearer secret. Empty string removes it. */
	setSecret(value: string | null): void {
		if (value === null || value === "") {
			this.secrets.remove(SECRET_KEY);
		} else {
			this.secrets.set(SECRET_KEY, value);
		}
		this.emitStatus();
	}

	/** Start the managed AgentMemory process. Requires mode='managed'. */
	startManaged(extra?: { commandOverride?: string; argsOverride?: string[] }): ProcStatus {
		const sys = this.readSystem();
		if (!sys.enabled) throw Object.assign(new Error("AgentMemory is disabled"), { code: "DISABLED" });
		if (sys.mode !== "managed") throw Object.assign(new Error("Managed mode is not selected"), { code: "WRONG_MODE" });
		if (this.process.isRunning()) return this.process.getStatus();

		// Resolve port from configured URL when possible.
		let port = "3111";
		try {
			const u = new URL(sys.url);
			if (u.port) port = u.port;
		} catch { /* keep default */ }

		const opts: ProcessSpawnOpts = {
			command: extra?.commandOverride ?? "npx",
			args: extra?.argsOverride ?? ["-y", sys.managedPackage, "--port", port],
			cwd: this.stateDir,
			env: sys.managedDataDir ? { AGENTMEMORY_DATA_DIR: sys.managedDataDir } : undefined,
			logFile: path.join(this.stateDir, "agentmemory", "managed.log"),
		};
		// Hard-deny obviously dangerous overrides — managed mode must not silently
		// run Docker or shell scripts.
		if (/^docker(\s|$)/i.test(opts.command ?? "") || (opts.args[0] && /^docker/i.test(opts.args[0]))) {
			throw Object.assign(new Error("Refusing to launch Docker from managed mode — start AgentMemory yourself or use external mode."), { code: "DOCKER_BLOCKED" });
		}
		return this.process.start(opts);
	}

	/** Stop the managed AgentMemory process. */
	async stopManaged(): Promise<ProcStatus> {
		return this.process.stop();
	}

	/** Tail the managed-mode log. */
	tailManagedLog(maxBytes?: number): string {
		return this.process.tailLog(maxBytes);
	}

	private emitStatus(): void {
		try { this.onStatusChanged?.(this.getStatus()); } catch { /* ignore */ }
	}
}
