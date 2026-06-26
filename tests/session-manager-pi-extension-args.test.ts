import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

import { SessionManager } from "../src/server/agent/session-manager.ts";
import { resolveMarketplacePiExtensionActivation, type ResolvedPiExtensionContribution } from "../src/server/agent/session-setup.ts";

function contribution(listName: string, entryPath: string | undefined, status: ResolvedPiExtensionContribution["diagnostic"]["status"] = "ok"): ResolvedPiExtensionContribution {
	return {
		listName,
		entryPath,
		entryRelativePath: entryPath ? path.basename(entryPath) : undefined,
		packRoot: entryPath ? path.dirname(entryPath) : process.cwd(),
		origin: { scope: "project", packName: "pi-pack", packId: "market:project:pi-pack" },
		diagnostic: { status, code: status, message: `${listName} ${status}`, updatedAt: "2026-01-01T00:00:00.000Z" },
		discovery: { status: "ok", tools: [{ name: `${listName}_tool`, description: `${listName} tool` }] },
	};
}

function extensionPaths(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--extension" && args[i + 1]) out.push(args[i + 1]);
	}
	return out;
}

describe("marketplace pi extension activation args", () => {
	it("emits enabled resolved entries and omits disabled/unresolved entries", () => {
		const a = path.join(os.tmpdir(), "pi-ext-a", "extension.ts");
		const b = path.join(os.tmpdir(), "pi-ext-b", "extension.ts");
		const result = resolveMarketplacePiExtensionActivation(
			() => [
				contribution("enabled", a),
				contribution("disabled", path.join(os.tmpdir(), "disabled.ts"), "disabled"),
				contribution("missing", undefined, "unresolved"),
				contribution("discovery_failed", b, "discovery-failed"),
			],
			"project-1",
			process.cwd(),
		);

		assert.deepEqual(extensionPaths(result.args), [a, b]);
		assert.deepEqual(result.tools.map((t) => t.name), ["enabled_tool", "discovery_failed_tool"]);
		assert.equal(result.diagnostics.length, 4);
	});

	it("threads marketplace pi extension args through SessionManager restore/respawn helper after Bobbit activation args", () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-pi-ext-session-"));
		try {
			const extPath = path.join(tmp, "market-packs", "pi-pack", "pi-extensions", "demo", "extension.ts");
			const manager: any = new SessionManager();
			manager.setMarketplacePiExtensionResolver((scope: { projectId?: string; cwd?: string }) => {
				assert.equal(scope.projectId, "project-1");
				assert.equal(scope.cwd, tmp);
				return [contribution("demo", extPath)];
			});

			const { args } = manager.buildToolActivationArgs("session-1", undefined, undefined, tmp, "project-1");
			const noExtensionsIndex = args.indexOf("--no-extensions");
			const piIndex = args.indexOf(extPath);
			const codeAssistIndex = args.findIndex((arg: string) => arg.includes("google-code-assist"));

			assert.ok(noExtensionsIndex >= 0, "Bobbit activation args should still be first");
			assert.ok(piIndex > noExtensionsIndex, "pi extension should be appended after Bobbit activation args");
			assert.ok(codeAssistIndex === -1 || piIndex < codeAssistIndex, "pi extension should be before generated guard/provider extensions");
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});
});
