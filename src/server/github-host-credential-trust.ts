import type { ChildProcess, SpawnOptions } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { realClock, type Clock, type TimerHandle } from "./gateway-deps.js";
import { normalizeGithubHost } from "./remote-state-coordinator.js";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_GRACE_MS = 500;
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024;
const GITHUB_COM_CLASS_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const ENTERPRISE_SERVER_CLASS_TOKENS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

export type CredentialProbe = (host: string) => Promise<boolean>;
export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
export type SpawnResolver = () => SpawnLike | undefined;
export type EnvironmentResolver = () => Readonly<Record<string, string | undefined>>;

type VerdictEntry =
	| { kind: "positive"; generation: number }
	| { kind: "negative"; generation: number }
	| { kind: "pending"; generation: number; promise: Promise<boolean> };

export interface GithubHostCredentialTrustOptions {
	probe?: CredentialProbe;
	resolveSpawn?: SpawnResolver;
	clock?: Clock;
	getEnv?: EnvironmentResolver;
	warn?: (message: string) => void;
}

/**
 * Process-local, PR-only trust derived from the operator's Git credential
 * configuration. Only boolean verdicts and ambient variable names cross the
 * credential boundary; credential values are never returned, persisted, or
 * logged.
 */
export class GithubHostCredentialTrust {
	private readonly states = new Map<string, VerdictEntry>();
	private readonly probe: CredentialProbe;
	private readonly getEnv: EnvironmentResolver;
	private readonly warn: (message: string) => void;
	private readonly reportedAmbientRefusals = new Set<string>();
	private generation = 0;

	constructor(options: GithubHostCredentialTrustOptions = {}) {
		const resolveSpawn = options.resolveSpawn ?? (() => undefined);
		const clock = options.clock ?? realClock;
		this.probe = options.probe ?? (host => probeLocalGitCredential(host, resolveSpawn(), clock));
		this.getEnv = options.getEnv ?? (() => process.env);
		this.warn = options.warn ?? (message => console.warn(message));
	}

	async isTrusted(host: string): Promise<boolean> {
		const key = normalizeCredentialAuthority(host);
		if (!key) return false;

		// Resolve live, before consulting even a positive cache entry: gh inherits
		// the live environment and would prefer a host-class-wide token.
		let ambientVariable: string | undefined;
		try {
			ambientVariable = ambientTokenFor(key, this.getEnv());
		} catch {
			return false;
		}
		if (ambientVariable) {
			this.reportAmbientRefusal(key, ambientVariable);
			return false;
		}

		const existing = this.states.get(key);
		if (existing?.kind === "positive") return true;
		if (existing?.kind === "negative") return false;
		if (existing?.kind === "pending") return existing.promise;

		const generation = this.generation;
		let pending!: VerdictEntry & { kind: "pending" };
		const promise = this.resolveVerdict(key, generation, () => pending);
		pending = { kind: "pending", generation, promise };
		this.states.set(key, pending);
		return promise;
	}

	/** Keep positive trust for the process lifetime; invalidate negative and stale pending work. */
	forgetUnverified(): void {
		this.generation++;
		for (const [host, state] of this.states) {
			if (state.kind !== "positive") this.states.delete(host);
		}
	}

	private async resolveVerdict(
		host: string,
		generation: number,
		entry: () => VerdictEntry,
	): Promise<boolean> {
		let trusted = false;
		try {
			trusted = (await this.probe(host)) === true;
		} catch {
			trusted = false;
		}
		const current = this.states.get(host);
		if (generation === this.generation && current === entry()) {
			this.states.set(host, { kind: trusted ? "positive" : "negative", generation });
		}
		return trusted;
	}

	private reportAmbientRefusal(host: string, variable: string): void {
		if (this.reportedAmbientRefusals.has(host)) return;
		this.reportedAmbientRefusals.add(host);
		try {
			this.warn(
				`[github-trust] Not trusting ${host} from the local Git credential configuration because ${variable} is set. `
				+ `Trust ${host} explicitly with githubTrustedHosts or unset ${variable}.`,
			);
		} catch {
			// Warning delivery must not turn a fail-closed refusal into an exception.
		}
	}
}

function normalizeCredentialAuthority(host: string): string | undefined {
	const normalized = normalizeGithubHost(host);
	// Credential probing is intentionally narrower than structural parsing. The
	// parser supplies DNS authorities; direct callers cannot inject credential
	// protocol lines or URL components.
	if (!/^[a-z0-9._-]+(?::\d+)?$/.test(normalized)) return undefined;
	const port = /:(\d+)$/.exec(normalized)?.[1];
	if (port && (Number(port) < 1 || Number(port) > 65_535)) return undefined;
	return normalized;
}

function ambientTokenFor(host: string, env: Readonly<Record<string, string | undefined>>): string | undefined {
	const hostname = host.replace(/:\d+$/, "");
	const names = hostname === "github.com" || hostname.endsWith(".ghe.com")
		? GITHUB_COM_CLASS_TOKENS
		: ENTERPRISE_SERVER_CLASS_TOKENS;
	return names.find(name => (env[name] ?? "").trim() !== "");
}

function probeEnvironment(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		// Empty overrides are intentional: deleting these variables would let Git
		// fall back to core.askPass or SSH_ASKPASS and execute a configured prompt.
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		// The dedicated child is empty; the ceiling also prevents an operator-
		// overridden temp root from inheriting repository-local credential config.
		GIT_CEILING_DIRECTORIES: root,
	};
	delete env.DISPLAY;
	return env;
}

function unref(handle: TimerHandle): void {
	(handle as { unref?: () => void }).unref?.();
}

class CredentialRecordParser {
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private pending = "";
	private bytes = 0;
	private ended = false;
	private invalid = false;
	private host: string | undefined;
	private hasPassword = false;
	private readonly keys = new Set<string>();

	constructor(private readonly expectedHost: string) {}

	push(chunk: Buffer | string): boolean {
		if (this.invalid) return false;
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		this.bytes += bytes.length;
		if (this.bytes > PROBE_MAX_OUTPUT_BYTES) return this.reject();
		try {
			this.pending += this.decoder.decode(bytes, { stream: true });
		} catch {
			return this.reject();
		}
		return this.consumeCompleteLines();
	}

	finish(): boolean {
		if (this.invalid) return false;
		try {
			this.pending += this.decoder.decode();
		} catch {
			return this.reject();
		}
		if (!this.consumeCompleteLines()) return false;
		if (this.pending) {
			const line = this.pending;
			this.pending = "";
			if (!this.consumeLine(line)) return false;
		}
		return !this.invalid && this.host === this.expectedHost && this.hasPassword;
	}

	private consumeCompleteLines(): boolean {
		for (;;) {
			const newline = this.pending.indexOf("\n");
			if (newline < 0) return !this.invalid;
			const line = this.pending.slice(0, newline);
			this.pending = this.pending.slice(newline + 1);
			if (!this.consumeLine(line)) return false;
		}
	}

	private consumeLine(rawLine: string): boolean {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (this.ended) return this.reject();
		if (line === "") {
			this.ended = true;
			return true;
		}
		if (/[\u0000-\u001f\u007f]/.test(line)) return this.reject();
		const separator = line.indexOf("=");
		if (separator <= 0) return this.reject();
		const key = line.slice(0, separator);
		if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) || this.keys.has(key)) return this.reject();
		this.keys.add(key);
		const value = line.slice(separator + 1);
		if (key === "host") {
			if (value !== this.expectedHost) return this.reject();
			this.host = value;
		} else if (key === "password") {
			if (value.length === 0) return this.reject();
			this.hasPassword = true;
		}
		// All other values, including usernames and future credential fields, are
		// deliberately discarded rather than retained on the trust object.
		return true;
	}

	private reject(): false {
		this.invalid = true;
		this.pending = "";
		return false;
	}
}

function probeLocalGitCredential(host: string, spawn: SpawnLike | undefined, clock: Clock): Promise<boolean> {
	if (!spawn) return Promise.resolve(false);

	let cwd: string;
	try {
		cwd = mkdtempSync(join(tmpdir(), "bobbit-git-credential-"));
	} catch {
		return Promise.resolve(false);
	}

	return new Promise<boolean>((resolve) => {
		let child: ChildProcess;
		try {
			child = spawn("git", ["credential", "fill"], {
				cwd,
				env: probeEnvironment(tmpdir()),
				windowsHide: true,
				stdio: ["pipe", "pipe", "ignore"],
			});
		} catch {
			cleanupProbeDirectory(cwd);
			resolve(false);
			return;
		}

		const parser = new CredentialRecordParser(host);
		let settled = false;
		let closed = false;
		let killTimer: TimerHandle | undefined;
		const cleanup = () => cleanupProbeDirectory(cwd);
		const settle = (result: boolean, keepKillTimer = false) => {
			if (settled) return;
			settled = true;
			clock.clearTimeout(timeoutTimer);
			if (killTimer && !keepKillTimer) clock.clearTimeout(killTimer);
			cleanup();
			resolve(result);
		};
		const abort = () => {
			if (settled) return;
			try { child.kill("SIGTERM"); } catch { /* fail closed below */ }
			killTimer = clock.setTimeout(() => {
				if (!closed) {
					try { child.kill("SIGKILL"); } catch { /* already gone */ }
				}
				cleanup();
			}, PROBE_KILL_GRACE_MS);
			unref(killTimer);
			settle(false, true);
		};
		const timeoutTimer = clock.setTimeout(abort, PROBE_TIMEOUT_MS);
		unref(timeoutTimer);

		if (!child.stdout || !child.stdin) {
			abort();
			return;
		}
		child.stdout.on("data", (chunk: Buffer | string) => {
			if (!settled && !parser.push(chunk)) abort();
		});
		child.stdout.on("error", abort);
		child.on("error", abort);
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			closed = true;
			if (killTimer) clock.clearTimeout(killTimer);
			if (settled) {
				cleanup();
				return;
			}
			settle(code === 0 && signal == null && parser.finish());
		});
		child.stdin.on("error", abort);
		try {
			child.stdin.end(`url=https://${host}\n\n`);
		} catch {
			abort();
		}
	});
}

function cleanupProbeDirectory(cwd: string): void {
	try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best-effort retry occurs after kill */ }
}
