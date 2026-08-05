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

/**
 * Project-owned append-only JSONL audit. Only normalized tuple fields are ever
 * persisted; arbitrary request metadata cannot reach this store.
 */
export class ExtensionGrantAuditStore {
	private readonly auditFile: string;

	constructor(private readonly stateDir: string, private readonly fs: FsLike = realFs) {
		this.auditFile = path.join(stateDir, "extension-capability-audit.jsonl");
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

	/** Newest valid rows, returned in chronological order. Corrupt partial rows are skipped. */
	list(limit = 100): ExtensionGrantAuditEntry[] {
		const boundedLimit = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100;
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
			return entries.slice(-boundedLimit);
		} catch {
			throw new ExtensionGrantAuditStoreError();
		}
	}
}
