import { describe, it } from "node:test";
import assert from "node:assert/strict";

const runtime = await import("../src/server/agent/session-runtime.ts");

describe("session runtime selection", () => {
	it("defaults legacy sessions to pi", () => {
		assert.equal(runtime.resolveSessionRuntime({}), "pi");
		assert.equal(runtime.resolveSessionRuntime({ modelProvider: "anthropic" }), "pi");
	});

	it("selects Claude Code from provider/model strings", () => {
		assert.equal(runtime.runtimeFromModelString("claude-code/local-claude-sonnet-4-6"), "claude-code");
		assert.equal(runtime.resolveSessionRuntime({ initialModel: "claude-code/local-claude-opus-4-8" }), "claude-code");
		assert.equal(runtime.modelAliasFromModelString("claude-code/local-claude-opus-4-8"), "local-claude-opus-4-8");
	});

	it("rejects silent pi to Claude Code live switches", () => {
		assert.throws(
			() => runtime.assertRuntimeSwitchAllowed("pi", "claude-code"),
			(err: any) => err?.code === "RUNTIME_SWITCH_REQUIRES_NEW_SESSION",
		);
		assert.doesNotThrow(() => runtime.assertRuntimeSwitchAllowed("claude-code", "claude-code"));
		assert.doesNotThrow(() => runtime.assertRuntimeSwitchAllowed(undefined, "anthropic"));
	});

	it("rejects Claude Code in sandboxed sessions", () => {
		assert.throws(
			() => runtime.assertRuntimeAllowedForSession("claude-code", true),
			/host-only/i,
		);
		assert.doesNotThrow(() => runtime.assertRuntimeAllowedForSession("claude-code", false));
	});

	it("hydrates Claude Code bridge metadata defaults", () => {
		const options = runtime.hydrateRuntimeOptions({ cwd: "/tmp/x", initialModel: "claude-code/local-claude-sonnet-4-6" });
		assert.equal(options.runtime, "claude-code");
		assert.equal(options.claudeCodeExecutable, "claude");
		assert.equal(options.claudeCodePermissionMode, "acceptEdits");
		assert.equal(options.claudeCodeModelAlias, "local-claude-sonnet-4-6");
	});

	it("does not derive Claude Code aliases from API-backed model strings", () => {
		const options = runtime.hydrateRuntimeOptions(
			{ cwd: "/tmp/x", runtime: "claude-code", initialModel: "anthropic/claude-opus-4-1" },
			{ executablePath: "claude", defaultModel: "local-claude-sonnet-4-6", permissionMode: "default", allowBypassPermissions: false },
		);
		assert.equal(options.runtime, "claude-code");
		assert.equal(options.claudeCodeModelAlias, "local-claude-sonnet-4-6");
	});
});
