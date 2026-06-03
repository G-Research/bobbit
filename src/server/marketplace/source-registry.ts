/**
 * Marketplace MVP — source registry (§3).
 *
 * Server-global JSON store at <stateDir>/marketplace/sources.json. Mirrors
 * ProjectRegistry's atomic write (temp file + rename). The source list is a
 * machine/user-level concern (fetch locations + credentials), independent of
 * any project — install *scope* is chosen per-install, not here.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stripTokenFromGitUrl } from "../skills/git.js";
import type { SourceKind, SourceRecord } from "./types.js";

/**
 * Query-param / fragment keys that may carry a credential and must be redacted
 * from any surfaced/logged git URL (case-insensitive).
 */
const SENSITIVE_URL_KEYS = /^(?:token|access_token|private_token|personal_access_token|oauth_token|api[_-]?key|key|auth|authorization|password|passwd|secret)$/i;

/**
 * Fully redact credentials from a git URL for display/logging:
 *  - userinfo (`user:token@host`) via the shared `stripTokenFromGitUrl` helper;
 *  - sensitive query-string params (`?token=…`, `?access_token=…`, …);
 *  - a fragment that carries a token assignment (`#access_token=…`).
 * Non-URL forms (scp-like `git@host:path`, local paths) are returned unchanged.
 */
export function redactGitUrl(url: string): string {
	const stripped = stripTokenFromGitUrl(url);
	let parsed: URL;
	try {
		parsed = new URL(stripped);
	} catch {
		return stripped; // not a parseable URL (ssh shorthand / local path)
	}
	let changed = false;
	for (const key of [...parsed.searchParams.keys()]) {
		if (SENSITIVE_URL_KEYS.test(key)) {
			parsed.searchParams.delete(key);
			changed = true;
		}
	}
	// Fragments are meaningless to git remotes; drop one that looks like it
	// smuggles a credential (`#token=…`, `#access_token=…`, …).
	if (parsed.hash) {
		const frag = parsed.hash.replace(/^#/, "");
		const fragKey = frag.split("=")[0];
		if (SENSITIVE_URL_KEYS.test(fragKey)) {
			parsed.hash = "";
			changed = true;
		}
	}
	return changed ? parsed.toString() : stripped;
}

/**
 * Return a copy of a source record with any embedded git credentials stripped
 * from `url`. Storage keeps the credential-bearing URL (the git backend needs
 * it to authenticate); every API DTO must pass through here so tokens never
 * leave the server.
 */
export function redactSourceUrl(record: SourceRecord): SourceRecord {
	if (!record.url) return record;
	return { ...record, url: redactGitUrl(record.url) };
}

export interface AddSourceInput {
	kind: SourceKind;
	url?: string | null;
	ref?: string | null;
	path?: string | null;
	label?: string | null;
}

export class SourceRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceRegistryError";
	}
}

/** git refs/branches/tags joined into argv must match a conservative grammar. */
export const GIT_REF_PATTERN = /^[A-Za-z0-9._/-]+$/;
const ALLOWED_GIT_SCHEMES = ["https", "ssh", "git", "file"];

/**
 * Reject a git URL that could be mis-parsed by `git clone`/`git fetch` as an
 * option (a leading `-`) or that uses a dangerous protocol helper (e.g.
 * `ext::`). Only the well-known transport schemes are allowed; the scp-like
 * shorthand `user@host:path` (no URL scheme) is permitted because it cannot
 * begin with `-` and carries no protocol-helper risk.
 */
export function validateGitUrl(url: string): void {
	if (url.startsWith("-")) {
		throw new SourceRegistryError(`git url must not start with "-" (would be parsed as a git option): ${url}`);
	}
	const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
	if (schemeMatch) {
		const scheme = schemeMatch[1].toLowerCase();
		if (!ALLOWED_GIT_SCHEMES.includes(scheme)) {
			throw new SourceRegistryError(
				`git url scheme must be one of ${ALLOWED_GIT_SCHEMES.join("/")}, got: ${scheme}:`,
			);
		}
		return;
	}
	// No URL scheme — only the scp-like shorthand (user@host:path) is acceptable.
	if (!/^[^/:]+@[^/:]+:/.test(url)) {
		throw new SourceRegistryError(
			`git url must use an ${ALLOWED_GIT_SCHEMES.join("/")} scheme or scp-like syntax, got: ${url}`,
		);
	}
}

/** Reject a git ref that could be mis-parsed as an option or contains unsafe chars. */
export function validateGitRef(ref: string): void {
	if (ref.startsWith("-")) {
		throw new SourceRegistryError(`git ref must not start with "-": ${ref}`);
	}
	if (!GIT_REF_PATTERN.test(ref)) {
		throw new SourceRegistryError(`git ref must match ${GIT_REF_PATTERN}, got: ${ref}`);
	}
}

export class SourceRegistry {
	private sources = new Map<string, SourceRecord>();
	private readonly storePath: string;

	constructor(stateDir: string) {
		this.storePath = path.join(stateDir, "marketplace", "sources.json");
		this.load();
	}

	load(): void {
		try {
			const raw = fs.readFileSync(this.storePath, "utf-8");
			const parsed = JSON.parse(raw);
			const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed?.sources;
			this.sources.clear();
			if (Array.isArray(arr)) {
				for (const s of arr) {
					if (s && typeof s === "object" && typeof (s as SourceRecord).id === "string") {
						this.sources.set((s as SourceRecord).id, s as SourceRecord);
					}
				}
			}
		} catch {
			this.sources.clear();
		}
	}

	private save(): void {
		const dir = path.dirname(this.storePath);
		fs.mkdirSync(dir, { recursive: true });
		const tmp = this.storePath + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify({ version: 1, sources: this.list() }, null, 2), "utf-8");
		fs.renameSync(tmp, this.storePath);
	}

	list(): SourceRecord[] {
		return [...this.sources.values()].sort((a, b) => a.addedAt - b.addedAt);
	}

	get(id: string): SourceRecord | undefined {
		return this.sources.get(id);
	}

	/** Validate + add a source; assign an id. Does NOT sync (caller kicks sync). */
	add(input: AddSourceInput): SourceRecord {
		const kind = input.kind;
		if (kind !== "git" && kind !== "local") {
			throw new SourceRegistryError(`kind must be "git" or "local", got: ${String(kind)}`);
		}

		let url: string | null = null;
		let srcPath: string | null = null;
		let defaultLabel: string;

		const ref = input.ref?.trim() || null;
		if (ref) validateGitRef(ref);

		if (kind === "git") {
			url = (input.url ?? "").trim();
			if (!url) throw new SourceRegistryError("git source requires a non-empty url");
			validateGitUrl(url);
			defaultLabel = basenameFromGitUrl(url);
		} else {
			srcPath = (input.path ?? "").trim();
			if (!srcPath) throw new SourceRegistryError("local source requires a path");
			if (!path.isAbsolute(srcPath)) throw new SourceRegistryError(`local source path must be absolute, got: ${srcPath}`);
			let stat: fs.Stats;
			try { stat = fs.statSync(srcPath); } catch { throw new SourceRegistryError(`local source path does not exist: ${srcPath}`); }
			if (!stat.isDirectory()) throw new SourceRegistryError(`local source path is not a directory: ${srcPath}`);
			defaultLabel = path.basename(srcPath);
		}

		const record: SourceRecord = {
			id: randomUUID().slice(0, 8),
			kind,
			url,
			ref,
			path: srcPath,
			label: input.label?.trim() || defaultLabel,
			addedAt: Date.now(),
			lastSyncedAt: null,
			lastSyncCommit: null,
			lastSyncError: null,
		};
		this.sources.set(record.id, record);
		this.save();
		return record;
	}

	/** Apply a partial update (typically sync status) and persist. */
	update(id: string, patch: Partial<SourceRecord>): SourceRecord {
		const record = this.sources.get(id);
		if (!record) throw new SourceRegistryError(`source not found: ${id}`);
		const next = { ...record, ...patch, id: record.id };
		this.sources.set(id, next);
		this.save();
		return next;
	}

	remove(id: string): void {
		if (!this.sources.has(id)) throw new SourceRegistryError(`source not found: ${id}`);
		this.sources.delete(id);
		this.save();
	}
}

function basenameFromGitUrl(url: string): string {
	const cleaned = url.replace(/\.git$/, "").replace(/\/+$/, "");
	const idx = Math.max(cleaned.lastIndexOf("/"), cleaned.lastIndexOf(":"));
	const base = idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
	return base || url;
}
