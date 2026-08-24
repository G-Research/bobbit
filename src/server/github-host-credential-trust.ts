import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { realClock, type Clock, type CommandRunner, type TimerHandle } from "./gateway-deps.js";
import { ownedTreeSpawnOptions, type OwnedTreeControl } from "./owned-tree-command-spawn.js";
import { normalizeGithubHost } from "./remote-state-coordinator.js";

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_KILL_GRACE_MS = 500;
const PROBE_TREE_SETTLE_MS = 1_500;
const PROBE_CLEANUP_RETRY_MS = 100;
const PROBE_MAX_OUTPUT_BYTES = 8 * 1024;
const GITHUB_COM_CLASS_TOKENS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
const ENTERPRISE_SERVER_CLASS_TOKENS = ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"] as const;

export type CredentialProbe = (host: string) => Promise<boolean>;
export type CommandRunnerResolver = () => CommandRunner | undefined;
export type EnvironmentResolver = () => Readonly<Record<string, string | undefined>>;

type VerdictEntry =
	| { kind: "positive"; generation: number }
	| { kind: "negative"; generation: number };

type ActiveFlight = { generation: number; promise: Promise<boolean> };
type QueuedFlight = { generation: number; promise: Promise<boolean> };

export interface GithubHostCredentialTrustOptions {
	probe?: CredentialProbe;
	resolveCommandRunner?: CommandRunnerResolver;
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
	private readonly verdicts = new Map<string, VerdictEntry>();
	// An active flight owns the host's credential-helper tree until the probe has
	// crossed its owned-tree completion boundary. Refresh invalidation must never
	// delete this ownership record or another tree could start concurrently.
	private readonly activeFlights = new Map<string, ActiveFlight>();
	// At most one successor waits behind the active owner. Its mutable generation
	// is advanced by later callers so skipped refresh generations never start trees.
	private readonly queuedFlights = new Map<string, QueuedFlight>();
	private readonly probe: CredentialProbe;
	private readonly getEnv: EnvironmentResolver;
	private readonly warn: (message: string) => void;
	private readonly reportedAmbientRefusals = new Set<string>();
	private generation = 0;

	constructor(options: GithubHostCredentialTrustOptions = {}) {
		const resolveCommandRunner = options.resolveCommandRunner ?? (() => undefined);
		const clock = options.clock ?? realClock;
		this.probe = options.probe ?? (host => probeLocalGitCredential(host, resolveCommandRunner(), clock));
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

		const verdict = this.verdicts.get(key);
		if (verdict?.kind === "positive") return true;
		if (verdict?.kind === "negative") return false;

		const active = this.activeFlights.get(key);
		if (!active) return this.startFlight(key, this.generation);
		if (active.generation === this.generation) return active.promise;
		return this.queueLatestSuccessor(key, active);
	}

	/**
	 * Keep positive trust for the process lifetime and invalidate negative
	 * verdicts. Active tree ownership remains intact; a later request can queue
	 * one serialized successor for the newest generation.
	 */
	forgetUnverified(): void {
		this.generation++;
		for (const [host, verdict] of this.verdicts) {
			if (verdict.kind === "negative") this.verdicts.delete(host);
		}
	}

	private startFlight(host: string, generation: number): Promise<boolean> {
		const existing = this.activeFlights.get(host);
		if (existing) {
			return existing.generation === this.generation
				? existing.promise
				: this.queueLatestSuccessor(host, existing);
		}

		let complete!: (trusted: boolean) => void;
		const promise = new Promise<boolean>(resolve => { complete = resolve; });
		const flight: ActiveFlight = { generation, promise };
		this.activeFlights.set(host, flight);
		// Install ownership before invoking an injected probe: even a runner that
		// throws synchronously cannot leave an unowned or immortal flight entry.
		void this.resolveFlight(host, flight).then(complete, () => {
			if (this.activeFlights.get(host) === flight) this.activeFlights.delete(host);
			complete(false);
		});
		return promise;
	}

	private queueLatestSuccessor(host: string, active: ActiveFlight): Promise<boolean> {
		const existing = this.queuedFlights.get(host);
		if (existing) {
			existing.generation = this.generation;
			return existing.promise;
		}

		let queued!: QueuedFlight;
		const promise = (async () => {
			await active.promise;
			if (this.queuedFlights.get(host) !== queued) return false;
			this.queuedFlights.delete(host);
			// A refresh with no subsequent trust request invalidates the queued
			// intent. Only a caller from the latest generation may start a tree.
			if (queued.generation !== this.generation) return false;
			return this.startFlight(host, queued.generation);
		})();
		queued = { generation: this.generation, promise };
		this.queuedFlights.set(host, queued);
		return promise;
	}

	private async resolveFlight(host: string, flight: ActiveFlight): Promise<boolean> {
		let trusted = false;
		try {
			trusted = (await this.probe(host)) === true;
		} catch {
			trusted = false;
		}

		const current = this.activeFlights.get(host);
		const currentGeneration = flight.generation === this.generation;
		if (current === flight) this.activeFlights.delete(host);
		if (!currentGeneration) return false;
		if (current !== flight) return false;
		this.verdicts.set(host, { kind: trusted ? "positive" : "negative", generation: flight.generation });
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
	const usesGithubClassToken = hostname === "github.com"
		|| hostname.endsWith(".github.com")
		|| hostname === "github.localhost"
		|| hostname.endsWith(".github.localhost")
		|| hostname.endsWith(".ghe.com");
	const names = usesGithubClassToken ? GITHUB_COM_CLASS_TOKENS : ENTERPRISE_SERVER_CLASS_TOKENS;
	return names.find(name => env[name] !== undefined && env[name] !== "");
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
	// A neutral cwd is not sufficient when Git's repository-selection variables
	// point back to a repository with local credential configuration.
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_COMMON_DIR;
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

function probeLocalGitCredential(host: string, runner: CommandRunner | undefined, clock: Clock): Promise<boolean> {
	// Capability is checked before spawning. A runner that cannot synchronously
	// hand back an owned tree is never allowed to start a credential helper.
	if (!runner?.spawn || runner.supportsOwnedTreeSpawn !== true) return Promise.resolve(false);

	let cwd: string;
	try {
		cwd = mkdtempSync(join(tmpdir(), "bobbit-git-credential-"));
	} catch {
		return Promise.resolve(false);
	}

	return new Promise<boolean>((resolve) => {
		let tree: OwnedTreeControl | undefined;
		let child: ChildProcess;
		try {
			child = runner.spawn!("git", ["credential", "fill"], ownedTreeSpawnOptions({
				cwd,
				env: probeEnvironment(tmpdir()),
				windowsHide: true,
				stdio: ["pipe", "pipe", "ignore"],
			}, clock, control => {
				if (tree) throw new Error("Owned tree control was bound more than once");
				tree = control;
			}));
		} catch {
			cleanupProbeDirectory(cwd);
			resolve(false);
			return;
		}
		if (!tree) {
			// A capability-bearing injected runner that ignored the branded handoff is
			// untrusted. There is no safe root-PID fallback or post-exit tree scan.
			cleanupProbeDirectory(cwd);
			resolve(false);
			return;
		}

		const ownedTree = tree;
		const parser = new CredentialRecordParser(host);
		let settled = false;
		let aborting = false;
		let ownershipEstablished = false;
		let requestWritten = false;
		let closeResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let closeHandled = false;
		let timeoutTimer: TimerHandle | undefined;

		const cleanupAfterTreeBoundary = () => {
			if (cleanupProbeDirectory(cwd)) return;
			const retry = clock.setTimeout(() => { cleanupProbeDirectory(cwd); }, PROBE_CLEANUP_RETRY_MS);
			unref(retry);
		};
		const settle = (result: boolean) => {
			if (settled) return;
			settled = true;
			if (timeoutTimer) clock.clearTimeout(timeoutTimer);
			cleanupAfterTreeBoundary();
			resolve(result);
		};
		const abort = async () => {
			if (settled || aborting) return;
			aborting = true;
			if (timeoutTimer) clock.clearTimeout(timeoutTimer);
			try { ownedTree.killTree("SIGTERM", PROBE_KILL_GRACE_MS); } catch { /* fail closed */ }
			let completed = false;
			try { completed = await ownedTree.waitForTreeExit(PROBE_KILL_GRACE_MS); } catch { /* escalate */ }
			if (!completed) {
				try { ownedTree.killTree("SIGKILL"); } catch { /* fail closed */ }
				try { await ownedTree.waitForTreeExit(PROBE_TREE_SETTLE_MS); } catch { /* bounded failure */ }
			}
			settle(false);
		};
		const finishClose = async () => {
			if (settled || aborting || closeHandled || !ownershipEstablished || !requestWritten || !closeResult) return;
			closeHandled = true;
			if (timeoutTimer) clock.clearTimeout(timeoutTimer);
			const exitedCleanly = closeResult.code === 0 && closeResult.signal == null;
			if (exitedCleanly && !parser.finish()) {
				closeHandled = false;
				await abort();
				return;
			}
			let completed = false;
			try { completed = await ownedTree.waitForTreeExit(PROBE_TREE_SETTLE_MS); } catch { /* fail closed */ }
			settle(exitedCleanly && completed);
		};

		timeoutTimer = clock.setTimeout(() => { void abort(); }, PROBE_TIMEOUT_MS);
		unref(timeoutTimer);

		child.on("error", () => { void abort(); });
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			closeResult = { code, signal };
			void finishClose();
		});
		if (!child.stdout || !child.stdin) {
			void abort();
			return;
		}
		child.stdout.on("data", (chunk: Buffer | string) => {
			if (!settled && !aborting && !parser.push(chunk)) void abort();
		});
		child.stdout.on("error", () => { void abort(); });
		child.stdin.on("error", () => { void abort(); });

		void ownedTree.ownershipReady.then(() => {
			if (settled || aborting) return;
			ownershipEstablished = true;
			if (closeResult) {
				// A helper that completed before receiving our exact request cannot vouch
				// for the authority, even if its unsolicited output looks well formed.
				void abort();
				return;
			}
			try {
				child.stdin!.end(`url=https://${host}\n\n`);
				requestWritten = true;
			} catch {
				void abort();
			}
		}, () => { void abort(); });
	});
}

function cleanupProbeDirectory(cwd: string): boolean {
	try {
		rmSync(cwd, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
}
