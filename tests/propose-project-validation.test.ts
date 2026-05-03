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

// Prevent seedProposal() from issuing real fetch() calls to a Bobbit gateway
// when this test is run from inside a live Bobbit session (env-inherited).
// In-flight fetches at --test-force-exit time trigger a Windows libuv
// assertion (UV_HANDLE_CLOSING) that fails the file even though all
// sub-tests pass. Must be set BEFORE the extension module is imported.
delete process.env.BOBBIT_SESSION_ID;

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
