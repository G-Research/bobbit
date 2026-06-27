// src/server/extension-host/channel-registry.ts
//
// Process-lifetime in-memory Extension Host channel registry. Integration code is
// responsible for authenticating surface tokens and resolving pack-local channel
// contributions before calling this class; the registry enforces grant-gated open,
// tuple scoping, lifecycle, quotas/backpressure, and payload-free audit records.

import { randomUUID } from "node:crypto";
import { ChannelDispatcher, type ChannelHandlerSession } from "./channel-dispatcher.js";
import { ChannelOpenGrantStore } from "./channel-open-grants.js";
import {
	ChannelError,
	frameByteLength,
	mergeChannelQuotas,
	normalizeSingletonKey,
	validateChannelFrame,
	type ChannelAuditEvent,
	type ChannelContributionRef,
	type ChannelInfo,
	type ChannelQuotaConfig,
	type ChannelState,
	type HostChannelFrame,
	type HostChannelOpenInit,
} from "./channel-types.js";

export interface ChannelClientSink {
	onFrame?: (frame: HostChannelFrame) => void | Promise<void>;
	onClose?: (ev: { reason?: string; error?: string }) => void | Promise<void>;
	/** Defaults true. Set false for pull/drain clients to exercise delivery buffers. */
	autoDrain?: boolean;
}

export interface ChannelOpenRequest {
	sessionId: string;
	packId: string;
	contribution: ChannelContributionRef;
	init?: HostChannelOpenInit;
	openGrant?: string;
	clientId?: string;
	client?: ChannelClientSink;
}

export interface ChannelOpenResult {
	channelId: string;
	info: ChannelInfo;
	reused: boolean;
}

export interface ChannelAttachRequest {
	sessionId: string;
	packId: string;
	channelId: string;
	clientId: string;
	client?: ChannelClientSink;
}

export interface ChannelListRequest {
	sessionId: string;
	packId: string;
	clientId?: string;
	name?: string;
	includeClosed?: boolean;
}

export interface ChannelSendRequest {
	sessionId: string;
	packId: string;
	channelId: string;
	clientId: string;
	frame: unknown;
}

export interface ChannelCloseRequest {
	sessionId: string;
	packId: string;
	channelId: string;
	clientId?: string;
	reason?: string;
}

export interface ChannelRegistryOptions {
	grants?: ChannelOpenGrantStore;
	dispatcher?: ChannelDispatcher;
	quotas?: Partial<ChannelQuotaConfig>;
	now?: () => number;
	idGenerator?: () => string;
	audit?: (event: ChannelAuditEvent) => void;
}

interface ClientAttachment {
	clientId: string;
	sink?: ChannelClientSink;
	autoDrain: boolean;
	queuedFrames: HostChannelFrame[];
	queuedBytes: number;
}

interface ChannelRecord {
	id: string;
	sessionId: string;
	packId: string;
	contributionId: string;
	name: string;
	protocol?: string;
	singletonKey?: string;
	state: ChannelState;
	createdAt: number;
	lastActiveAt: number;
	closeReason?: string;
	quotas: ChannelQuotaConfig;
	clients: Map<string, ClientAttachment>;
	sendBuckets: Map<string, TokenBucket>;
	handler?: ChannelHandlerSession;
	inboundBytes: number;
	inboundFrames: number;
	outboundBytes: number;
	outboundFrames: number;
}

class TokenBucket {
	private tokens: number;
	private last: number;

	constructor(
		private readonly capacity: number,
		private readonly refillPerSec: number,
		private readonly now: () => number,
	) {
		this.tokens = capacity;
		this.last = now();
	}

	allow(): boolean {
		if (this.capacity <= 0) return false;
		const at = this.now();
		const elapsed = Math.max(0, (at - this.last) / 1000);
		if (elapsed > 0) {
			this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
			this.last = at;
		}
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

export class ChannelRegistry {
	readonly grants: ChannelOpenGrantStore;
	readonly dispatcher: ChannelDispatcher;
	private readonly quotas: ChannelQuotaConfig;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private readonly audit?: (event: ChannelAuditEvent) => void;
	private readonly channels = new Map<string, ChannelRecord>();
	private readonly tupleIndex = new Map<string, string>();
	private readonly singletonIndex = new Map<string, string>();
	private readonly tombstones = new Map<string, ChannelInfo>();

	constructor(opts: ChannelRegistryOptions = {}) {
		this.now = opts.now ?? Date.now;
		this.audit = opts.audit;
		this.quotas = mergeChannelQuotas(opts.quotas);
		this.grants = opts.grants ?? new ChannelOpenGrantStore({ now: this.now, audit: opts.audit });
		this.dispatcher = opts.dispatcher ?? new ChannelDispatcher();
		this.idGenerator = opts.idGenerator ?? (() => randomUUID());
	}

	async open(req: ChannelOpenRequest): Promise<ChannelOpenResult> {
		const contributionId = requireNonEmpty(req.contribution.contributionId, "contributionId");
		const channelName = requireNonEmpty(req.contribution.name, "channelName");
		if (channelName !== req.contribution.name) throw new ChannelError(400, "invalid_channel", "channel name mismatch");
		const singletonKey = normalizeSingletonKey(req.init?.singletonKey);
		this.grants.consume(req.openGrant, {
			sessionId: req.sessionId,
			packId: req.packId,
			contributionId,
			channelName,
			singletonKey,
		});

		const singletonId = singletonKey ? this.singletonIndex.get(singletonIndexKey(req.sessionId, req.packId, channelName, singletonKey)) : undefined;
		const existing = singletonId ? this.channels.get(singletonId) : undefined;
		if (existing && existing.state !== "closed") {
			if (req.clientId) await this.attachInternal(existing, req.clientId, req.client);
			this.emit({ type: "channel.open", at: this.now(), ...auditRecord(existing), reason: "singleton_reuse" });
			return { channelId: existing.id, info: this.info(existing, req.clientId), reused: true };
		}

		const quotas = mergeChannelQuotas(this.quotas, req.contribution.quotas);
		this.assertCanOpen(req.sessionId, req.packId, quotas);
		const id = this.idGenerator();
		const at = this.now();
		const record: ChannelRecord = {
			id,
			sessionId: req.sessionId,
			packId: req.packId,
			contributionId,
			name: channelName,
			protocol: req.contribution.protocol,
			singletonKey,
			state: "opening",
			createdAt: at,
			lastActiveAt: at,
			quotas,
			clients: new Map(),
			sendBuckets: new Map(),
			inboundBytes: 0,
			inboundFrames: 0,
			outboundBytes: 0,
			outboundFrames: 0,
		};
		this.index(record);
		if (req.clientId) await this.attachInternal(record, req.clientId, req.client);

		try {
			record.handler = await this.withTimeout(
				this.dispatcher.open({
					contribution: req.contribution,
					ctx: {
						sessionId: record.sessionId,
						packId: record.packId,
						contributionId: record.contributionId,
						channelId: record.id,
						name: record.name,
						protocol: record.protocol,
						init: req.init?.data,
						host: {},
						send: async (frame) => { await this.sendFromHandler(record.id, frame); },
						close: async (reason) => { await this.closeInternal(record, reason, "handler"); },
						audit: (event) => { this.emit({ ...event, at: this.now(), ...auditRecord(record) }); },
					},
				}),
				quotas.openTimeoutMs,
				"channel handler open timed out",
			);
			record.state = "open";
			record.lastActiveAt = this.now();
			this.emit({ type: "channel.open", at: record.lastActiveAt, ...auditRecord(record) });
			return { channelId: id, info: this.info(record, req.clientId), reused: false };
		} catch (err) {
			await this.closeInternal(record, err instanceof Error ? err.message : "open failed", "handler");
			this.emit({ type: "channel.open.reject", at: this.now(), ...auditRecord(record), error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	async attach(req: ChannelAttachRequest): Promise<ChannelInfo> {
		const record = this.requireChannel(req.sessionId, req.packId, req.channelId, "attach");
		await this.attachInternal(record, req.clientId, req.client);
		return this.info(record, req.clientId);
	}

	list(req: ChannelListRequest): ChannelInfo[] {
		const infos: ChannelInfo[] = [];
		for (const record of this.channels.values()) {
			if (record.sessionId !== req.sessionId || record.packId !== req.packId) continue;
			if (req.name && record.name !== req.name) continue;
			infos.push(this.info(record, req.clientId));
		}
		if (req.includeClosed) {
			for (const info of this.tombstones.values()) {
				if (info.sessionId !== req.sessionId || info.packId !== req.packId) continue;
				if (req.name && info.name !== req.name) continue;
				infos.push({ ...info, attached: false });
			}
		}
		this.emit({ type: "channel.list", at: this.now(), sessionId: req.sessionId, packId: req.packId, channelName: req.name });
		return infos.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	async detach(sessionId: string, packId: string, channelId: string, clientId: string): Promise<boolean> {
		const record = this.channels.get(channelId);
		if (!record || record.sessionId !== sessionId || record.packId !== packId) return false;
		return await this.detachInternal(record, clientId);
	}

	async detachClient(clientId: string): Promise<number> {
		let detached = 0;
		for (const record of Array.from(this.channels.values())) {
			if (await this.detachInternal(record, clientId)) detached++;
		}
		return detached;
	}

	async sendFromClient(req: ChannelSendRequest): Promise<void> {
		const record = this.requireChannel(req.sessionId, req.packId, req.channelId, "send");
		if (!record.clients.has(req.clientId)) throw new ChannelError(403, "not_attached", "client is not attached to this channel");
		if (record.state !== "open") throw new ChannelError(409, "channel_not_open", "channel is not open");
		const frame = this.validateFrameFor(record, req.frame);
		const bytes = frameByteLength(frame);
		this.assertClientSendRate(record, req.clientId);
		this.assertInboundCapacity(record, bytes);
		record.inboundBytes += bytes;
		record.inboundFrames++;
		record.lastActiveAt = this.now();
		this.emit({ type: "channel.frame.in", at: record.lastActiveAt, ...auditRecord(record), clientId: req.clientId, frameKind: frame.kind, frameBytes: bytes });
		try {
			await record.handler?.onClientFrame?.(frame);
		} finally {
			record.inboundBytes -= bytes;
			record.inboundFrames--;
		}
	}

	async sendFromHandler(channelId: string, frame: unknown): Promise<void> {
		const record = this.channels.get(channelId);
		if (!record || record.state !== "open") throw new ChannelError(404, "channel_not_found", "channel is not open");
		const typed = this.validateFrameFor(record, frame);
		const bytes = frameByteLength(typed);
		this.assertOutboundCapacity(record, bytes);
		const slowClients = Array.from(record.clients.values()).filter((client) => !client.autoDrain || !client.sink?.onFrame);
		for (const client of slowClients) this.assertClientOutboundCapacity(record, client, bytes);
		for (const client of slowClients) {
			client.queuedFrames.push(typed);
			client.queuedBytes += bytes;
			record.outboundBytes += bytes;
			record.outboundFrames++;
		}
		const at = this.now();
		record.lastActiveAt = at;
		this.emit({ type: "channel.frame.out", at, ...auditRecord(record), frameKind: typed.kind, frameBytes: bytes });
		for (const client of record.clients.values()) {
			if (!client.autoDrain || !client.sink?.onFrame) continue;
			try {
				await client.sink.onFrame(typed);
			} catch (err) {
				this.emit({ type: "channel.detach", at: this.now(), ...auditRecord(record), clientId: client.clientId, error: err instanceof Error ? err.message : String(err) });
				record.clients.delete(client.clientId);
			}
		}
	}

	drainClient(sessionId: string, packId: string, channelId: string, clientId: string, maxFrames = Number.POSITIVE_INFINITY): HostChannelFrame[] {
		const record = this.requireChannel(sessionId, packId, channelId, "drain");
		const client = record.clients.get(clientId);
		if (!client) throw new ChannelError(403, "not_attached", "client is not attached to this channel");
		const frames = client.queuedFrames.splice(0, maxFrames);
		let bytes = 0;
		for (const frame of frames) bytes += frameByteLength(frame);
		client.queuedBytes -= bytes;
		record.outboundBytes -= bytes;
		record.outboundFrames -= frames.length;
		return frames;
	}

	async close(req: ChannelCloseRequest): Promise<ChannelInfo> {
		const record = this.requireChannel(req.sessionId, req.packId, req.channelId, "close");
		if (req.clientId && !record.clients.has(req.clientId)) throw new ChannelError(403, "not_attached", "client is not attached to this channel");
		await this.closeInternal(record, req.reason, "registry");
		return this.tombstones.get(record.id) ?? this.info(record);
	}

	async closeSession(sessionId: string, reason = "session closed"): Promise<number> {
		let count = 0;
		for (const record of Array.from(this.channels.values())) {
			if (record.sessionId !== sessionId) continue;
			await this.closeInternal(record, reason, "registry");
			count++;
		}
		return count;
	}

	async closePack(sessionId: string, packId: string, reason = "pack unavailable"): Promise<number> {
		let count = 0;
		for (const record of Array.from(this.channels.values())) {
			if (record.sessionId !== sessionId || record.packId !== packId) continue;
			await this.closeInternal(record, reason, "registry");
			count++;
		}
		return count;
	}

	async sweepIdle(now = this.now()): Promise<number> {
		let count = 0;
		for (const record of Array.from(this.channels.values())) {
			if (record.clients.size > 0) continue;
			if (record.lastActiveAt + record.quotas.idleTimeoutMs > now) continue;
			await this.closeInternal(record, "idle timeout", "registry");
			this.emit({ type: "channel.cleanup", at: this.now(), ...auditRecord(record), reason: "idle_timeout" });
			count++;
		}
		return count;
	}

	activeCount(): number {
		return this.channels.size;
	}

	private async attachInternal(record: ChannelRecord, clientId: string, sink?: ChannelClientSink): Promise<void> {
		if (record.state === "closed" || record.state === "closing") throw new ChannelError(410, "channel_closed", "channel is closed");
		const existing = record.clients.get(clientId);
		if (existing) {
			existing.sink = sink;
			existing.autoDrain = sink?.autoDrain !== false;
		} else {
			record.clients.set(clientId, { clientId, sink, autoDrain: sink?.autoDrain !== false, queuedFrames: [], queuedBytes: 0 });
			await record.handler?.onAttach?.(clientId);
		}
		record.lastActiveAt = this.now();
		this.emit({ type: "channel.attach", at: record.lastActiveAt, ...auditRecord(record), clientId });
	}

	private async detachInternal(record: ChannelRecord, clientId: string): Promise<boolean> {
		const client = record.clients.get(clientId);
		if (!client) return false;
		record.outboundBytes -= client.queuedBytes;
		record.outboundFrames -= client.queuedFrames.length;
		record.clients.delete(clientId);
		await record.handler?.onDetach?.(clientId);
		record.lastActiveAt = this.now();
		this.emit({ type: "channel.detach", at: record.lastActiveAt, ...auditRecord(record), clientId });
		return true;
	}

	private async closeInternal(record: ChannelRecord, reason: string | undefined, source: "handler" | "registry"): Promise<void> {
		if (record.state === "closed") return;
		record.state = "closing";
		record.closeReason = reason;
		if (source !== "handler") {
			await this.withTimeout(Promise.resolve(record.handler?.close?.(reason)), record.quotas.closeGraceMs, "channel handler close timed out").catch((err) => {
				this.emit({ type: "channel.close", at: this.now(), ...auditRecord(record), error: err instanceof Error ? err.message : String(err) });
			});
		}
		record.state = "closed";
		record.lastActiveAt = this.now();
		this.unindex(record);
		for (const client of record.clients.values()) {
			await Promise.resolve(client.sink?.onClose?.({ reason })).catch((err: unknown) => {
				this.emit({ type: "channel.detach", at: this.now(), ...auditRecord(record), clientId: client.clientId, error: err instanceof Error ? err.message : String(err) });
			});
		}
		record.clients.clear();
		record.outboundBytes = 0;
		record.outboundFrames = 0;
		this.tombstones.set(record.id, this.info(record));
		this.emit({ type: "channel.close", at: record.lastActiveAt, ...auditRecord(record), reason });
	}

	private assertCanOpen(sessionId: string, packId: string, quotas: ChannelQuotaConfig): void {
		if (this.channels.size >= quotas.maxGatewayChannels) {
			this.emit({ type: "channel.open.reject", at: this.now(), sessionId, packId, quota: "maxGatewayChannels" });
			throw new ChannelError(429, "channel_quota_exceeded", "gateway channel limit exceeded");
		}
		let count = 0;
		for (const record of this.channels.values()) {
			if (record.sessionId === sessionId && record.packId === packId && record.state !== "closed") count++;
		}
		if (count >= quotas.maxChannelsPerSessionPerPack) {
			this.emit({ type: "channel.open.reject", at: this.now(), sessionId, packId, quota: "maxChannelsPerSessionPerPack" });
			throw new ChannelError(429, "channel_quota_exceeded", "pack channel limit exceeded");
		}
	}

	private assertClientSendRate(record: ChannelRecord, clientId: string): void {
		let bucket = record.sendBuckets.get(clientId);
		if (!bucket) {
			bucket = new TokenBucket(record.quotas.maxClientSendRatePerSecond, record.quotas.maxClientSendRatePerSecond, this.now);
			record.sendBuckets.set(clientId, bucket);
		}
		if (!bucket.allow()) this.rejectFrame(record, "maxClientSendRatePerSecond", "client send rate exceeded");
	}

	private assertInboundCapacity(record: ChannelRecord, bytes: number): void {
		if (record.inboundBytes + bytes > record.quotas.maxInboundBytes) this.rejectFrame(record, "maxInboundBytes", "inbound byte quota exceeded");
		if (record.inboundFrames + 1 > record.quotas.maxInboundFrames) this.rejectFrame(record, "maxInboundFrames", "inbound frame quota exceeded");
	}

	private assertOutboundCapacity(record: ChannelRecord, bytes: number): void {
		if (record.outboundBytes + bytes > record.quotas.maxOutboundBytes) this.rejectFrame(record, "maxOutboundBytes", "outbound byte quota exceeded");
		if (record.outboundFrames + 1 > record.quotas.maxOutboundFrames) this.rejectFrame(record, "maxOutboundFrames", "outbound frame quota exceeded");
	}

	private assertClientOutboundCapacity(record: ChannelRecord, client: ClientAttachment, bytes: number): void {
		if (client.queuedBytes + bytes > record.quotas.maxClientOutboundBytes) this.rejectFrame(record, "maxClientOutboundBytes", "client outbound byte quota exceeded");
		if (client.queuedFrames.length + 1 > record.quotas.maxClientOutboundFrames) this.rejectFrame(record, "maxClientOutboundFrames", "client outbound frame quota exceeded");
	}

	private rejectFrame(record: ChannelRecord, quota: string, message: string): never {
		this.emit({ type: "channel.frame.reject", at: this.now(), ...auditRecord(record), quota });
		throw new ChannelError(429, "channel_backpressure", message);
	}

	private validateFrameFor(record: ChannelRecord, frame: unknown): HostChannelFrame {
		try {
			return validateChannelFrame(frame, record.quotas.maxFrameBytes);
		} catch (err) {
			if (err instanceof ChannelError) {
				this.emit({ type: "channel.frame.reject", at: this.now(), ...auditRecord(record), error: err.code });
			}
			throw err;
		}
	}

	private requireChannel(sessionId: string, packId: string, channelId: string, op: string): ChannelRecord {
		const record = this.channels.get(channelId);
		if (!record || record.sessionId !== sessionId || record.packId !== packId) {
			this.emit({ type: op === "attach" ? "channel.attach.reject" : "channel.frame.reject", at: this.now(), sessionId, packId, channelId, reason: "not_found_or_scope_mismatch" });
			throw new ChannelError(404, "channel_not_found", "channel not found");
		}
		if (record.state === "closed") throw new ChannelError(410, "channel_closed", "channel is closed");
		return record;
	}

	private index(record: ChannelRecord): void {
		this.channels.set(record.id, record);
		this.tupleIndex.set(tupleKey(record.sessionId, record.packId, record.id, record.name), record.id);
		if (record.singletonKey) this.singletonIndex.set(singletonIndexKey(record.sessionId, record.packId, record.name, record.singletonKey), record.id);
	}

	private unindex(record: ChannelRecord): void {
		this.channels.delete(record.id);
		this.tupleIndex.delete(tupleKey(record.sessionId, record.packId, record.id, record.name));
		if (record.singletonKey) this.singletonIndex.delete(singletonIndexKey(record.sessionId, record.packId, record.name, record.singletonKey));
	}

	private info(record: ChannelRecord, clientId?: string): ChannelInfo {
		return {
			id: record.id,
			name: record.name,
			packId: record.packId,
			sessionId: record.sessionId,
			state: record.state,
			createdAt: record.createdAt,
			lastActiveAt: record.lastActiveAt,
			attached: clientId ? record.clients.has(clientId) : record.clients.size > 0,
			closeReason: record.closeReason,
		};
	}

	private withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ChannelError(504, "channel_timeout", message));
			}, timeoutMs);
			work.then(
				(value) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(value);
				},
				(err) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					reject(err);
				},
			);
		});
	}

	private emit(event: ChannelAuditEvent): void {
		this.audit?.(event);
	}
}

function requireNonEmpty(value: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw new ChannelError(400, "invalid_channel", `${field} is required`);
	return value;
}

function tupleKey(sessionId: string, packId: string, channelId: string, name: string): string {
	return `${sessionId}\u0000${packId}\u0000${channelId}\u0000${name}`;
}

function singletonIndexKey(sessionId: string, packId: string, name: string, singletonKey: string): string {
	return `${sessionId}\u0000${packId}\u0000${name}\u0000${singletonKey}`;
}

function auditRecord(record: ChannelRecord): Pick<ChannelAuditEvent, "sessionId" | "packId" | "contributionId" | "channelName" | "channelId" | "state" | "singletonKey"> {
	return {
		sessionId: record.sessionId,
		packId: record.packId,
		contributionId: record.contributionId,
		channelName: record.name,
		channelId: record.id,
		state: record.state,
		singletonKey: record.singletonKey,
	};
}
