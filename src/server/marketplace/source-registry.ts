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
import type { SourceKind, SourceRecord } from "./types.js";

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

		if (kind === "git") {
			url = (input.url ?? "").trim();
			if (!url) throw new SourceRegistryError("git source requires a non-empty url");
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
			ref: input.ref?.trim() || null,
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
