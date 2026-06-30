import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseToolsDir } from "../src/server/agent/builtin-config.ts";
import { computeToolActivationArgs, type EffectiveTool } from "../src/server/agent/tool-activation.ts";
import { ToolManager, __resetToolScanCache } from "../src/server/agent/tool-manager.ts";

const roots: string[] = [];

afterEach(() => {
	__resetToolScanCache();
	for (const root of roots.splice(0)) {
		try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
	}
});

function tempRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "tool-startup-resilience-"));
	roots.push(root);
	return root;
}

function writeFile(file: string, content: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

function writeTool(toolsDir: string, groupDir: string, fileName: string, opts: {
	name: string;
	description: string;
	provider?: string;
}): void {
	writeFile(path.join(toolsDir, groupDir, fileName), [
		`name: ${opts.name}`,
		`description: ${opts.description}`,
		"group: Agent",
		opts.provider ?? "provider:\n  type: bobbit-extension\n  extension: extension.ts",
		"",
	].join("\n"));
}

function extensionPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i] === "--extension") out.push(path.normalize(args[i + 1]));
	}
	return out;
}

function nonBuiltinExtensionPaths(args: string[]): string[] {
	return extensionPaths(args).filter((p) => !p.endsWith(path.join("_builtins", "extension.ts")));
}

function captureToolDiagnostics(fn: () => void): string {
	const messages: string[] = [];
	const originalWarn = console.warn;
	const originalError = console.error;
	console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
	console.error = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
	try {
		fn();
	} finally {
		console.warn = originalWarn;
		console.error = originalError;
	}
	return messages.join("\n");
}

function makeAgentFixture(): {
	configDir: string;
	builtinToolsDir: string;
	configToolsDir: string;
	builtinAgentExtension: string;
	configAgentExtension: string;
} {
	const root = tempRoot();
	const configDir = path.join(root, "project", ".bobbit", "config");
	const configToolsDir = path.join(configDir, "tools");
	const builtinToolsDir = path.join(root, "defaults", "tools");
	const builtinAgentExtension = path.join(builtinToolsDir, "agent", "extension.ts");
	const configAgentExtension = path.join(configToolsDir, "agent", "extension.ts");

	writeTool(builtinToolsDir, "agent", "session_prompt.yaml", {
		name: "session_prompt",
		description: "bundled session prompt",
	});
	writeFile(builtinAgentExtension, "export default function extension() { return {}; }\n");
	fs.mkdirSync(configToolsDir, { recursive: true });

	return { configDir, builtinToolsDir, configToolsDir, builtinAgentExtension, configAgentExtension };
}

describe("tool startup resilience", () => {
	it("rejects a broken active config agent override and falls back to bundled session_prompt", () => {
		const fixture = makeAgentFixture();
		writeTool(fixture.configToolsDir, "agent", "session_prompt.yaml", {
			name: "session_prompt",
			description: "broken config session prompt override",
		});
		writeFile(fixture.configAgentExtension, [
			"import './missing-local-gateway.js';",
			"export default function extension() { return {}; }",
			"",
		].join("\n"));

		__resetToolScanCache();
		const tm = new ToolManager(fixture.configDir, fixture.builtinToolsDir);

		assert.equal(
			tm.getToolByName("session_prompt")?.description,
			"bundled session prompt",
			"invalid config-level agent override must not shadow bundled session_prompt",
		);

		const provider = tm.getToolProviders().get("session_prompt");
		assert.ok(provider, "session_prompt must still have a provider via bundled fallback");
		assert.equal(path.resolve(provider.baseDir), path.resolve(fixture.builtinToolsDir));

		const result = computeToolActivationArgs([{ kind: "yaml", name: "session_prompt" }], tm);
		const activeExtensions = nonBuiltinExtensionPaths(result.args);
		assert.ok(
			activeExtensions.some((p) => path.resolve(p) === path.resolve(fixture.builtinAgentExtension)),
			`expected bundled agent extension activation, got ${JSON.stringify(activeExtensions)}`,
		);
		assert.ok(
			!activeExtensions.some((p) => path.resolve(p) === path.resolve(fixture.configAgentExtension)),
			"broken config agent extension must not become runtime activation",
		);
	});

	it("ignores dot-prefixed and disabled/archive config tool-group directories", () => {
		const archiveNames = [".agent", "agent.disabled", "agent.disabled-20260630", "agent.disabled_backup"];

		for (const archiveName of archiveNames) {
			const fixture = makeAgentFixture();
			writeTool(fixture.configToolsDir, archiveName, "session_prompt.yaml", {
				name: "session_prompt",
				description: `archived override from ${archiveName}`,
			});
			writeTool(fixture.configToolsDir, archiveName, "archived_only.yaml", {
				name: `archived_only_${archiveName.replace(/[^a-z0-9]/gi, "_")}`,
				description: `archived-only tool from ${archiveName}`,
			});
			writeFile(path.join(fixture.configToolsDir, archiveName, "extension.ts"), "export default function extension() { return {}; }\n");

			__resetToolScanCache();
			const tm = new ToolManager(fixture.configDir, fixture.builtinToolsDir);
			assert.equal(
				tm.getToolByName("session_prompt")?.description,
				"bundled session prompt",
				`archived group ${archiveName} must not override bundled tools`,
			);
			assert.ok(
				!tm.getAllToolNames().some((name) => name.startsWith("archived_only_")),
				`archived group ${archiveName} must not contribute custom tools`,
			);

			const apiNames = parseToolsDir(fixture.configToolsDir).map((tool) => tool.name);
			assert.deepEqual(apiNames, [], `parseToolsDir must ignore archived group ${archiveName} for /api/tools consistency`);
		}
	});

	it("omits and diagnoses a broken config-only extension instead of activating it", () => {
		const root = tempRoot();
		const configDir = path.join(root, "project", ".bobbit", "config");
		const configToolsDir = path.join(configDir, "tools");
		const builtinToolsDir = path.join(root, "defaults", "tools");
		const customExtension = path.join(configToolsDir, "custom", "extension.ts");

		writeTool(configToolsDir, "custom", "broken_custom.yaml", {
			name: "broken_custom",
			description: "broken config-only extension tool",
			provider: "provider:\n  type: bobbit-extension\n  extension: extension.ts",
		});
		writeFile(customExtension, [
			"import './missing-local-helper.js';",
			"export default function extension() { return {}; }",
			"",
		].join("\n"));

		__resetToolScanCache();
		const tm = new ToolManager(configDir, builtinToolsDir);
		let result: ReturnType<typeof computeToolActivationArgs> | undefined;
		const diagnostics = captureToolDiagnostics(() => {
			assert.equal(
				tm.getToolProviders().has("broken_custom"),
				false,
				"broken config-only extension must not expose a runtime provider",
			);
			const allowed: EffectiveTool[] = [{ kind: "yaml", name: "broken_custom" }];
			result = computeToolActivationArgs(allowed, tm);
		});

		assert.ok(result, "activation args should be computed without throwing");
		assert.ok(
			!nonBuiltinExtensionPaths(result!.args).some((p) => path.resolve(p) === path.resolve(customExtension)),
			"broken config-only extension must not become runtime activation",
		);
		assert.match(
			diagnostics,
			/broken_custom|missing-local-helper|custom[\\/]extension\.ts/i,
			"broken config-only extension must emit a clear diagnostic",
		);
	});
});
