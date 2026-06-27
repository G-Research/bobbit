// src/server/extension-host/channel-module-host.ts
//
// Module-backed channel handler seam. The registry/dispatcher stay transport-only:
// this file owns resolving a pack-declared channels/<name>.yaml module/handler into
// a ChannelHandlerSession and failing closed when the declaration cannot be loaded.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ChannelDispatcher, ChannelHandlerContext, ChannelHandlerSession } from "./channel-dispatcher.js";
import { ChannelError, type ChannelContributionRef } from "./channel-types.js";
import { isPackPathWithinRoot } from "./path-guard.js";

export interface ChannelModuleHostOpenRequest {
	contribution: ChannelContributionRef;
	dispatcher: ChannelDispatcher;
	channelId: string;
	ctx: ChannelHandlerContext;
}

export interface ChannelModuleHost {
	open(req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession>;
	invalidate?(): void;
	dispose?(): void;
}

export class LocalChannelModuleHost implements ChannelModuleHost {
	private readonly cache = new Map<string, { mtimeMs: number; url: string }>();
	private epoch = 0;

	async open(req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession> {
		const resolved = this.resolveModule(req.contribution);
		const mod = await import(resolved.url) as Record<string, unknown>;
		const handler = resolveHandler(mod, req.contribution.handler ?? req.contribution.name);
		const result = await handler(req.ctx);
		return normalizeHandlerSession(result);
	}

	invalidate(): void {
		this.cache.clear();
		this.epoch++;
	}

	dispose(): void {
		this.cache.clear();
	}

	private resolveModule(contribution: ChannelContributionRef): { url: string; packRoot: string } {
		const modulePath = contribution.modulePath;
		const packRoot = contribution.packRoot;
		if (!modulePath || !contribution.handler) {
			throw new ChannelError(500, "channel_handler_unavailable", "channel declaration is missing module or handler");
		}
		if (!packRoot) {
			throw new ChannelError(500, "channel_handler_unavailable", "channel declaration is missing pack root");
		}
		const base = contribution.sourceFile ? path.dirname(contribution.sourceFile) : packRoot;
		const abs = path.resolve(base, modulePath);
		if (!isPackPathWithinRoot(packRoot, abs)) {
			throw new ChannelError(400, "invalid_channel_handler", "channel handler module resolves outside the pack root");
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			throw new ChannelError(404, "channel_handler_not_found", "channel handler module not found");
		}
		const key = `${abs}\u0000${this.epoch}`;
		const hit = this.cache.get(key);
		if (hit && hit.mtimeMs === stat.mtimeMs) return { url: hit.url, packRoot };
		const url = `${pathToFileURL(abs).href}?v=${stat.mtimeMs}&e=${this.epoch}`;
		this.cache.set(key, { mtimeMs: stat.mtimeMs, url });
		return { url, packRoot };
	}
}

export class NoopChannelModuleHost implements ChannelModuleHost {
	async open(_req: ChannelModuleHostOpenRequest): Promise<ChannelHandlerSession> {
		throw new ChannelError(500, "channel_handler_unavailable", "channel handler module host is not configured");
	}
}

export function isChannelModuleHost(value: unknown): value is ChannelModuleHost {
	return !!value && typeof (value as ChannelModuleHost).open === "function";
}

type ModuleChannelHandler = (ctx: ChannelHandlerContext) => Promise<ChannelHandlerSession | void> | ChannelHandlerSession | void;

function resolveHandler(mod: Record<string, unknown>, handlerName: string): ModuleChannelHandler {
	const defaultExport = isRecord(mod.default) ? mod.default : undefined;
	const channelMap = isRecord(mod.channels)
		? mod.channels
		: isRecord(defaultExport?.channels)
			? defaultExport.channels as Record<string, unknown>
			: undefined;
	const direct = Object.prototype.hasOwnProperty.call(mod, handlerName) ? mod[handlerName] : undefined;
	const defaultDirect = defaultExport && Object.prototype.hasOwnProperty.call(defaultExport, handlerName) ? defaultExport[handlerName] : undefined;
	const fromMap = channelMap && Object.prototype.hasOwnProperty.call(channelMap, handlerName) ? channelMap[handlerName] : undefined;
	const handler = fromMap ?? direct ?? defaultDirect;
	if (typeof handler !== "function") {
		throw new ChannelError(404, "channel_handler_not_found", `unknown channel handler "${handlerName}"`);
	}
	return handler as ModuleChannelHandler;
}

function normalizeHandlerSession(value: ChannelHandlerSession | void): ChannelHandlerSession {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) {
		throw new ChannelError(500, "invalid_channel_handler", "channel handler must return an object or undefined");
	}
	const session: ChannelHandlerSession = {};
	if (typeof value.onClientFrame === "function") session.onClientFrame = value.onClientFrame.bind(value) as ChannelHandlerSession["onClientFrame"];
	if (typeof value.onAttach === "function") session.onAttach = value.onAttach.bind(value) as ChannelHandlerSession["onAttach"];
	if (typeof value.onDetach === "function") session.onDetach = value.onDetach.bind(value) as ChannelHandlerSession["onDetach"];
	if (typeof value.close === "function") session.close = value.close.bind(value) as ChannelHandlerSession["close"];
	return session;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
