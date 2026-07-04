/**
 * Unit — generic Extension Host channel public contract.
 *
 * These tests pin the additive host.channels surface before/alongside the core
 * implementation merge. They intentionally fail on the pre-channel baseline with
 * clear messages so the production slices know which contract points are still
 * missing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { HOST_API_VERSION, HOST_CONTRACT_VERSION } from "../src/shared/extension-host/host-api.ts";
import { createServerHostApi } from "../src/server/extension-host/server-host-api.ts";

const hostApiSource = () => fs.readFileSync(path.join(process.cwd(), "src", "shared", "extension-host", "host-api.ts"), "utf-8");

describe("host.channels — public Host API contract", () => {
	it("keeps the Host API version stable and bumps only the owned contract version", () => {
		assert.equal(HOST_API_VERSION, 1, "host.channels is additive; HOST_API_VERSION must remain v1");
		assert.equal(HOST_CONTRACT_VERSION, 4, "host.channels adds owned frame/channel contracts; HOST_CONTRACT_VERSION must be 4");
	});

	it("declares a generic text/json channel API with no terminal-specific core method", () => {
		const src = hostApiSource();
		assert.match(src, /export\s+type\s+HostChannelFrame/, "HostChannelFrame must be public");
		assert.match(src, /kind:\s*["']text["'][\s\S]*data:\s*string/, "text frames must be declared");
		assert.match(src, /kind:\s*["']json["'][\s\S]*data:\s*unknown/, "json frames must be declared");
		assert.match(src, /interface\s+HostChannelsApi[\s\S]*open\(name:\s*string/, "HostChannelsApi.open(name, init) must be public");
		assert.match(src, /attach\(id:\s*string/, "HostChannelsApi.attach(id) must be public");
		assert.match(src, /list\(opts\?:\s*\{\s*name\?:\s*string;\s*includeClosed\?:\s*boolean\s*\}/, "HostChannelsApi.list(opts) must be public");
		assert.doesNotMatch(src, /host\.terminal|readonly\s+terminal\b|HostTerminal/i, "terminal must be a pack protocol, not a core Host API");
		assert.doesNotMatch(src, /kind:\s*["'](?:bytes|binary)["']|ArrayBuffer|Uint8Array/, "v1 channels must not expose binary/bytes frames");
	});

	it("client host advertises channels through capabilities and exposes only the HostChannel abstraction", () => {
		const src = fs.readFileSync(path.join(process.cwd(), "src", "app", "host-api.ts"), "utf-8");
		assert.match(src, /channels:\s*true/, "client capability flags must include channels: true");
		assert.match(src, /has:\s*\(name:\s*string\).*channels|\(flags as Record<string, boolean>\)\[name\]/s, "capabilities.has(name) must reflect the flags map, including channels");
		assert.match(src, /channels:\s*createHostChannelsApi/, "client host must expose host.channels through the private channel bridge");
		const bridgeSrc = fs.readFileSync(path.join(process.cwd(), "src", "app", "channel-bridge.ts"), "utf-8");
		assert.match(bridgeSrc, /return\s*\{[\s\S]*open\(name, init\)[\s\S]*attach\(id\)[\s\S]*list\(optsList\)/, "channel bridge must expose open/attach/list only through HostChannel abstraction");
		assert.doesNotMatch(src, /terminal:\s*\{|host\.terminal/i, "no host.terminal shortcut");
		assert.doesNotMatch(src, /gateway:\s*\{|return\s+.*gateway/i, "no raw gateway passthrough on the host object");
	});

	it("WebSocket protocol requires openGrant on raw ext_channel_open frames", () => {
		const src = fs.readFileSync(path.join(process.cwd(), "src", "server", "ws", "protocol.ts"), "utf-8");
		assert.match(src, /type:\s*["']ext_channel_open["'][\s\S]*openGrant:\s*string/, "ext_channel_open must require openGrant on the wire type");
		assert.match(src, /ext_channel_result[\s\S]*message\?:\s*string[\s\S]*status\?:\s*number/, "channel operation failures must carry correlated message/status details");
		assert.doesNotMatch(src, /trustedLauncher|userGesture|requiresUserGesture:\s*boolean/, "raw WS frames must not trust client launcher/gesture booleans");
	});

	it("server production wiring installs channel audit and worker module-host sinks", () => {
		const src = fs.readFileSync(path.join(process.cwd(), "src", "server", "server.ts"), "utf-8");
		assert.match(src, /extensionChannelAuditSink/, "server must wire a production channel audit sink");
		assert.match(src, /WorkerChannelModuleHost/, "server must prefer the worker-backed channel module host");
		assert.match(src, /new OpenPermitsCtor\(\{ audit: extensionChannelAuditSink \}\)/, "open permits must emit audit events in production wiring");
	});

	it("WebSocket channel operations settle requestIds and buffer synchronous open events", () => {
		const src = fs.readFileSync(path.join(process.cwd(), "src", "server", "ws", "handler.ts"), "utf-8");
		assert.match(src, /sendExtChannelFailure\(requestId, err\)/, "thrown channel operation failures must return ext_channel_result for the original requestId");
		assert.match(src, /pendingChannelEvents/, "open must buffer handler frames until the channel id is known");
		assert.match(src, /if \(!openedChannelId\) pendingChannelEvents\.push/, "synchronous open events must be queued before the channel id is known");
	});

	it("older/no-channel hosts remain safely feature-detectable", () => {
		const older = {
			capabilities: {
				invokeAction: true,
				requestRender: true,
				callRoute: true,
				session: true,
				ui: true,
				store: true,
				has: (name: string) => name !== "channels" && name !== "not-real",
			},
		} as any;
		assert.equal(older.capabilities.channels, undefined);
		assert.equal(older.capabilities.has("channels"), false);
		assert.equal(older.channels, undefined, "packs must gate host.channels usage on capabilities.channels");
	});

	it("server action/provider hosts still do not expose PTY, terminal, gateway, or raw channel transports", () => {
		const host = createServerHostApi({ sessionId: "s", packId: "generic", contributionId: "actions/run" }) as any;
		assert.equal(host.gateway, undefined);
		assert.equal(host.terminal, undefined);
		assert.equal(host.pty, undefined, "generic server hosts must not receive the privileged PTY helper");
		assert.equal(host.webSocket, undefined);
		assert.equal(host.socket, undefined);
		assert.equal(host.capabilities.has("pty"), false);
		assert.equal(host.capabilities.has("terminal"), false);
	});
});
