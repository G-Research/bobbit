/**
 * Unit — pack channel declaration schema and contribution registry integration.
 *
 * Owns only test fixtures created under OS temp. These tests pin the dedicated
 * `contents.channels` / `channels/<name>.yaml` contribution path so streaming
 * semantics do not get hidden in routes or raw transport fields.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateManifest } from "../src/server/agent/pack-manifest.ts";
import { loadPackContributions, PackContributionError } from "../src/server/agent/pack-contributions.ts";
import { PackContributionRegistry } from "../src/server/extension-host/pack-contribution-registry.ts";
import type { PackEntry, PackManifest } from "../src/server/agent/pack-types.ts";

let tmp: string;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "extension-host-channel-schema-")); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function w(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function packRoot(scope: string, name: string): string {
	return path.join(tmp, scope, "market-packs", name);
}

function manifest(name: string, channels: string[]): PackManifest {
	return validateManifest({
		name,
		description: "channel fixture",
		version: "1.0.0",
		schema: 2,
		contents: {
			roles: [],
			tools: [],
			skills: [],
			entrypoints: [],
			channels,
		},
	})!;
}

function entry(root: string, scope: PackEntry["scope"], m: PackManifest): PackEntry {
	return { id: `market:${scope}:${m.name}`, kind: "market", scope, path: root, readOnly: true, manifest: m, layout: "defaults-tree" };
}

function writeChannelPack(root: string, opts: { channelFiles?: Record<string, string>; module?: boolean } = {}): void {
	w(path.join(root, "pack.yaml"), "name: channel-pack\n");
	if (opts.module !== false) w(path.join(root, "lib", "echo.mjs"), "export const channels = {};\n");
	for (const [name, body] of Object.entries(opts.channelFiles ?? {})) {
		w(path.join(root, "channels", `${name}.yaml`), body);
	}
}

const goodEchoYaml = `
name: echo
protocol: echo.v1
module: ../lib/echo.mjs
handler: echo
requiresUserGesture: true
maxChannelsPerSessionPerPack: 2
maxFrameBytes: 64
maxInboundBufferedFrames: 4
maxOutboundBufferedFrames: 4
maxAttachedClientBufferedFrames: 2
maxInboundBytesPerSecond: 1024
maxOutboundBytesPerSecond: 1024
idleTimeoutMs: 30000
openTimeoutMs: 5000
closeGraceMs: 1000
unknownDisplayName: Echo fixture
`;

describe("channel contribution schema", () => {
	it("accepts contents.channels and loads only listed dedicated channel declarations", () => {
		const root = packRoot("valid", "channel-pack");
		writeChannelPack(root, {
			channelFiles: {
				echo: goodEchoYaml,
				unlisted: "name: unlisted\nprotocol: unlisted.v1\nmodule: ../lib/echo.mjs\nhandler: echo\n",
			},
		});
		const m = manifest("channel-pack", ["echo"]);
		assert.deepEqual((m.contents as any).channels, ["echo"], "manifest must preserve channel activation basenames");

		const contrib = loadPackContributions(root, m) as any;
		assert.deepEqual(contrib.channels.map((c: any) => c.name), ["echo"]);
		assert.equal(contrib.channels[0].protocol, "echo.v1");
		assert.equal(contrib.channels[0].module, "../lib/echo.mjs");
		assert.equal(contrib.channels[0].handler, "echo");
		assert.equal(contrib.channels[0].requiresUserGesture, true);
		assert.equal(contrib.channels[0].quotas?.maxFrameBytes, 64);
		assert.equal(contrib.channels[0].unknownDisplayName, undefined, "unknown fields must not become executable canonical fields");
	});

	it("rejects unsafe channel basenames in pack.yaml", () => {
		for (const bad of ["../echo", "nested/echo", "nested\\echo", "", "C:\\echo", "/echo", "with\0null"]) {
			const problems: string[] = [];
			assert.equal(validateManifest({ name: "p", description: "d", version: "1", schema: 2, contents: { roles: [], tools: [], skills: [], channels: [bad] } }, problems), null, `expected ${JSON.stringify(bad)} to be rejected`);
			assert.match(problems.join("; "), /channels/i);
		}
	});

	it("rejects duplicate channel names within one pack", () => {
		const root = packRoot("dups", "channel-pack");
		writeChannelPack(root, {
			channelFiles: {
				echo: goodEchoYaml,
				alsoEcho: goodEchoYaml.replace("protocol: echo.v1", "protocol: echo.v2"),
			},
		});
		assert.throws(
			() => loadPackContributions(root, manifest("channel-pack", ["echo", "alsoEcho"])),
			(err: unknown) => err instanceof PackContributionError && /channel name "echo" more than once/i.test(err.message),
		);
	});

	it("rejects channel handler modules that escape the pack root", () => {
		const root = packRoot("escape", "channel-pack");
		writeChannelPack(root, {
			channelFiles: {
				escape: "name: escape\nprotocol: escape.v1\nmodule: ../../../../outside.mjs\nhandler: open\n",
			},
		});
		assert.throws(
			() => loadPackContributions(root, manifest("channel-pack", ["escape"])),
			/pack root|contain|escape|outside/i,
		);
	});

	it("treats raw transport fields as inert metadata, never as canonical channel authority", () => {
		const root = packRoot("raw-fields", "channel-pack");
		writeChannelPack(root, {
			channelFiles: {
				echo: `${goodEchoYaml}\nurl: https://attacker.invalid/ws\nwebSocket: ws://attacker.invalid\nheaders:\n  Authorization: Bearer secret\npackId: other-pack\n`,
			},
		});
		const channels = (loadPackContributions(root, manifest("channel-pack", ["echo"])) as any).channels;
		assert.ok(Array.isArray(channels), "loadPackContributions must expose canonical channels[]");
		const channel = channels[0];
		assert.equal(channel.url, undefined);
		assert.equal(channel.webSocket, undefined);
		assert.equal(channel.headers, undefined);
		assert.equal(channel.packId, undefined, "channel declarations must not carry caller-supplied pack identity");
	});

	it("registry resolves channels pack-locally and does not cross packs", () => {
		const rootA = packRoot("registry-a", "pack-a");
		const rootB = packRoot("registry-b", "pack-b");
		writeChannelPack(rootA, { channelFiles: { echo: goodEchoYaml } });
		writeChannelPack(rootB, { channelFiles: { echo: goodEchoYaml.replace("protocol: echo.v1", "protocol: other.v1") } });
		const reg = new PackContributionRegistry(() => [
			entry(rootA, "server", manifest("pack-a", ["echo"])),
			entry(rootB, "server", manifest("pack-b", ["echo"])),
		]) as any;
		assert.equal(typeof reg.getChannel, "function", "PackContributionRegistry must expose getChannel(projectId, packId, name)");

		assert.equal(reg.getChannel(undefined, "pack-a", "echo")?.protocol, "echo.v1");
		assert.equal(reg.getChannel(undefined, "pack-b", "echo")?.protocol, "other.v1");
		assert.equal(reg.getChannel(undefined, "pack-a", "missing"), undefined);
		assert.equal(reg.getChannel(undefined, "missing-pack", "echo"), undefined);
	});

	it("preserves declared sessionPty through registry resolution", () => {
		const root = packRoot("pty", "third-party");
		writeChannelPack(root, {
			channelFiles: {
				pty: `${goodEchoYaml.replace("name: echo", "name: pty")}\ncapabilities: [sessionPty]\n`,
			},
		});
		const m = manifest("third-party", ["pty"]);
		const channels = (loadPackContributions(root, m) as any).channels;
		assert.deepEqual(channels[0].capabilities, ["sessionPty"]);

		const reg = new PackContributionRegistry(() => [entry(root, "server", m)]) as any;
		assert.deepEqual(reg.getChannel(undefined, "third-party", "pty")?.capabilities, ["sessionPty"]);
	});
});
