/**
 * CC-841 reconcile: RemoteAgent (`src/app/remote-agent.ts`) never learned the
 * session's Claude Code runtime metadata from live `state` frames, and never
 * rolled back an optimistically-set model after the server rejected
 * `set_model` (unavailable model, or a Pi <-> Claude Code runtime-boundary
 * crossing rejected by `assertRuntimeSwitchAllowed()` server-side).
 *
 * Effect before this fix:
 *   - `AgentInterface._currentRuntime()`'s fallback to
 *     `(this.session?.state as any)?.runtime` was always `undefined` from
 *     this path — only the separately-threaded `sessionRuntime` property
 *     (set once at session-list/detail hydration) ever carried it.
 *   - A rejected `set_model` left the footer showing the model the user
 *     picked even though the agent never actually switched to it, because
 *     `setModel()` sets `_state.model` optimistically and the `"error"`
 *     handler never reversed that.
 *
 * This is a source-level pin (see `tests/snapshot-clears-streaming-message.test.ts`
 * for the established pattern in this codebase): RemoteAgent requires a live
 * WebSocket + DOM harness to instantiate fully, so rather than build one,
 * this scans the relevant handlers in remote-agent.ts and asserts the fix
 * is present and wired correctly, without relaxing on wording drift.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const SRC = path.resolve("src/app/remote-agent.ts");

function windowFrom(text: string, startMarker: string, maxLen = 2500): string {
	const idx = text.indexOf(startMarker);
	assert.notEqual(idx, -1, `expected to find marker: ${startMarker}`);
	return text.slice(idx, idx + maxLen);
}

test("setModel() stashes the prior model into _pendingModelRollback before optimistically switching", () => {
	const text = fs.readFileSync(SRC, "utf8");
	const win = windowFrom(text, "setModel(model: any): void {", 400);
	assert.match(
		win,
		/this\._pendingModelRollback\s*=\s*this\._state\.model;\s*\n\s*this\._state\.model\s*=\s*model;/,
		"setModel() must capture the pre-switch model into _pendingModelRollback BEFORE optimistically " +
			"overwriting _state.model, so a rejected switch can be reversed",
	);
});

test('case "state" hydrates runtime/claudeCodeSessionId/claudeCodeModelAlias and clears the rollback marker on a confirmed model', () => {
	const text = fs.readFileSync(SRC, "utf8");
	const win = windowFrom(text, 'case "state":', 2600);

	assert.match(
		win,
		/msg\.data\?\.runtime[\s\S]{0,80}this\._state\.runtime\s*=\s*msg\.data\.runtime/,
		"state handler must hydrate _state.runtime from the server's state frame " +
			"(carried by sendFallbackModelState()/buildArchivedStateData() in ws/handler.ts)",
	);
	assert.match(
		win,
		/msg\.data\?\.claudeCodeSessionId[\s\S]{0,80}this\._state\.claudeCodeSessionId\s*=\s*msg\.data\.claudeCodeSessionId/,
		"state handler must hydrate _state.claudeCodeSessionId",
	);
	assert.match(
		win,
		/msg\.data\?\.claudeCodeModelAlias[\s\S]{0,80}this\._state\.claudeCodeModelAlias\s*=\s*msg\.data\.claudeCodeModelAlias/,
		"state handler must hydrate _state.claudeCodeModelAlias",
	);
	// Must clear the rollback marker on a CONFIRMED model, in the same
	// `if (msg.data?.model)` branch that sets _state.model — otherwise a
	// later unrelated error could roll back to a model that's already stale.
	const modelBranchIdx = win.indexOf("if (msg.data?.model)");
	assert.notEqual(modelBranchIdx, -1, "state handler must have an `if (msg.data?.model)` branch");
	const modelBranch = win.slice(modelBranchIdx, modelBranchIdx + 300);
	assert.match(
		modelBranch,
		/this\._state\.model\s*=\s*msg\.data\.model;[\s\S]*this\._pendingModelRollback\s*=\s*null;/,
		"a confirmed model landing in a state frame must clear _pendingModelRollback",
	);
});

test('case "error" rolls back _state.model to _pendingModelRollback on SET_MODEL_FAILED / RUNTIME_SWITCH_REQUIRES_NEW_SESSION', () => {
	const text = fs.readFileSync(SRC, "utf8");
	const win = windowFrom(text, 'case "error":', 900);

	assert.match(
		win,
		/msg\.code\s*===\s*"SET_MODEL_FAILED"/,
		"error handler must branch on SET_MODEL_FAILED",
	);
	assert.match(
		win,
		/msg\.code\s*===\s*"RUNTIME_SWITCH_REQUIRES_NEW_SESSION"/,
		"error handler must also branch on RUNTIME_SWITCH_REQUIRES_NEW_SESSION — the code " +
			"assertRuntimeSwitchAllowed()/RuntimeSwitchError use for a rejected cross-runtime set_model",
	);
	assert.match(
		win,
		/this\._pendingModelRollback[\s\S]{0,120}this\._state\.model\s*=\s*this\._pendingModelRollback;\s*\n\s*this\._pendingModelRollback\s*=\s*null;/,
		"a rejected set_model must restore _state.model from _pendingModelRollback and clear the marker",
	);
});

test("_pendingModelRollback field exists and defaults to null", () => {
	const text = fs.readFileSync(SRC, "utf8");
	assert.match(
		text,
		/private\s+_pendingModelRollback:\s*any\s*=\s*null;/,
		"expected a private _pendingModelRollback field defaulting to null",
	);
});
