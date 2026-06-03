/**
 * Marketplace MVP — sync mechanism (§4).
 *
 * Sources are reached through a SourceBackend so a hosted registry is a new
 * backend, not a rewrite (§8.2). MVP ships GitSourceBackend (shallow clone /
 * fetch+reset+clean) and LocalSourceBackend (read in place). The scanner
 * always operates on the returned `root`, so it is backend-agnostic.
 */

import { execFile as execFileCb } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { stripTokenFromGitUrl } from "../skills/git.js";
import type { SourceRecord } from "./types.js";

const execFile = promisify(execFileCb);
const GIT_TIMEOUT_MS = 120_000;

export interface SyncResult {
	root: string;
	commit: string | null;
	contentHash: string | null;
	error: string | null;
}

export interface SourceBackend {
	kind: string;
	/** Sync the source into `cacheDir` (git) or validate it in place (local). */
	sync(source: SourceRecord, cacheDir: string): Promise<SyncResult>;
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 });
	return stdout.toString();
}

export class GitSourceBackend implements SourceBackend {
	kind = "git";

	async sync(source: SourceRecord, cacheDir: string): Promise<SyncResult> {
		const url = source.url ?? "";
		if (!url) return { root: cacheDir, commit: null, contentHash: null, error: "git source has no url" };
		const ref = source.ref || null;
		try {
			const hasClone = fs.existsSync(path.join(cacheDir, ".git"));
			if (!hasClone) {
				// Fresh / corrupt cache → shallow clone.
				if (fs.existsSync(cacheDir)) fs.rmSync(cacheDir, { recursive: true, force: true });
				fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
				const cloneArgs = ["clone", "--depth", "1"];
				if (ref) cloneArgs.push("--branch", ref);
				cloneArgs.push(url, cacheDir);
				await git(cloneArgs);
			} else {
				// Re-sync → fetch + hard reset + clean (never a merge in a cache the user never edits).
				const fetchRef = ref || "HEAD";
				await git(["fetch", "--depth", "1", "origin", fetchRef], cacheDir);
				await git(["reset", "--hard", "FETCH_HEAD"], cacheDir);
				await git(["clean", "-fdx"], cacheDir);
			}
			const commit = (await git(["rev-parse", "HEAD"], cacheDir)).trim();
			return { root: cacheDir, commit: commit || null, contentHash: null, error: null };
		} catch (err) {
			// Surface a token-stripped message; leave any previous good cache intact.
			const msg = (err as Error).message.split(url).join(stripTokenFromGitUrl(url));
			return { root: cacheDir, commit: null, contentHash: null, error: msg };
		}
	}
}

export class LocalSourceBackend implements SourceBackend {
	kind = "local";

	async sync(source: SourceRecord): Promise<SyncResult> {
		const root = source.path ?? "";
		if (!root) return { root, commit: null, contentHash: null, error: "local source has no path" };
		try {
			if (!fs.statSync(root).isDirectory()) {
				return { root, commit: null, contentHash: null, error: `local source path is not a directory: ${root}` };
			}
		} catch {
			return { root, commit: null, contentHash: null, error: `local source path does not exist: ${root}` };
		}
		return { root, commit: null, contentHash: null, error: null };
	}
}

export class MarketplaceSyncService {
	private readonly cacheRoot: string;
	private readonly backends: Record<string, SourceBackend>;

	constructor(cacheRoot: string, backends?: Record<string, SourceBackend>) {
		this.cacheRoot = cacheRoot;
		this.backends = backends ?? {
			git: new GitSourceBackend(),
			local: new LocalSourceBackend(),
		};
	}

	/** The per-source git clone cache dir. */
	cacheDir(id: string): string {
		return path.join(this.cacheRoot, id);
	}

	/** The directory the scanner reads: git → clone cache; local → path in place. */
	syncRoot(source: SourceRecord): string {
		if (source.kind === "local") return source.path ?? "";
		return this.cacheDir(source.id);
	}

	async sync(source: SourceRecord): Promise<SyncResult> {
		const backend = this.backends[source.kind];
		if (!backend) {
			return { root: this.syncRoot(source), commit: null, contentHash: null, error: `unknown source kind: ${source.kind}` };
		}
		return backend.sync(source, this.cacheDir(source.id));
	}

	/** Delete a source's git clone cache (no-op for local). */
	removeCache(id: string): void {
		const dir = this.cacheDir(id);
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
	}
}
