/**
 * Unit tests for the `propose_project` tool's runtime validation.
 *
 * The tool's `execute()` is the last line of defence before the agent's
 * payload reaches the proposal panel:
 *   - Top-level `qa_*` keys are rejected with the migration message
 *     pointing at `components[<name>].config[<key>]`.
 *   - Per-component `config` maps are validated: max 100 entries,
 *     non-empty keys, string values.
 *   - Valid payloads round-trip through `execute()` to the ack response.
 *
 * The TypeBox schema itself doesn't enforce `maxProperties` at runtime
 * (it's just an annotation under pi-coding-agent), so this runtime
 * validator is the actual contract.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import extensionFactory from "../defaults/tools/proposals/extension.ts";

type ToolReg = {
	name: string;
	execute: (...args: any[]) => Promise<any>;
};

const registered: ToolReg[] = [];
const pi = { registerTool: (t: ToolReg) => { registered.push(t); } } as any;

function getProposeProject(): ToolReg {
	const tool = registered.find((t) => t.name === "propose_project");
	assert.ok(tool, "propose_project tool should be registered");
	return tool!;
}

before(() => {
	extensionFactory(pi);
});

describe("propose_project — top-level qa_* rejection", () => {
	const REJECTED = [
		"qa_start_command",
		"qa_build_command",
		"qa_health_check",
		"qa_browser_entry",
		"qa_env",
		"qa_max_duration_minutes",
		"qa_max_scenarios",
	] as const;

	for (const key of REJECTED) {
		it(`rejects top-level ${key}`, async () => {
			const tool = getProposeProject();
			const args: Record<string, unknown> = {
				name: "p",
				root_path: "/tmp/p",
				[key]: key === "qa_env" ? { FOO: "bar" } : key.startsWith("qa_max") ? 10 : "x",
			};
			await assert.rejects(
				() => tool.execute(args),
				(err: Error) => {
					assert.match(err.message, new RegExp(key));
					assert.match(err.message, /components\[\]\.config\[\]/);
					return true;
				},
				`should reject top-level ${key}`,
			);
		});
	}
});

describe("propose_project — components[].config validation", () => {
	it("accepts a valid components[].config map", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({
			name: "p",
			root_path: "/tmp/p",
			components: [{
				name: "web",
				repo: ".",
				commands: { build: "npm run build" },
				config: {
					qa_start_command: "PORT=$PORT npm start",
					qa_health_check: "http://127.0.0.1:$PORT/health",
					qa_max_duration_minutes: "10",
					qa_max_scenarios: "5",
				},
			}],
		});
		// ack() returns a content array.
		assert.ok(result);
	});

	it("accepts a component with no config", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({
			name: "p",
			root_path: "/tmp/p",
			components: [{ name: "web", repo: "." }],
		});
		assert.ok(result);
	});

	it("rejects > 100 entries in components[].config", async () => {
		const tool = getProposeProject();
		const tooBig: Record<string, string> = {};
		for (let i = 0; i < 101; i++) tooBig[`k${i}`] = "v";
		await assert.rejects(
			() => tool.execute({
				name: "p",
				root_path: "/tmp/p",
				components: [{ name: "web", repo: ".", config: tooBig }],
			}),
			/too many entries/,
		);
	});

	it("accepts exactly 100 entries", async () => {
		const tool = getProposeProject();
		const exact: Record<string, string> = {};
		for (let i = 0; i < 100; i++) exact[`k${i}`] = "v";
		const result = await tool.execute({
			name: "p",
			root_path: "/tmp/p",
			components: [{ name: "web", repo: ".", config: exact }],
		});
		assert.ok(result);
	});

	it("rejects empty key in components[].config", async () => {
		const tool = getProposeProject();
		await assert.rejects(
			() => tool.execute({
				name: "p",
				root_path: "/tmp/p",
				components: [{ name: "web", repo: ".", config: { "": "value" } }],
			}),
			/empty key/,
		);
	});

	it("rejects non-string values in components[].config", async () => {
		const tool = getProposeProject();
		await assert.rejects(
			() => tool.execute({
				name: "p",
				root_path: "/tmp/p",
				components: [{ name: "web", repo: ".", config: { qa_max_scenarios: 5 as any } }],
			}),
			/must be string/,
		);
	});

	it("rejects boolean values in components[].config", async () => {
		const tool = getProposeProject();
		await assert.rejects(
			() => tool.execute({
				name: "p",
				root_path: "/tmp/p",
				components: [{ name: "web", repo: ".", config: { flag: true as any } }],
			}),
			/must be string/,
		);
	});

	it("ignores components without a config map (data-only)", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({
			name: "p",
			root_path: "/tmp/p",
			components: [
				{ name: "shared", repo: "shared" },
				{ name: "web", repo: "web", commands: { build: "npm run build" } },
			],
		});
		assert.ok(result);
	});

	it("validates each component independently", async () => {
		const tool = getProposeProject();
		await assert.rejects(
			() => tool.execute({
				name: "p",
				root_path: "/tmp/p",
				components: [
					{ name: "ok", repo: ".", config: { x: "y" } },
					{ name: "bad", repo: "bad", config: { "": "v" } },
				],
			}),
			/components\[bad\]\.config: empty key/,
		);
	});
});

describe("propose_project — happy path with no qa_ keys", () => {
	it("accepts a minimal proposal", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({ name: "p", root_path: "/tmp/p" });
		assert.ok(result);
	});
});

describe("propose_project — pi-coding-agent calling convention", () => {
	// pi-coding-agent invokes ToolDefinition.execute as
	//   (toolCallId, params, signal, onUpdate, ctx)
	// — the FIRST positional arg is the tool_use_id STRING. The current
	// extension treats it as the params object and does `if (k in args)`,
	// which throws `TypeError: Cannot use 'in' operator to search for
	// 'qa_start_command' in tooluse_<id>`.
	it("does not crash when invoked with the real pi-coding-agent calling convention", async () => {
		const tool = getProposeProject();
		const result = await tool.execute("tooluse_abc123", { name: "p", root_path: "/tmp/p" });
		assert.ok(result);
	});

	it("does not crash when params contain a legacy qa_* key under the two-arg convention", async () => {
		const tool = getProposeProject();
		const result = await tool.execute("tooluse_abc123", {
			name: "p",
			root_path: "/tmp/p",
			qa_start_command: "x",
		});
		assert.ok(result);
	});
});
