import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import {
	discoverPiExtensionTools,
	PI_EXTENSION_DISCOVERY_RESULT_MARKER,
	type PiExtensionDiscoveryBackend,
} from "../../src/server/agent/pi-extension-discovery.js";
import {
	loadPiExtensionContributions,
	PI_EXTENSION_PROBE_HARNESS_VERSION,
} from "../../src/server/agent/pi-extension-contributions.js";

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function extensionEntry(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-harness-version-"));
	tempRoots.push(root);
	const entry = path.join(root, "extension.mjs");
	fs.writeFileSync(entry, "export default function () {}\n", "utf8");
	return entry;
}

function successfulBackend(): PiExtensionDiscoveryBackend {
	const result = {
		stdout: `${PI_EXTENSION_DISCOVERY_RESULT_MARKER}${JSON.stringify({ status: "ok", tools: [] })}\n`,
		stderr: "",
		exitCode: 0,
		timedOut: false,
	};
	return { run: async () => result, runSync: () => result };
}

describe("pi extension discovery harness version", () => {
	it("reports the active harness version for skipped, completed, and failed probes", async () => {
		const entry = extensionEntry();
		const skipped = await discoverPiExtensionTools(entry, { trustAccepted: false });
		const completed = await discoverPiExtensionTools(entry, { trustAccepted: true, backend: successfulBackend() });
		const failed = await discoverPiExtensionTools(entry, {
			trustAccepted: true,
			backend: { run: async () => ({ stdout: "invalid", stderr: "", exitCode: 1, timedOut: false }), runSync: () => ({ stdout: "invalid", stderr: "", exitCode: 1, timedOut: false }) },
		});

		assert.equal(skipped.harnessVersion, PI_EXTENSION_PROBE_HARNESS_VERSION);
		assert.equal(completed.harnessVersion, PI_EXTENSION_PROBE_HARNESS_VERSION);
		assert.equal(failed.harnessVersion, PI_EXTENSION_PROBE_HARNESS_VERSION);
	});

	it("reports the active harness version on static contribution diagnostics", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-harness-version-pack-"));
		tempRoots.push(root);
		fs.mkdirSync(path.join(root, "pi-extensions", "demo"), { recursive: true });
		fs.writeFileSync(path.join(root, "pi-extensions", "demo", "extension.js"), "export default function () {}\n", "utf8");

		const [contribution] = loadPiExtensionContributions(root, {
			schema: 2,
			name: "harness-version-pack",
			contents: { piExtensions: ["demo"] },
		} as any);

		assert.equal(contribution.discovery.harnessVersion, PI_EXTENSION_PROBE_HARNESS_VERSION);
	});
});
