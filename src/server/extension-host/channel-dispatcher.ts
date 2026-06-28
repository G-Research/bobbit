// src/server/extension-host/channel-dispatcher.ts
//
// Minimal generic channel handler dispatch substrate. It is intentionally protocol
// agnostic: terminal-like behavior is implemented by a pack handler, not here.

import { ChannelError, type ChannelAuditEvent, type ChannelContributionRef, type HostChannelFrame } from "./channel-types.js";
import { type ChannelModuleHost } from "./channel-module-host.js";
import type { ChannelHandlerHostSurface } from "./channel-pty-helper.js";

export interface ChannelHandlerContext {
	readonly sessionId: string;
	readonly packId: string;
	readonly contributionId: string;
	readonly channelId: string;
	readonly name: string;
	readonly protocol?: string;
	readonly init?: unknown;
	readonly host: ChannelHandlerHostSurface;
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

export interface ChannelDispatcherOptions {
	moduleHost?: ChannelModuleHost;
}

/**
 * Dispatches channel opens to registered generic factories or the pack-declared
 * module handler. If neither path can load a handler, opening fails closed.
 */
export class ChannelDispatcher {
	private readonly byContributionId = new Map<string, ChannelHandlerFactory>();
	private readonly byProtocol = new Map<string, ChannelHandlerFactory>();
	private readonly byName = new Map<string, ChannelHandlerFactory>();
	private readonly moduleHost?: ChannelModuleHost;

	constructor(opts: ChannelDispatcherOptions = {}) {
		this.moduleHost = opts.moduleHost;
	}

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
		if (factory) return (await factory(req.ctx)) ?? {};
		if (this.moduleHost) return await this.moduleHost.open({ ...req, dispatcher: this, channelId: req.ctx.channelId });
		throw new ChannelError(500, "channel_handler_unavailable", "no channel handler is registered or declared");
	}

	invalidate(): void {
		this.byContributionId.clear();
		this.byProtocol.clear();
		this.byName.clear();
		this.moduleHost?.invalidate?.();
	}
}
