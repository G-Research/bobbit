// src/server/extension-host/channel-module-host.ts
//
// Placeholder seam for future pack module-backed channel handlers. Keeping this
// separate from the registry preserves the no-raw-transport registry surface and
// gives integration code a typed place to connect confined module execution.

import type { ChannelDispatcher, ChannelHandlerSession } from "./channel-dispatcher.js";
import type { ChannelContributionRef } from "./channel-types.js";

export interface ChannelModuleHostOpenRequest {
	contribution: ChannelContributionRef;
	dispatcher: ChannelDispatcher;
	channelId: string;
}

export interface ChannelModuleHost {
	open(req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession>;
	invalidate?(): void;
	dispose?(): void;
}

export class NoopChannelModuleHost implements ChannelModuleHost {
	async open(_req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession> {
		return {};
	}
}
