/**
 * Unit tests for the `propose_project` tool's `execute()` entry point.
 *
 * The extension `execute()` is a thin ack — the authoritative validation
 * of legacy top-level `qa_*` keys and per-component `config` maps lives
 * server-side at the REST PUT boundary (see
 * `tests/e2e/project-config-component-config.spec.ts` and
 * `tests/e2e/project-config-native-yaml.spec.ts`). These tests pin the
 * pi-coding-agent calling convention `(toolCallId, params, …)` so the
 * tool doesn't crash regardless of payload shape.
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
	// — the FIRST positional arg is the tool_use_id STRING. The previous
	// implementation treated it as the params object and did `if (k in args)`,
	// which threw `TypeError: Cannot use 'in' operator to search for
	// 'qa_start_command' in tooluse_<id>` on every propose_project call.
	// Validation now lives server-side at the REST PUT boundary; the
	// extension's `execute()` is a thin ack that ignores its arguments.
	it("does not crash when invoked with the (toolCallId, params) calling convention", async () => {
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

	it("does not crash on the bare-minimum payload", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({ name: "agent-memory", root_path: "/tmp/agent-memory" });
		assert.ok(result);
	});

	it("does not crash on a full proposal with components + config", async () => {
		const tool = getProposeProject();
		const result = await tool.execute({
			name: "p",
			root_path: "/tmp/p",
			components: [{
				name: "web",
				repo: ".",
				commands: { build: "npm run build" },
				config: { qa_start_command: "PORT=$PORT npm start" },
			}],
		});
		assert.ok(result);
	});
});
