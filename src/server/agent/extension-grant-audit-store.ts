import path from "node:path";
import type { FsLike } from "../gateway-deps.js";
import { realFs } from "../gateway-deps.js";
import {
	isCanonicalExtensionGrantTimestamp,
	isExtensionCapability,
	isSafeExtensionGrantIdentifier,
	type ExtensionCapability,
} from "./project-config-store.js";

export type ExtensionGrantAuditAction = "granted" | "revoked";

/** Secret-free durable administrative history for extension authority changes. */
export interface ExtensionGrantAuditEntry {
	at: string;
	actor: string;
	action: ExtensionGrantAuditAction;
	packId: string;
	hookId: string;
	capability: ExtensionCapability;
}

/** Exact safe tuple used to recover a post-mutation audit failure. */
export interface ExtensionGrantAuditRef {
	action: ExtensionGrantAuditAction;
	packId: string;
	hookId: string;
	capability: ExtensionCapability;
}

export class ExtensionGrantAuditStoreError extends Error {
	readonly code = "EXTENSION_GRANT_AUDIT_UNAVAILABLE";
	constructor() {
		super("Extension grant audit is unavailable. The grant change remains active; retry to record the audit event.");
		this.name = "ExtensionGrantAuditStoreError";
	}
}

function normalizeEntry(value: unknown): ExtensionGrantAuditEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const candidate = value as Record<string, unknown>;
	if (!isCanonicalExtensionGrantTimestamp(candidate.at)
		|| !isSafeExtensionGrantIdentifier(candidate.actor)
		|| (candidate.action !== "granted" && candidate.action !== "revoked")
		|| !isSafeExtensionGrantIdentifier(candidate.packId)
		|| !isSafeExtensionGrantIdentifier(candidate.hookId)
		|| !isExtensionCapability(candidate.capability)) return undefined;
	return {
		at: candidate.at,
		actor: candidate.actor,
		action: candidate.action,
		packId: candidate.packId,
		hookId: candidate.hookId,
		capability: candidate.capability,
	};
}

function sameEntry(left: ExtensionGrantAuditEntry, right: ExtensionGrantAuditEntry): boolean {
	return left.at === right.at
		&& left.actor === right.actor
		&& left.action === right.action
		&& left.packId === right.packId
		&& left.hookId === right.hookId
		&& left.capability === right.capability;
}

function matchesRef(entry: ExtensionGrantAuditEntry, ref: ExtensionGrantAuditRef): boolean {
	return entry.action === ref.action
		&& entry.packId === ref.packId
		&& entry.hookId === ref.hookId
		&& entry.capability === ref.capability;
}

/**
 * Project-owned append-only JSONL audit. Only normalized tuple fields are ever
 * persisted; arbitrary request metadata cannot reach this store.
 */
export class ExtensionGrantAuditStore {
	private readonly auditFile: string;
	private readonly outboxFile: string;

	constructor(private readonly stateDir: string, private readonly fs: FsLike = realFs) {
		this.auditFile = path.join(stateDir, "extension-capability-audit.jsonl");
		this.outboxFile = path.join(stateDir, "extension-capability-audit.outbox.json");
	}

	append(entry: ExtensionGrantAuditEntry): void {
		const normalized = normalizeEntry(entry);
		if (!normalized) throw new ExtensionGrantAuditStoreError();
		try {
			if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
			this.fs.appendFileSync(this.auditFile, `${JSON.stringify(normalized)}\n`, "utf-8");
		} catch {
			// Never log request or audit-entry values here: safe callers may retry,
			// and error strings from mocked/OS filesystems can contain paths/data.
			throw new ExtensionGrantAuditStoreError();
		}
	}

	/**
	 * Append a mutation audit row, preserving it in a project-owned outbox when
	 * append fails after authority has already changed. A later exact retry can
	 * drain the row without re-granting or re-revoking authority.
	 */
	appendOrQueue(entry: ExtensionGrantAuditEntry): void {
		const normalized = normalizeEntry(entry);
		if (!normalized) throw new ExtensionGrantAuditStoreError();
		try {
			this.flushPending();
			this.append(normalized);
		} catch {
			try { this.queue(normalized); } catch { /* Preserve the safe 503 below. */ }
			throw new ExtensionGrantAuditStoreError();
		}
	}

	/** Drains a pending event only when this request names its exact safe tuple. */
	recoverPending(ref: ExtensionGrantAuditRef): boolean {
		const pending = this.readOutbox();
		if (!pending.some(entry => matchesRef(entry, ref))) return false;
		this.flushPending();
		return true;
	}

	/** Newest valid rows, returned in chronological order. Corrupt partial rows are skipped. */
	list(limit = 100): ExtensionGrantAuditEntry[] {
		const boundedLimit = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
		return this.readAudit().slice(-boundedLimit);
	}

	private readAudit(): ExtensionGrantAuditEntry[] {
		try {
			if (!this.fs.existsSync(this.auditFile)) return [];
			const entries: ExtensionGrantAuditEntry[] = [];
			for (const line of this.fs.readFileSync(this.auditFile, "utf-8").split(/\r?\n/)) {
				if (!line) continue;
				try {
					const entry = normalizeEntry(JSON.parse(line));
					if (entry) entries.push(entry);
				} catch { /* Corrupt/truncated JSONL line is intentionally ignored. */ }
			}
			return entries;
		} catch {
			throw new ExtensionGrantAuditStoreError();
		}
	}

	private readOutbox(): ExtensionGrantAuditEntry[] {
		try {
			if (!this.fs.existsSync(this.outboxFile)) return [];
			const value = JSON.parse(String(this.fs.readFileSync(this.outboxFile, "utf-8")));
			if (!Array.isArray(value)) return [];
			const pending: ExtensionGrantAuditEntry[] = [];
			for (const candidate of value) {
				const entry = normalizeEntry(candidate);
				if (entry && !pending.some(existing => sameEntry(existing, entry))) pending.push(entry);
			}
			return pending;
		} catch {
			throw new ExtensionGrantAuditStoreError();
		}
	}

	private queue(entry: ExtensionGrantAuditEntry): void {
		const pending = this.readOutbox();
		if (!pending.some(existing => sameEntry(existing, entry))) pending.push(entry);
		this.writeOutbox(pending);
	}

	private flushPending(): void {
		const pending = this.readOutbox();
		if (pending.length === 0) return;
		const recorded = this.readAudit();
		for (const entry of pending) {
			if (!recorded.some(existing => sameEntry(existing, entry))) {
				this.append(entry);
				recorded.push(entry);
			}
		}
		this.writeOutbox([]);
	}

	private writeOutbox(entries: readonly ExtensionGrantAuditEntry[]): void {
		try {
			if (entries.length === 0) {
				if (this.fs.existsSync(this.outboxFile)) this.fs.unlinkSync(this.outboxFile);
				return;
			}
			if (!this.fs.existsSync(this.stateDir)) this.fs.mkdirSync(this.stateDir, { recursive: true });
			const temp = `${this.outboxFile}.tmp`;
			this.fs.writeFileSync(temp, JSON.stringify(entries), "utf-8");
			this.fs.renameSync(temp, this.outboxFile);
		} catch {
			throw new ExtensionGrantAuditStoreError();
		}
	}
}
