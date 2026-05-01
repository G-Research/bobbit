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
