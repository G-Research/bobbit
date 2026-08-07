import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RpcBridge } from "../../src/server/agent/rpc-bridge.ts";
import {
	assertTrustedToolResultFilterExtensionArgs,
	TOOL_RESULT_FILTER_CORE_EXTENSION_STATE_DIRS,
	TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_CODE,
	TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_MESSAGE,
} from "../../src/server/agent/tool-result-filter-extension-trust.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; builtinRoot: string; stateDir: string; configRoot: string; outsideRoot: string } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-extension-trust-"));
	tempDirs.push(root);
	const builtinRoot = path.join(root, "builtin-tools");
	const stateDir = path.join(root, "state");
	const configRoot = path.join(root, "config-tools");
	const outsideRoot = path.join(root, "outside");
	for (const dir of [builtinRoot, stateDir, configRoot, outsideRoot]) fs.mkdirSync(dir, { recursive: true });
	return { root, builtinRoot, stateDir, configRoot, outsideRoot };
}

function writeExtension(dir: string, name = "extension.ts"): string {
	const file = path.join(dir, name);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "export default function extension() {}\n");
	return file;
}

function protectedBridge(args: string[], builtinRoot: string, onSpawn: () => void): RpcBridge {
	const child = new EventEmitter() as any;
	child.stdin = Object.assign(new EventEmitter(), { write: () => true });
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = () => true;
	return new RpcBridge({
		cliPath: "/fixture/pi.js",
		args: ["--no-extensions", ...args],
		env: { BOBBIT_TOOL_RESULT_FILTER_GATE: "/fixture/gate.ts" },
		toolManager: { getBuiltinToolsDir: () => builtinRoot } as any,
	}, {
		spawnDirect: (() => {
			onSpawn();
			return child;
		}) as any,
	});
}

function expectTrustFailure(run: () => unknown): void {
	try {
		run();
		expect.unreachable("expected protected extension trust failure");
	} catch (error) {
		expect(error).toMatchObject({
			code: TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_CODE,
			message: TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_MESSAGE,
		});
	}
}

describe("protected RpcBridge extension trust boundary", () => {
	it("delivers a filter key once through private stdin, never the environment", async () => {
		const secret = "b".repeat(64);
		const options: any = {
			env: { BOBBIT_TOOL_RESULT_FILTER_GATE: "/fixture/gate.ts" },
			toolResultFilterBootstrap: { runtimeGeneration: 9, runtimeKey: secret },
		};
		const bridge: any = new RpcBridge(options);
		const writes: string[] = [];
		bridge.process = { stdin: { write: (line: string, callback: (error?: Error) => void) => { writes.push(line); callback(); } } };

		await bridge._writeToolResultFilterBootstrap();
		expect(options.toolResultFilterBootstrap).toBeUndefined();
		expect(options.env).not.toHaveProperty("BOBBIT_TOOL_RESULT_FILTER_BOOTSTRAP");
		expect(writes).toEqual([JSON.stringify({ runtimeGeneration: 9, runtimeKey: secret }) + "\n"]);
		expect(bridge.toolResultFilterBootstrap).toBeUndefined();
		await expect(bridge._writeToolResultFilterBootstrap()).rejects.toThrow("bootstrap is unavailable");
	});

	it("allows only shipped and closed-list core-generated extension paths", () => {
		const { builtinRoot, stateDir } = fixture();
		const builtin = writeExtension(path.join(builtinRoot, "shell"));
		const generated = TOOL_RESULT_FILTER_CORE_EXTENSION_STATE_DIRS.map((sub) =>
			writeExtension(path.join(stateDir, sub, "hash"), `${sub}.ts`),
		);

		const trusted = assertTrustedToolResultFilterExtensionArgs(
			["--extension", builtin, ...generated.flatMap(file => ["--extension", file]), "--extension=" + builtin],
			{ builtinToolsDir: builtinRoot, stateDir },
		);

		expect(trusted.filter((arg, index) => arg === "--extension" ? trusted[index + 1] : arg.startsWith("--extension=")).length)
			.toBe(generated.length + 2);
	});

	it("rejects config shell/tasks/proposals and arbitrary incoming extensions before spawn", async () => {
		const { builtinRoot, configRoot, outsideRoot } = fixture();
		const candidates = [
			writeExtension(path.join(configRoot, "shell")),
			writeExtension(path.join(configRoot, "tasks")),
			writeExtension(path.join(configRoot, "proposals")),
			writeExtension(outsideRoot, "incoming.ts"),
		];
		let spawns = 0;
		for (const candidate of candidates) {
			const bridge = protectedBridge(["--extension", candidate], builtinRoot, () => { spawns++; });
			await expect(bridge.start()).rejects.toMatchObject({
				code: TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_CODE,
				message: TOOL_RESULT_FILTER_UNTRUSTED_EXTENSION_CONFLICT_MESSAGE,
			});
		}
		expect(spawns).toBe(0);
	});

	it("rejects a symlink that escapes a shipped root", () => {
		const { builtinRoot, outsideRoot, stateDir } = fixture();
		const outside = writeExtension(outsideRoot);
		const link = path.join(builtinRoot, "escaped.ts");
		fs.symlinkSync(outside, link);

		expectTrustFailure(() => assertTrustedToolResultFilterExtensionArgs(
			["--extension", link],
			{ builtinToolsDir: builtinRoot, stateDir },
		));
	});

	it("preserves ordinary extension inputs when the filter gate is inactive", async () => {
		const { builtinRoot, outsideRoot } = fixture();
		const arbitrary = writeExtension(outsideRoot);
		let spawns = 0;
		const child = new EventEmitter() as any;
		child.stdin = Object.assign(new EventEmitter(), { write: () => true });
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => true;
		const bridge = new RpcBridge({
			cliPath: "/fixture/pi.js",
			args: ["--no-extensions", "--extension", arbitrary],
			toolManager: { getBuiltinToolsDir: () => builtinRoot } as any,
		}, { spawnDirect: (() => { spawns++; return child; }) as any });

		await bridge.start();
		expect(spawns).toBe(1);
	});
});
