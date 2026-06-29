// src/server/extension-host/channel-open-permits.ts
//
// In-memory, one-shot permits for process-creating channel opens. The token is
// opaque to clients and is consumed before any handler/PTY creation can occur.

import { randomBytes } from "node:crypto";
import {
	ChannelError,
	normalizeSingletonKey,
	type ChannelAuditEvent,
	type ChannelOpenPermitBinding,
} from "./channel-types.js";

interface StoredPermit {
	binding: Required<Pick<ChannelOpenPermitBinding, "sessionId" | "packId" | "contributionId" | "channelName">> & Pick<ChannelOpenPermitBinding, "singletonKey">;
	createdAt: number;
	expiresAt: number;
}

export interface ChannelOpenPermitStoreOptions {
	ttlMs?: number;
	now?: () => number;
	randomToken?: () => string;
	audit?: (event: ChannelAuditEvent) => void;
}

export interface ChannelOpenPermitConsumeResult {
	token: string;
	createdAt: number;
	expiresAt: number;
	consumedAt: number;
}

const DEFAULT_TTL_MS = 30_000;

export class ChannelOpenPermitStore {
	private readonly permits = new Map<string, StoredPermit>();
	private readonly consumedPermits = new Map<string, number>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly randomToken: () => string;
	private readonly audit?: (event: ChannelAuditEvent) => void;

	constructor(opts: ChannelOpenPermitStoreOptions = {}) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.now = opts.now ?? Date.now;
		this.randomToken = opts.randomToken ?? (() => randomBytes(24).toString("base64url"));
		this.audit = opts.audit;
	}

	mint(binding: ChannelOpenPermitBinding): string {
		const normalized = normalizeBinding(binding);
		const createdAt = this.now();
		this.cleanupExpiredAt(createdAt);
		const expiresAt = createdAt + this.ttlMs;
		let token = this.randomToken();
		while (this.permits.has(token)) token = this.randomToken();
		this.permits.set(token, { binding: normalized, createdAt, expiresAt });
		this.emit({ type: "permit.mint", at: createdAt, ...auditBinding(normalized) });
		return token;
	}

	consume(token: string | undefined, expected: ChannelOpenPermitBinding): ChannelOpenPermitConsumeResult {
		const normalized = normalizeBinding(expected);
		const at = this.now();
		if (typeof token !== "string" || token.length === 0) {
			this.reject(at, normalized, "missing");
		}
		const consumedExpiresAt = this.consumedPermits.get(token);
		if (consumedExpiresAt !== undefined) {
			if (consumedExpiresAt > at) this.reject(at, normalized, "replayed");
			this.consumedPermits.delete(token);
		}
		const permit = this.permits.get(token);
		if (!permit) {
			this.cleanupExpiredAt(at);
			this.reject(at, normalized, "unknown");
		}
		if (permit.expiresAt <= at) {
			this.permits.delete(token);
			this.reject(at, normalized, "expired");
		}
		this.permits.delete(token);
		this.cleanupExpiredAt(at);
		this.consumedPermits.set(token, permit.expiresAt);
		if (!bindingsEqual(permit.binding, normalized)) {
			this.reject(at, normalized, "mismatch");
		}
		this.emit({ type: "permit.consume", at, ...auditBinding(normalized) });
		return { token, createdAt: permit.createdAt, expiresAt: permit.expiresAt, consumedAt: at };
	}

	cleanupExpired(): number {
		return this.cleanupExpiredAt(this.now());
	}

	pendingCount(): number {
		return this.permits.size;
	}

	clear(): void {
		this.permits.clear();
		this.consumedPermits.clear();
	}

	private cleanupExpiredAt(at: number): number {
		let removed = 0;
		for (const [token, permit] of this.permits) {
			if (permit.expiresAt <= at) {
				this.permits.delete(token);
				removed++;
			}
		}
		for (const [token, expiresAt] of this.consumedPermits) {
			if (expiresAt <= at) {
				this.consumedPermits.delete(token);
				removed++;
			}
		}
		return removed;
	}

	private reject(at: number, binding: StoredPermit["binding"], reason: string): never {
		this.emit({ type: "permit.reject", at, ...auditBinding(binding), reason });
		throw new ChannelError(403, "invalid_open_permit", `channel open permit rejected: ${reason}`);
	}

	private emit(event: ChannelAuditEvent): void {
		this.audit?.(event);
	}
}

function normalizeBinding(binding: ChannelOpenPermitBinding): StoredPermit["binding"] {
	const sessionId = requireNonEmpty(binding.sessionId, "sessionId");
	const packId = requireNonEmpty(binding.packId, "packId");
	const contributionId = requireNonEmpty(binding.contributionId, "contributionId");
	const channelName = requireNonEmpty(binding.channelName, "channelName");
	return {
		sessionId,
		packId,
		contributionId,
		channelName,
		singletonKey: normalizeSingletonKey(binding.singletonKey),
	};
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ChannelError(400, "invalid_open_permit_binding", `open permit ${field} is required`);
	}
	return value;
}

function bindingsEqual(a: StoredPermit["binding"], b: StoredPermit["binding"]): boolean {
	return a.sessionId === b.sessionId
		&& a.packId === b.packId
		&& a.contributionId === b.contributionId
		&& a.channelName === b.channelName
		&& a.singletonKey === b.singletonKey;
}

function auditBinding(binding: StoredPermit["binding"]): Pick<ChannelAuditEvent, "sessionId" | "packId" | "contributionId" | "channelName" | "singletonKey"> {
	return {
		sessionId: binding.sessionId,
		packId: binding.packId,
		contributionId: binding.contributionId,
		channelName: binding.channelName,
		singletonKey: binding.singletonKey,
	};
}
