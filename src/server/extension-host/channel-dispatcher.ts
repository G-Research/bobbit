// src/server/extension-host/channel-dispatcher.ts
//
// Minimal generic channel handler dispatch substrate. It is intentionally protocol
// agnostic: terminal-like behavior is implemented by a pack handler, not here.

import type { ChannelAuditEvent, ChannelContributionRef, HostChannelFrame } from "./channel-types.js";

export interface ChannelHandlerContext {
	readonly sessionId: string;
	readonly packId: string;
	readonly contributionId: string;
	readonly channelId: string;
	readonly name: string;
	readonly protocol?: string;
	readonly init?: unknown;
	readonly host: Record<string, never>;
	send(frame: HostChannelFrame): Promise<void>;
	close(reason?: string): Promise<void>;
	audit(event: Omit<ChannelAuditEvent, "at" | "sessionId" | "packId" | "contributionId" | "channelName" | "channelId">): void;
}

export interface ChannelHandlerSession {
	onClientFrame?(frame: HostChannelFrame): Promise<void> | void;
	onAttach?(clientId: string): Promise<void> | void;
	onDetach?(clientId: string): Promise<void> | void;
	close?(reason?: string): Promise<void> | void;
}

export type ChannelHandlerFactory = (ctx: ChannelHandlerContext) => Promise<ChannelHandlerSession | void> | ChannelHandlerSession | void;

export interface ChannelDispatcherOpenRequest {
	contribution: ChannelContributionRef;
	ctx: ChannelHandlerContext;
}

/**
 * Dispatches channel opens to registered generic factories. Integration code can
 * register factories by contribution id, protocol, or channel name. The fallback
 * is a no-op session, which keeps the registry independently testable until the
 * pack-schema/WS integration wires real module loading.
 */
export class ChannelDispatcher {
	private readonly byContributionId = new Map<string, ChannelHandlerFactory>();
	private readonly byProtocol = new Map<string, ChannelHandlerFactory>();
	private readonly byName = new Map<string, ChannelHandlerFactory>();

	registerContribution(contributionId: string, factory: ChannelHandlerFactory): () => void {
		this.byContributionId.set(contributionId, factory);
		return () => { this.byContributionId.delete(contributionId); };
	}

	registerProtocol(protocol: string, factory: ChannelHandlerFactory): () => void {
		this.byProtocol.set(protocol, factory);
		return () => { this.byProtocol.delete(protocol); };
	}

	registerName(name: string, factory: ChannelHandlerFactory): () => void {
		this.byName.set(name, factory);
		return () => { this.byName.delete(name); };
	}

	async open(req: ChannelDispatcherOpenRequest): Promise<ChannelHandlerSession> {
		const factory = this.byContributionId.get(req.contribution.contributionId)
			?? (req.contribution.protocol ? this.byProtocol.get(req.contribution.protocol) : undefined)
			?? this.byName.get(req.contribution.name);
		if (!factory) return {};
		return (await factory(req.ctx)) ?? {};
	}

	invalidate(): void {
		this.byContributionId.clear();
		this.byProtocol.clear();
		this.byName.clear();
	}
}
