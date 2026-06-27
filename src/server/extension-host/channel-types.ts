// src/server/extension-host/channel-types.ts
//
// Shared server-side types for Extension Host channels. These types deliberately
// model the generic framed channel substrate only; terminal/PTY behavior is a
// pack-owned protocol layered on top.

export type HostChannelFrame =
	| { kind: "text"; data: string }
	| { kind: "json"; data: unknown };

export type ChannelState = "opening" | "open" | "closing" | "closed";

export interface HostChannelOpenInit {
	data?: unknown;
	singletonKey?: string;
}

export interface ChannelInfo {
	id: string;
	name: string;
	packId: string;
	sessionId: string;
	state: ChannelState;
	createdAt: number;
	lastActiveAt: number;
	attached: boolean;
	closeReason?: string;
}

export interface ChannelOpenPermitBinding {
	sessionId: string;
	packId: string;
	contributionId: string;
	channelName: string;
	singletonKey?: string;
}

export interface ChannelContributionRef {
	contributionId: string;
	name: string;
	protocol?: string;
	modulePath?: string;
	/** Original YAML source file, used to resolve module paths relative to channels/<name>.yaml. */
	sourceFile?: string;
	handler?: string;
	packRoot?: string;
	quotas?: Partial<ChannelQuotaConfig>;
	capabilities?: readonly string[];
}

export interface ChannelQuotaConfig {
	maxChannelsPerSessionPerPack: number;
	maxGatewayChannels: number;
	maxFrameBytes: number;
	maxInboundBytes: number;
	maxInboundFrames: number;
	maxOutboundBytes: number;
	maxOutboundFrames: number;
	maxClientOutboundBytes: number;
	maxClientOutboundFrames: number;
	maxClientSendRatePerSecond: number;
	idleTimeoutMs: number;
	openTimeoutMs: number;
	closeGraceMs: number;
}

export const DEFAULT_CHANNEL_QUOTAS: ChannelQuotaConfig = Object.freeze({
	maxChannelsPerSessionPerPack: 4,
	maxGatewayChannels: 128,
	maxFrameBytes: 64 * 1024,
	maxInboundBytes: 256 * 1024,
	maxInboundFrames: 64,
	maxOutboundBytes: 512 * 1024,
	maxOutboundFrames: 128,
	maxClientOutboundBytes: 256 * 1024,
	maxClientOutboundFrames: 64,
	maxClientSendRatePerSecond: 60,
	idleTimeoutMs: 5 * 60_000,
	openTimeoutMs: 10_000,
	closeGraceMs: 2_000,
});

export function mergeChannelQuotas(...parts: Array<Partial<ChannelQuotaConfig> | undefined>): ChannelQuotaConfig {
	return Object.freeze(Object.assign({}, DEFAULT_CHANNEL_QUOTAS, ...parts));
}

export type ChannelAuditEventType =
	| "permit.mint"
	| "permit.consume"
	| "permit.reject"
	| "channel.open"
	| "channel.open.reject"
	| "channel.attach"
	| "channel.attach.reject"
	| "channel.detach"
	| "channel.list"
	| "channel.frame.in"
	| "channel.frame.out"
	| "channel.frame.reject"
	| "channel.close"
	| "channel.cleanup";

export interface ChannelAuditEvent {
	type: ChannelAuditEventType;
	at: number;
	sessionId?: string;
	packId?: string;
	contributionId?: string;
	channelName?: string;
	channelId?: string;
	clientId?: string;
	state?: ChannelState;
	reason?: string;
	error?: string;
	quota?: string;
	frameKind?: HostChannelFrame["kind"];
	frameBytes?: number;
	singletonKey?: string;
}

export class ChannelError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ChannelError";
		this.status = status;
		this.code = code;
	}
}

export function normalizeSingletonKey(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function frameByteLength(frame: HostChannelFrame): number {
	if (frame.kind === "text") return Buffer.byteLength(frame.data, "utf8");
	return Buffer.byteLength(JSON.stringify(frame.data) ?? "null", "utf8");
}

export function validateChannelFrame(
	frame: unknown,
	options: number | { maxFrameBytes?: number } = DEFAULT_CHANNEL_QUOTAS.maxFrameBytes,
): HostChannelFrame {
	const maxFrameBytes = typeof options === "number" ? options : options.maxFrameBytes ?? DEFAULT_CHANNEL_QUOTAS.maxFrameBytes;
	if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
		throw new ChannelError(400, "invalid_frame", "channel frame must be an object");
	}
	const candidate = frame as Record<string, unknown>;
	if (candidate.kind === "text") {
		if (typeof candidate.data !== "string") {
			throw new ChannelError(400, "invalid_frame", "text channel frame data must be a string");
		}
		const typed: HostChannelFrame = { kind: "text", data: candidate.data };
		assertFrameSize(typed, maxFrameBytes);
		return typed;
	}
	if (candidate.kind === "json") {
		if (!Object.prototype.hasOwnProperty.call(candidate, "data") || candidate.data === undefined) {
			throw new ChannelError(400, "invalid_frame", "json channel frame data is required");
		}
		const typed: HostChannelFrame = { kind: "json", data: candidate.data };
		assertJsonSerializable(typed.data);
		assertFrameSize(typed, maxFrameBytes);
		return typed;
	}
	throw new ChannelError(400, "invalid_frame", "channel frame kind must be text or json");
}

function assertFrameSize(frame: HostChannelFrame, maxFrameBytes: number): void {
	const bytes = frameByteLength(frame);
	if (bytes > maxFrameBytes) {
		throw new ChannelError(413, "frame_too_large", `channel frame exceeds ${maxFrameBytes} bytes`);
	}
}

function assertJsonSerializable(value: unknown): void {
	try {
		JSON.stringify(value);
	} catch {
		throw new ChannelError(400, "invalid_frame", "json channel frame data must be JSON serializable");
	}
}
