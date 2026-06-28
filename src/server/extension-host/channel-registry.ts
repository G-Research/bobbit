// src/server/extension-host/channel-registry.ts
//
// Process-lifetime in-memory Extension Host channel registry. Integration code is
// responsible for authenticating surface tokens and resolving pack-local channel
// contributions before calling this class; the registry enforces permit-gated open,
// tuple scoping, lifecycle, quotas/backpressure, and payload-free audit records.

import { randomUUID } from "node:crypto";
import { ChannelDispatcher, type ChannelHandlerSession } from "./channel-dispatcher.js";
import { ChannelOpenPermitStore } from "./channel-open-permits.js";
import { isChannelModuleHost, WorkerChannelModuleHost, type ChannelModuleHost } from "./channel-module-host.js";
import {
	ChannelError,
	frameByteLength,
	mergeChannelQuotas,
	normalizeSingletonKey,
	validateChannelFrameWithSize,
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

interface LegacyChannelClient {
	sendFrame?: (frame: HostChannelFrame) => void | Promise<void>;
	close?: (ev: { reason?: string; error?: string }) => void | Promise<void>;
}

type SurfaceBinding = { sessionId: string; packId: string; contributionId: string };
type SurfaceBindingResolver = { resolve?: (token: string) => SurfaceBinding | undefined; validate?: (token: string) => SurfaceBinding | undefined };
type ChannelContributionResolver = { getChannel?: (projectId: string | undefined, packId: string, name: string) => unknown };
type TimerHandle = ReturnType<typeof setInterval>;

export interface ChannelOpenRequest {
	sessionId: string;
	projectId?: string;
	packId?: string;
	contribution?: ChannelContributionRef | Record<string, unknown>;
	contributionId?: string;
	channelName?: string;
	name?: string;
	surfaceToken?: string;
	init?: HostChannelOpenInit | { data?: unknown; singletonKey?: string } | unknown;
	openPermit?: string;
	clientId?: string;
	client?: ChannelClientSink | LegacyChannelClient;
}

export interface ChannelOpenResult extends ChannelInfo {
	channelId: string;
	info: ChannelInfo;
	reused: boolean;
}

export interface ChannelAttachRequest {
	sessionId: string;
	projectId?: string;
	packId?: string;
	surfaceToken?: string;
	channelId: string;
	clientId: string;
	client?: ChannelClientSink;
}

export interface ChannelListRequest {
	sessionId: string;
	projectId?: string;
	packId?: string;
	surfaceToken?: string;
	clientId?: string;
	name?: string;
	includeClosed?: boolean;
}

export interface ChannelSendRequest {
	sessionId: string;
	projectId?: string;
	packId?: string;
	surfaceToken?: string;
	channelId: string;
	clientId?: string;
	frame: unknown;
}

export interface ChannelCloseRequest {
	sessionId: string;
	projectId?: string;
	packId?: string;
	surfaceToken?: string;
	channelId: string;
	clientId?: string;
	reason?: string;
}

export interface ChannelRegistryOptions {
	permits?: ChannelOpenPermitStore;
	openPermits?: ChannelOpenPermitStore;
	dispatcher?: ChannelDispatcher;
	quotas?: Partial<ChannelQuotaConfig>;
	now?: () => number;
	idGenerator?: () => string;
	audit?: (event: ChannelAuditEvent) => void;
	auditLog?: { write?: (event: ChannelAuditEvent) => void };
	surfaceBindings?: SurfaceBindingResolver;
	contributionRegistry?: ChannelContributionResolver;
	moduleHost?: ChannelModuleHost | unknown;
	/** Defaults to a bounded production interval. Set false to disable in tests. */
	idleSweepIntervalMs?: number | false;
	/** Closed channel records are diagnostics only; keep them bounded in memory. */
	tombstoneTtlMs?: number;
	maxTombstones?: number;
}

interface ClientAttachment {
	clientId: string;
	sink?: ChannelClientSink;
	autoDrain: boolean;
	queuedFrames: HostChannelFrame[];
	queuedBytes: number;
	inFlightFrames: number;
	inFlightBytes: number;
	attaching: boolean;
}

interface ChannelRecord {
	id: string;
	sessionId: string;
	projectId?: string;
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
	readonly permits: ChannelOpenPermitStore;
	readonly dispatcher: ChannelDispatcher;
	private readonly quotas: ChannelQuotaConfig;
	private readonly now: () => number;
	private readonly idGenerator: () => string;
	private readonly audit?: (event: ChannelAuditEvent) => void;
	private readonly surfaceBindings?: SurfaceBindingResolver;
	private readonly contributionRegistry?: ChannelContributionResolver;
	private readonly idleSweepTimer?: TimerHandle;
	private readonly tombstoneTtlMs: number;
	private readonly maxTombstones: number;
	private readonly channels = new Map<string, ChannelRecord>();
	private readonly tupleIndex = new Map<string, string>();
	private readonly singletonIndex = new Map<string, string>();
	private readonly tombstones = new Map<string, ChannelInfo>();

	constructor(opts: ChannelRegistryOptions = {}) {
		this.now = opts.now ?? Date.now;
		this.audit = opts.audit ?? opts.auditLog?.write;
		this.surfaceBindings = opts.surfaceBindings;
		this.contributionRegistry = opts.contributionRegistry;
		this.quotas = mergeChannelQuotas(opts.quotas);
		this.tombstoneTtlMs = opts.tombstoneTtlMs ?? Math.max(this.quotas.idleTimeoutMs, 5 * 60_000);
		this.maxTombstones = opts.maxTombstones ?? 512;
		this.permits = opts.permits ?? opts.openPermits ?? new ChannelOpenPermitStore({ now: this.now, audit: this.audit });
		const moduleHost = isChannelModuleHost(opts.moduleHost) ? opts.moduleHost : new WorkerChannelModuleHost();
		this.dispatcher = opts.dispatcher ?? new ChannelDispatcher({ moduleHost });
		this.idGenerator = opts.idGenerator ?? (() => randomUUID());
		if (opts.idleSweepIntervalMs !== false) {
			const intervalMs = typeof opts.idleSweepIntervalMs === "number"
				? opts.idleSweepIntervalMs
				: Math.min(60_000, Math.max(1_000, this.quotas.idleTimeoutMs));
			if (intervalMs > 0) {
				this.idleSweepTimer = setInterval(() => {
					void this.sweepIdle().catch((err) => {
						this.emit({ type: "channel.cleanup", at: this.now(), error: err instanceof Error ? err.message : String(err), reason: "idle_sweep_failed" });
					});
				}, intervalMs);
				(this.idleSweepTimer as any).unref?.();
			}
		}
	}

	async open(req: ChannelOpenRequest): Promise<ChannelOpenResult> {
		const resolved = this.resolveOpenRequest(req);
		const { sessionId, packId, contributionId, channelName, contribution, singletonKey, clientId, client, initData } = resolved;
		this.permits.consume(req.openPermit, { sessionId, packId, contributionId, channelName, singletonKey });

		const singletonId = singletonKey ? this.singletonIndex.get(singletonIndexKey(sessionId, packId, channelName, singletonKey)) : undefined;
		const existing = singletonId ? this.channels.get(singletonId) : undefined;
		if (existing && existing.state !== "closed") {
			if (clientId) await this.attachInternal(existing, clientId, client);
			this.emit({ type: "channel.open", at: this.now(), ...auditRecord(existing), reason: "singleton_reuse" });
			return this.openResult(existing, clientId, true);
		}

		const quotas = this.effectiveQuotas(contribution.quotas);
		this.assertCanOpen(sessionId, packId, quotas);
		const id = this.idGenerator();
		const at = this.now();
		const record: ChannelRecord = {
			id,
			sessionId,
			projectId: req.projectId,
			packId,
			contributionId,
			name: channelName,
			protocol: contribution.protocol,
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
		if (clientId) await this.attachInternal(record, clientId, client);

		try {
			const handler = await this.withTimeout(
				this.dispatcher.open({
					contribution,
					ctx: {
						sessionId: record.sessionId,
						packId: record.packId,
						contributionId: record.contributionId,
						channelId: record.id,
						name: record.name,
						protocol: record.protocol,
						init: initData,
						host: {},
						send: async (frame) => { await this.sendFromHandler(record.id, frame); },
						close: async (reason) => { await this.closeInternal(record, reason, "handler"); },
						audit: (event) => { this.emit({ ...event, at: this.now(), ...auditRecord(record) }); },
					},
				}),
				quotas.openTimeoutMs,
				"channel handler open timed out",
				(lateHandler) => this.closeLateHandler(record, lateHandler, "channel handler open timed out"),
			);
			if (record.state === "closed") {
				await this.closeLateHandler(record, handler, record.closeReason ?? "channel closed during open");
				throw new ChannelError(410, "channel_closed", "channel closed during open");
			}
			record.handler = handler;
			record.state = "open";
			record.lastActiveAt = this.now();
			this.emit({ type: "channel.open", at: record.lastActiveAt, ...auditRecord(record) });
			return this.openResult(record, clientId, false);
		} catch (err) {
			await this.closeInternal(record, err instanceof Error ? err.message : "open failed", "handler");
			this.emit({ type: "channel.open.reject", at: this.now(), ...auditRecord(record), error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
	}

	async attach(req: ChannelAttachRequest): Promise<ChannelInfo> {
		const packId = this.resolvePackId(req);
		const record = this.requireChannel(req.sessionId, packId, req.channelId, "attach");
		await this.attachInternal(record, req.clientId, normalizeClientSink(req.client));
		return this.info(record, req.clientId);
	}

	list(req: ChannelListRequest): ChannelInfo[] {
		this.purgeTombstones();
		const packId = this.resolvePackId(req);
		const infos: ChannelInfo[] = [];
		for (const record of this.channels.values()) {
			if (record.sessionId !== req.sessionId || record.packId !== packId) continue;
			if (req.name && record.name !== req.name) continue;
			infos.push(this.info(record, req.clientId));
		}
		if (req.includeClosed) {
			for (const info of this.tombstones.values()) {
				if (info.sessionId !== req.sessionId || info.packId !== packId) continue;
				if (req.name && info.name !== req.name) continue;
				infos.push({ ...info, attached: false });
			}
		}
		this.emit({ type: "channel.list", at: this.now(), sessionId: req.sessionId, packId, channelName: req.name });
		return infos.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	}

	async detach(req: { sessionId: string; packId?: string; surfaceToken?: string; channelId: string; clientId?: string } | string, packId?: string, channelId?: string, clientId?: string): Promise<boolean> {
		const input = typeof req === "string" ? { sessionId: req, packId, channelId, clientId } : req;
		const resolvedPackId = this.resolvePackId(input);
		const record = this.channels.get(String(input.channelId));
		if (!record || record.sessionId !== input.sessionId || record.packId !== resolvedPackId) return false;
		if (!input.clientId) {
			let detached = false;
			for (const attached of [...record.clients.keys()]) detached = (await this.detachInternal(record, attached)) || detached;
			return detached;
		}
		return await this.detachInternal(record, input.clientId);
	}

	async detachClient(clientId: string): Promise<number> {
		let detached = 0;
		for (const record of Array.from(this.channels.values())) {
			if (await this.detachInternal(record, clientId)) detached++;
		}
		return detached;
	}

	async send(req: ChannelSendRequest): Promise<void> {
		await this.sendFromClient(req);
	}

	async receiveClientFrame(req: ChannelSendRequest): Promise<void> {
		await this.sendFromClient(req);
	}

	async sendFromClient(req: ChannelSendRequest): Promise<void> {
		const packId = this.resolvePackId(req);
		const record = this.requireChannel(req.sessionId, packId, req.channelId, "send");
		const clientId = req.clientId ?? (record.clients.size === 1 ? record.clients.keys().next().value : undefined);
		if (!clientId || !record.clients.has(clientId)) throw new ChannelError(403, "not_attached", "client is not attached to this channel");
		if (record.state !== "open") throw new ChannelError(409, "channel_not_open", "channel is not open");
		const { frame, bytes } = this.validateFrameFor(record, req.frame);
		this.assertClientSendRate(record, clientId);
		this.assertInboundCapacity(record, bytes);
		record.inboundBytes += bytes;
		record.inboundFrames++;
		record.lastActiveAt = this.now();
		this.emit({ type: "channel.frame.in", at: record.lastActiveAt, ...auditRecord(record), clientId, frameKind: frame.kind, frameBytes: bytes });
		try {
			await record.handler?.onClientFrame?.(frame);
		} finally {
			record.inboundBytes -= bytes;
			record.inboundFrames--;
		}
	}

	async sendFromHandler(channelId: string, frame: unknown): Promise<void> {
		const record = this.channels.get(channelId);
		if (!record || (record.state !== "open" && record.state !== "opening")) throw new ChannelError(404, "channel_not_found", "channel is not open");
		const { frame: typed, bytes } = this.validateFrameFor(record, frame);
		const recipients = Array.from(record.clients.values());
		this.assertOutboundCapacity(record, bytes * recipients.length, recipients.length);
		for (const client of recipients) this.assertClientOutboundCapacity(record, client, bytes);
		for (const client of recipients) {
			if (!client.attaching && client.autoDrain && client.sink?.onFrame) {
				client.inFlightFrames++;
				client.inFlightBytes += bytes;
			} else {
				client.queuedFrames.push(typed);
				client.queuedBytes += bytes;
			}
			record.outboundBytes += bytes;
			record.outboundFrames++;
		}
		const at = this.now();
		record.lastActiveAt = at;
		this.emit({ type: "channel.frame.out", at, ...auditRecord(record), frameKind: typed.kind, frameBytes: bytes });
		await Promise.all(recipients.map(async (client) => {
			if (client.attaching || !client.autoDrain || !client.sink?.onFrame) return;
			try {
				await client.sink.onFrame(typed);
			} catch (err) {
				await this.detachInternal(record, client.clientId, err).catch((detachErr: unknown) => {
					this.emit({ type: "channel.detach", at: this.now(), ...auditRecord(record), clientId: client.clientId, error: detachErr instanceof Error ? detachErr.message : String(detachErr) });
				});
			} finally {
				if (client.inFlightFrames > 0 && client.inFlightBytes >= bytes) {
					client.inFlightFrames--;
					client.inFlightBytes -= bytes;
					record.outboundBytes -= bytes;
					record.outboundFrames--;
				}
			}
		}));
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
		const packId = this.resolvePackId(req);
		const record = this.requireChannel(req.sessionId, packId, req.channelId, "close");
		if (req.clientId && !record.clients.has(req.clientId)) throw new ChannelError(403, "not_attached", "client is not attached to this channel");
		await this.closeInternal(record, req.reason, "registry");
		return this.tombstones.get(record.id) ?? this.info(record);
	}

	async cleanupSession(req: { sessionId: string; reason?: string } | string): Promise<number> {
		return this.closeSession(typeof req === "string" ? req : req.sessionId, typeof req === "string" ? undefined : req.reason);
	}

	async closeSession(sessionId: string, reason = "session closed"): Promise<number> {
		let count = 0;
		for (const record of Array.from(this.channels.values())) {
			if (record.sessionId !== sessionId) continue;
			await this.closeInternal(record, reason, "registry");
			count++;
		}
		this.purgeTombstones();
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

	async closeUnavailablePacks(reason = "pack unavailable"): Promise<number> {
		if (!this.contributionRegistry?.getChannel) return 0;
		let count = 0;
		for (const record of Array.from(this.channels.values())) {
			const contribution = this.contributionRegistry.getChannel(record.projectId, record.packId, record.name);
			if (contribution) continue;
			await this.closeInternal(record, reason, "registry");
			this.emit({ type: "channel.cleanup", at: this.now(), ...auditRecord(record), reason: "pack_unavailable" });
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

	async dispose(reason = "registry disposed"): Promise<void> {
		if (this.idleSweepTimer) clearInterval(this.idleSweepTimer);
		for (const record of Array.from(this.channels.values())) {
			await this.closeInternal(record, reason, "registry");
		}
		this.tombstones.clear();
		this.dispatcher.invalidate();
	}

	private resolveOpenRequest(req: ChannelOpenRequest): {
		sessionId: string;
		packId: string;
		contributionId: string;
		channelName: string;
		contribution: ChannelContributionRef;
		singletonKey?: string;
		clientId?: string;
		client?: ChannelClientSink;
		initData?: unknown;
	} {
		const initRecord = isRecord(req.init) ? req.init : undefined;
		const singletonKey = normalizeSingletonKey(initRecord?.singletonKey);
		let packId = req.packId;
		let contributionId = req.contributionId;
		const requestedName = typeof req.name === "string" ? req.name : req.channelName;
		let rawContribution = req.contribution;
		if (!rawContribution) {
			const token = typeof req.surfaceToken === "string" ? req.surfaceToken : "";
			const binding = this.resolveSurfaceBinding(token);
			if (!binding) throw new ChannelError(403, "invalid_surface_token", "surface token is invalid or out of scope");
			if (binding.sessionId !== req.sessionId) throw new ChannelError(403, "invalid_surface_token", "surface token session mismatch");
			packId = binding.packId;
			contributionId = binding.contributionId;
			const channelName = requireNonEmpty(requestedName, "channelName");
			rawContribution = this.contributionRegistry?.getChannel?.(req.projectId, packId, channelName) as Record<string, unknown> | undefined;
			if (!rawContribution) throw new ChannelError(404, "channel_not_declared", "channel is not declared by this pack");
		}
		const contribution = normalizeContributionRef(rawContribution, {
			contributionId: requireNonEmpty(contributionId ?? (rawContribution as ChannelContributionRef).contributionId, "contributionId"),
			name: requestedName,
		});
		const channelName = requireNonEmpty(contribution.name, "channelName");
		if (requestedName && channelName !== requestedName) throw new ChannelError(400, "invalid_channel", "channel name mismatch");
		return {
			sessionId: requireNonEmpty(req.sessionId, "sessionId"),
			packId: requireNonEmpty(packId, "packId"),
			contributionId: contribution.contributionId,
			channelName,
			contribution,
			singletonKey,
			clientId: req.clientId,
			client: normalizeClientSink(req.client),
			initData: initRecord && "data" in initRecord ? initRecord.data : req.init,
		};
	}

	private resolveSurfaceBinding(token: string): SurfaceBinding | undefined {
		return this.surfaceBindings?.resolve?.(token) ?? this.surfaceBindings?.validate?.(token);
	}

	private resolvePackId(req: { sessionId: string; packId?: string; surfaceToken?: string }): string {
		if (req.packId) return req.packId;
		const token = typeof req.surfaceToken === "string" ? req.surfaceToken : "";
		const binding = this.resolveSurfaceBinding(token);
		if (!binding) throw new ChannelError(403, "invalid_surface_token", "surface token is invalid or out of scope");
		if (binding.sessionId !== req.sessionId) throw new ChannelError(403, "invalid_surface_token", "surface token session mismatch");
		return binding.packId;
	}

	private openResult(record: ChannelRecord, clientId: string | undefined, reused: boolean): ChannelOpenResult {
		const info = this.info(record, clientId);
		return { ...info, channelId: record.id, info, reused };
	}

	private async attachInternal(record: ChannelRecord, clientId: string, sink?: ChannelClientSink): Promise<void> {
		if (record.state === "closed" || record.state === "closing") throw new ChannelError(410, "channel_closed", "channel is closed");
		const existing = record.clients.get(clientId);
		if (existing) {
			existing.sink = sink;
			existing.autoDrain = sink?.autoDrain !== false;
		} else {
			const attachment: ClientAttachment = { clientId, sink, autoDrain: sink?.autoDrain !== false, queuedFrames: [], queuedBytes: 0, inFlightFrames: 0, inFlightBytes: 0, attaching: true };
			record.clients.set(clientId, attachment);
			try {
				await record.handler?.onAttach?.(clientId);
				attachment.attaching = false;
				await this.flushAutoDrainQueue(record, attachment);
			} catch (err) {
				this.removeClientAccounting(record, attachment);
				record.clients.delete(clientId);
				this.emit({ type: "channel.attach.reject", at: this.now(), ...auditRecord(record), clientId, error: err instanceof Error ? err.message : String(err) });
				throw err;
			}
		}
		record.lastActiveAt = this.now();
		this.emit({ type: "channel.attach", at: record.lastActiveAt, ...auditRecord(record), clientId });
	}

	private async detachInternal(record: ChannelRecord, clientId: string, cause?: unknown): Promise<boolean> {
		const client = record.clients.get(clientId);
		if (!client) return false;
		this.removeClientAccounting(record, client);
		record.clients.delete(clientId);
		let detachError: unknown;
		try {
			await record.handler?.onDetach?.(clientId);
		} catch (err) {
			detachError = err;
		}
		record.lastActiveAt = this.now();
		const causeMessage = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
		const detachErrorMessage = detachError instanceof Error ? detachError.message : typeof detachError === "string" ? detachError : undefined;
		this.emit({ type: "channel.detach", at: record.lastActiveAt, ...auditRecord(record), clientId, error: causeMessage ?? detachErrorMessage });
		if (detachError) throw detachError;
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
			this.removeClientAccounting(record, client);
		}
		record.clients.clear();
		record.outboundBytes = 0;
		record.outboundFrames = 0;
		this.tombstones.set(record.id, this.info(record));
		this.purgeTombstones(record.lastActiveAt);
		this.emit({ type: "channel.close", at: record.lastActiveAt, ...auditRecord(record), reason });
	}

	private effectiveQuotas(contributionQuotas: Partial<ChannelQuotaConfig> | undefined): ChannelQuotaConfig {
		const narrowed: Partial<ChannelQuotaConfig> = {};
		if (contributionQuotas) {
			for (const key of Object.keys(this.quotas) as Array<keyof ChannelQuotaConfig>) {
				const declared = contributionQuotas[key];
				if (typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0) {
					narrowed[key] = Math.min(this.quotas[key], declared);
				}
			}
		}
		return mergeChannelQuotas(this.quotas, narrowed);
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

	private assertOutboundCapacity(record: ChannelRecord, bytes: number, frames = 1): void {
		if (record.outboundBytes + bytes > record.quotas.maxOutboundBytes) this.rejectFrame(record, "maxOutboundBytes", "outbound byte quota exceeded");
		if (record.outboundFrames + frames > record.quotas.maxOutboundFrames) this.rejectFrame(record, "maxOutboundFrames", "outbound frame quota exceeded");
	}

	private assertClientOutboundCapacity(record: ChannelRecord, client: ClientAttachment, bytes: number): void {
		if (client.queuedBytes + client.inFlightBytes + bytes > record.quotas.maxClientOutboundBytes) this.rejectFrame(record, "maxClientOutboundBytes", "client outbound byte quota exceeded");
		if (client.queuedFrames.length + client.inFlightFrames + 1 > record.quotas.maxClientOutboundFrames) this.rejectFrame(record, "maxClientOutboundFrames", "client outbound frame quota exceeded");
	}

	private rejectFrame(record: ChannelRecord, quota: string, message: string): never {
		this.emit({ type: "channel.frame.reject", at: this.now(), ...auditRecord(record), quota });
		throw new ChannelError(429, "channel_backpressure", message);
	}

	private validateFrameFor(record: ChannelRecord, input: unknown): { frame: HostChannelFrame; bytes: number } {
		try {
			return validateChannelFrameWithSize(input, record.quotas.maxFrameBytes);
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

	private async flushAutoDrainQueue(record: ChannelRecord, client: ClientAttachment): Promise<void> {
		if (!client.autoDrain || !client.sink?.onFrame) return;
		while (client.queuedFrames.length > 0) {
			const frame = client.queuedFrames.shift()!;
			const bytes = frameByteLength(frame);
			client.queuedBytes -= bytes;
			client.inFlightFrames++;
			client.inFlightBytes += bytes;
			try {
				await client.sink.onFrame(frame);
			} finally {
				if (client.inFlightFrames > 0 && client.inFlightBytes >= bytes) {
					client.inFlightFrames--;
					client.inFlightBytes -= bytes;
					record.outboundBytes -= bytes;
					record.outboundFrames--;
				}
			}
		}
	}

	private removeClientAccounting(record: ChannelRecord, client: ClientAttachment): void {
		record.outboundBytes -= client.queuedBytes + client.inFlightBytes;
		record.outboundFrames -= client.queuedFrames.length + client.inFlightFrames;
		client.queuedFrames.length = 0;
		client.queuedBytes = 0;
		client.inFlightFrames = 0;
		client.inFlightBytes = 0;
		client.attaching = false;
	}

	private async closeLateHandler(record: ChannelRecord, handler: ChannelHandlerSession | undefined, reason: string): Promise<void> {
		if (!handler?.close) return;
		await Promise.resolve(handler.close(reason)).catch((err: unknown) => {
			this.emit({ type: "channel.close", at: this.now(), ...auditRecord(record), error: err instanceof Error ? err.message : String(err) });
		});
	}

	private purgeTombstones(now = this.now()): void {
		if (this.tombstoneTtlMs >= 0) {
			for (const [id, info] of this.tombstones) {
				if (info.lastActiveAt + this.tombstoneTtlMs < now) this.tombstones.delete(id);
			}
		}
		if (this.maxTombstones >= 0 && this.tombstones.size > this.maxTombstones) {
			const ordered = [...this.tombstones.entries()].sort((a, b) => a[1].lastActiveAt - b[1].lastActiveAt || a[0].localeCompare(b[0]));
			for (const [id] of ordered.slice(0, this.tombstones.size - this.maxTombstones)) this.tombstones.delete(id);
		}
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

	private withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string, onLateResolve?: (value: T) => void | Promise<void>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new ChannelError(504, "channel_timeout", message));
			}, timeoutMs);
			work.then(
				(value) => {
					if (settled) {
						void Promise.resolve(onLateResolve?.(value)).catch((err: unknown) => {
							this.emit({ type: "channel.cleanup", at: this.now(), error: err instanceof Error ? err.message : String(err), reason: "late_open_cleanup_failed" });
						});
						return;
					}
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

function normalizeClientSink(client: ChannelOpenRequest["client"] | ChannelAttachRequest["client"]): ChannelClientSink | undefined {
	if (!client) return undefined;
	const legacy = client as LegacyChannelClient;
	if (legacy.sendFrame || legacy.close) {
		return {
			onFrame: legacy.sendFrame,
			onClose: legacy.close,
			autoDrain: (client as ChannelClientSink).autoDrain,
		};
	}
	return client as ChannelClientSink;
}

function normalizeContributionRef(raw: ChannelContributionRef | Record<string, unknown>, fallback: { contributionId: string; name?: string }): ChannelContributionRef {
	const record = raw as Record<string, unknown>;
	const name = typeof record.name === "string" ? record.name : fallback.name;
	return {
		contributionId: typeof record.contributionId === "string" && record.contributionId ? record.contributionId : fallback.contributionId,
		name: requireNonEmpty(name, "channelName"),
		protocol: typeof record.protocol === "string" ? record.protocol : undefined,
		modulePath: typeof record.modulePath === "string" ? record.modulePath : typeof record.module === "string" ? record.module : undefined,
		sourceFile: typeof record.sourceFile === "string" ? record.sourceFile : undefined,
		handler: typeof record.handler === "string" ? record.handler : undefined,
		packRoot: typeof record.packRoot === "string" ? record.packRoot : undefined,
		capabilities: Array.isArray(record.capabilities) ? record.capabilities.filter((cap): cap is string => typeof cap === "string") : undefined,
		quotas: normalizeContributionQuotas(record),
	};
}

function normalizeContributionQuotas(record: Record<string, unknown>): Partial<ChannelQuotaConfig> | undefined {
	const source = isRecord(record.quotas) ? { ...record, ...record.quotas } : record;
	const out: Partial<ChannelQuotaConfig> = {};
	copyInt(source, out, "maxChannelsPerSessionPerPack", "maxChannelsPerSessionPerPack");
	copyInt(source, out, "maxGatewayChannels", "maxGatewayChannels");
	copyInt(source, out, "maxFrameBytes", "maxFrameBytes");
	copyInt(source, out, "maxInboundBytes", "maxInboundBytes", "maxInboundBufferedBytesPerChannel", "maxInboundBufferedBytes");
	copyInt(source, out, "maxInboundFrames", "maxInboundFrames", "maxInboundBufferedFramesPerChannel", "maxInboundBufferedFrames");
	copyInt(source, out, "maxOutboundBytes", "maxOutboundBytes", "maxOutboundBufferedBytesPerChannel", "maxOutboundBufferedBytes");
	copyInt(source, out, "maxOutboundFrames", "maxOutboundFrames", "maxOutboundBufferedFramesPerChannel", "maxOutboundBufferedFrames");
	copyInt(source, out, "maxClientOutboundBytes", "maxClientOutboundBytes", "maxBufferedBytesPerAttachedClient");
	copyInt(source, out, "maxClientOutboundFrames", "maxClientOutboundFrames", "maxAttachedClientBufferedFrames");
	copyInt(source, out, "maxClientSendRatePerSecond", "maxClientSendRatePerSecond", "sendRateFramesPerSecond", "maxInboundFramesPerSecond");
	copyInt(source, out, "idleTimeoutMs", "idleTimeoutMs");
	copyInt(source, out, "openTimeoutMs", "openTimeoutMs");
	copyInt(source, out, "closeGraceMs", "closeGraceMs");
	return Object.keys(out).length > 0 ? out : undefined;
}

function copyInt(source: Record<string, unknown>, out: Partial<ChannelQuotaConfig>, target: keyof ChannelQuotaConfig, ...keys: string[]): void {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			out[target] = value;
			return;
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, field: string): string {
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
