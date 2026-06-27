// src/server/extension-host/channel-open-grants.ts
//
// In-memory, one-shot grants for process-creating channel opens. The token is
// opaque to clients and is consumed before any handler/PTY creation can occur.

import { randomBytes } from "node:crypto";
import {
	ChannelError,
	normalizeSingletonKey,
	type ChannelAuditEvent,
	type ChannelOpenGrantBinding,
} from "./channel-types.js";

interface StoredGrant {
	binding: Required<Pick<ChannelOpenGrantBinding, "sessionId" | "packId" | "contributionId" | "channelName">> & Pick<ChannelOpenGrantBinding, "singletonKey">;
	createdAt: number;
	expiresAt: number;
	consumedAt?: number;
}

export interface ChannelOpenGrantStoreOptions {
	ttlMs?: number;
	now?: () => number;
	randomToken?: () => string;
	audit?: (event: ChannelAuditEvent) => void;
}

export interface ChannelOpenGrantConsumeResult {
	token: string;
	createdAt: number;
	expiresAt: number;
	consumedAt: number;
}

const DEFAULT_TTL_MS = 30_000;

export class ChannelOpenGrantStore {
	private readonly grants = new Map<string, StoredGrant>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private readonly randomToken: () => string;
	private readonly audit?: (event: ChannelAuditEvent) => void;

	constructor(opts: ChannelOpenGrantStoreOptions = {}) {
		this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
		this.now = opts.now ?? Date.now;
		this.randomToken = opts.randomToken ?? (() => randomBytes(24).toString("base64url"));
		this.audit = opts.audit;
	}

	mint(binding: ChannelOpenGrantBinding): string {
		const normalized = normalizeBinding(binding);
		const createdAt = this.now();
		const expiresAt = createdAt + this.ttlMs;
		let token = this.randomToken();
		while (this.grants.has(token)) token = this.randomToken();
		this.grants.set(token, { binding: normalized, createdAt, expiresAt });
		this.emit({ type: "grant.mint", at: createdAt, ...auditBinding(normalized) });
		return token;
	}

	consume(token: string | undefined, expected: ChannelOpenGrantBinding): ChannelOpenGrantConsumeResult {
		const normalized = normalizeBinding(expected);
		const at = this.now();
		if (typeof token !== "string" || token.length === 0) {
			this.reject(at, normalized, "missing");
		}
		const grant = this.grants.get(token);
		if (!grant) {
			this.reject(at, normalized, "unknown");
		}
		if (grant.consumedAt !== undefined) {
			this.reject(at, normalized, "replayed");
		}
		if (grant.expiresAt <= at) {
			this.grants.delete(token);
			this.reject(at, normalized, "expired");
		}
		if (!bindingsEqual(grant.binding, normalized)) {
			grant.consumedAt = at;
			this.reject(at, normalized, "mismatch");
		}
		grant.consumedAt = at;
		this.emit({ type: "grant.consume", at, ...auditBinding(normalized) });
		return { token, createdAt: grant.createdAt, expiresAt: grant.expiresAt, consumedAt: at };
	}

	cleanupExpired(): number {
		const at = this.now();
		let removed = 0;
		for (const [token, grant] of this.grants) {
			if (grant.expiresAt <= at) {
				this.grants.delete(token);
				removed++;
			}
		}
		return removed;
	}

	clear(): void {
		this.grants.clear();
	}

	private reject(at: number, binding: StoredGrant["binding"], reason: string): never {
		this.emit({ type: "grant.reject", at, ...auditBinding(binding), reason });
		throw new ChannelError(403, "invalid_open_grant", `channel open grant rejected: ${reason}`);
	}

	private emit(event: ChannelAuditEvent): void {
		this.audit?.(event);
	}
}

function normalizeBinding(binding: ChannelOpenGrantBinding): StoredGrant["binding"] {
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
		throw new ChannelError(400, "invalid_open_grant_binding", `open grant ${field} is required`);
	}
	return value;
}

function bindingsEqual(a: StoredGrant["binding"], b: StoredGrant["binding"]): boolean {
	return a.sessionId === b.sessionId
		&& a.packId === b.packId
		&& a.contributionId === b.contributionId
		&& a.channelName === b.channelName
		&& a.singletonKey === b.singletonKey;
}

function auditBinding(binding: StoredGrant["binding"]): Pick<ChannelAuditEvent, "sessionId" | "packId" | "contributionId" | "channelName" | "singletonKey"> {
	return {
		sessionId: binding.sessionId,
		packId: binding.packId,
		contributionId: binding.contributionId,
		channelName: binding.channelName,
		singletonKey: binding.singletonKey,
	};
}
