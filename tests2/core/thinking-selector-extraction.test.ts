import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");
const packDir = path.join(root, "market-packs", "thinking-selector");

describe("first-party thinking selector extraction", () => {
	it("ships a pure, default-disabled decide hook that reproduces only the former medium proposal", async () => {
		const pack = read("market-packs", "thinking-selector", "pack.yaml");
		const hook = read("market-packs", "thinking-selector", "hooks", "default-thinking.yaml");
		const source = read("market-packs", "thinking-selector", "lib", "default-thinking-selector.mjs");

		assert.match(pack, /^schema:\s*2\s*$/m);
		assert.match(pack, /^name:\s*thinking-selector\s*$/m);
		assert.match(pack, /^defaultDisabled:\s*true\s*$/m);
		assert.match(pack, /^\s*hooks:\s*\[default-thinking\]\s*$/m);
		assert.match(hook, /^id:\s*default-thinking\s*$/m);
		assert.match(hook, /^events:\s*\[sessionSetup, afterTurn\]\s*$/m);
		assert.match(hook, /^mode:\s*decide\s*$/m);
		assert.match(hook, /^capabilities:\s*\[\]\s*$/m);
		assert.doesNotMatch(source, /\b(?:import|require|Date|Math\.random|process|host)\b/);

		const { activeBuiltinFirstPartyPackEntries, builtinFirstPartyPackEntries } = await import("../../src/server/agent/builtin-packs.ts");
		const all = builtinFirstPartyPackEntries(path.join(root, "market-packs")).map(entry => entry.manifest?.name);
		const defaultActive = activeBuiltinFirstPartyPackEntries(path.join(root, "market-packs"), () => undefined).map(entry => entry.manifest?.name);
		const enabled = activeBuiltinFirstPartyPackEntries(path.join(root, "market-packs"), name => name === "thinking-selector" ? { enabled: true } : undefined).map(entry => entry.manifest?.name);
		assert.ok(all.includes("thinking-selector"), "the Market catalogue must include the shipped selector");
		assert.ok(!defaultActive.includes("thinking-selector"), "default-disabled selector must be absent from active contributions");
		assert.ok(enabled.includes("thinking-selector"), "activation may enable the selector but does not grant it");

		const selector = await import(`${pathToFileURL(path.join(packDir, "lib", "default-thinking-selector.mjs")).href}?test=${Date.now()}`);
		assert.deepEqual(selector.default.decide(), {
			kind: "selection",
			selection: { kind: "thinking", thinkingLevel: "medium" },
		});
	});

	it("ships the selector through the ordinary built-in allowlist without a server exception", () => {
		const copyBuiltinPacks = read("scripts", "copy-builtin-packs.mjs");
		const server = read("src", "server", "server.ts");
		assert.match(copyBuiltinPacks, /["']thinking-selector["']/);
		assert.doesNotMatch(server, /thinking-selector/);
	});

	it("removes the core medium fallback and post-spawn selector pipeline", () => {
		const manager = read("src", "server", "agent", "session-manager.ts");
		const setup = read("src", "server", "agent", "session-setup.ts");

		assert.doesNotMatch(manager, /\?\?\s*["']medium["']/);
		assert.doesNotMatch(manager, /tryApplyDefaultThinkingLevel\s*\(/);
		assert.doesNotMatch(setup, /tryApplyDefaultThinkingLevel\s*\(/);
	});
});
