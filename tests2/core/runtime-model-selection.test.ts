import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, vi } from "vitest";
import { applyVerifiedRuntimeSessionThinkingMutation } from "../../src/server/ws/runtime-model-selection.js";
import { normalizeHumanSelectionPins, SessionStore } from "../../src/server/agent/session-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");
const handlerSource = readFileSync(path.join(root, "src/server/ws/handler.ts"), "utf8");
const managerSource = readFileSync(path.join(root, "src/server/agent/session-manager.ts"), "utf8");

/** Extract exactly one class-method body; later methods are not evidence about it. */
function extractMethodBody(source: string, signature: string): string {
	const signatureIndex = source.indexOf(signature);
	assert.ok(signatureIndex >= 0, `could not find ${signature}`);
	const openingBrace = source.indexOf("{", signatureIndex + signature.length);
	assert.ok(openingBrace >= 0, `could not find body for ${signature}`);
	let depth = 1;
	for (let index = openingBrace + 1; index < source.length; index++) {
		if (source[index] === "{") depth++;
		if (source[index] === "}" && --depth === 0) return source.slice(openingBrace + 1, index);
	}
	throw new Error(`unterminated body for ${signature}`);
}

function loadHasExplicitThinkingChoice() {
	const body = extractMethodBody(managerSource, "hasExplicitThinkingChoice(sessionId: string): boolean");
	return new Function(`return function(sessionId) {${body}};`)() as (this: any, sessionId: string) => boolean;
}

function state(thinkingLevel: string) {
	return {
		success: true,
		data: {
			model: { provider: "anthropic", id: "claude-opus-5" },
			thinkingLevel,
		},
	};
}

describe("runtime model selection human pins", () => {
	it("keeps pin provenance separate from durable tuple normalization", () => {
		assert.deepEqual(normalizeHumanSelectionPins({
			model: { provider: "anthropic", modelId: "claude-opus-5" },
			thinkingLevel: "high",
		}), {
			model: { provider: "anthropic", modelId: "claude-opus-5" },
			thinkingLevel: "high",
		});
		assert.equal(normalizeHumanSelectionPins({ model: { provider: "anthropic" }, thinkingLevel: "not-real" }), undefined);
	});

	it("durably round-trips only explicit pin provenance", async () => {
		const stateDir = mkdtempSync(path.join(os.tmpdir(), "runtime-selection-pins-"));
		try {
			const store = new SessionStore(stateDir);
			store.put({
				id: "pin-session",
				title: "Pinned session",
				cwd: stateDir,
				agentSessionFile: path.join(stateDir, "agent.jsonl"),
				createdAt: 1,
				lastActivity: 1,
				modelProvider: "anthropic",
				modelId: "claude-opus-5",
				effectiveThinkingLevel: "medium",
				humanSelectionPins: {
					model: { provider: "anthropic", modelId: "claude-opus-5" },
					thinkingLevel: "high",
				},
			});
			await store.flushAsync();
			assert.deepEqual(new SessionStore(stateDir).get("pin-session")?.humanSelectionPins, {
				model: { provider: "anthropic", modelId: "claude-opus-5" },
				thinkingLevel: "high",
			});
		} finally {
			rmSync(stateDir, { recursive: true, force: true });
		}
	});

	it("routes an already-clamped advisory value through verified read-back, persistence, and broadcast", async () => {
		let thinkingLevel = "high";
		const rpcClient = {
			getState: vi.fn(async () => state(thinkingLevel)),
			setThinkingLevel: vi.fn(async (level: string) => { thinkingLevel = level; }),
			stop: vi.fn(async () => {}),
		};
		const session: any = {
			id: "runtime-model-selection",
			clients: new Set(),
			rpcClient,
			spawnPinnedModel: "anthropic/claude-opus-5",
			spawnPinnedThinkingLevel: "high",
		};
		const persisted: any[] = [];
		const manager: any = {
			getPersistedSession: () => ({
				modelProvider: "anthropic",
				modelId: "claude-opus-5",
				effectiveThinkingLevel: "high",
			}),
			persistSessionModel: (...args: unknown[]) => persisted.push(args),
			updateModelNameFile: vi.fn(),
			getSession: () => session,
			restartAgent: vi.fn(),
			terminateSession: vi.fn(),
			storeArchive: vi.fn(),
		};
		const broadcasts: any[] = [];

		const verified = await applyVerifiedRuntimeSessionThinkingMutation(
			manager,
			session,
			"medium",
			(_clients, message) => broadcasts.push(message),
		);

		assert.deepEqual(verified, {
			provider: "anthropic",
			id: "claude-opus-5",
			thinkingLevel: "medium",
		});
		assert.deepEqual(persisted, [["runtime-model-selection", "anthropic", "claude-opus-5", "medium"]]);
		assert.equal(session.spawnPinnedThinkingLevel, "medium");
		assert.equal(broadcasts.at(-1)?.data?.thinkingLevel, "medium");
	});

	it("writes pins only after successful user websocket selection paths", () => {
		const modelCase = handlerSource.slice(handlerSource.indexOf('case "set_model":'), handlerSource.indexOf('case "set_image_model":'));
		const thinkingCase = handlerSource.slice(handlerSource.indexOf('case "set_thinking_level":'), handlerSource.indexOf('case "compact":'));
		assert.match(modelCase, /await applyRuntimeSessionModelSelection[\s\S]*persistHumanModelSelection/);
		assert.match(thinkingCase, /await applyRuntimeSessionThinkingSelection[\s\S]*persistHumanThinkingSelection/);
		assert.match(managerSource, /humanSelectionPins:\s*normalizeHumanSelectionPins\(ps\.humanSelectionPins\)/);

		const durableTupleMethod = extractMethodBody(managerSource, "persistSessionModel(sessionId: string");
		assert.doesNotMatch(durableTupleMethod, /humanSelectionPins/);
	});

	it("treats human, role, and default authority as pins but not an ordinary runtime tuple", () => {
		const hasExplicitThinkingChoice = loadHasExplicitThinkingChoice();
		const session: { role?: string; projectId: string; spawnPinnedModel: string } = {
			role: "operator",
			projectId: "project-a",
			// A verified runtime mutation mirrors its tuple here; it is durability,
			// not an ongoing user/operator choice.
			spawnPinnedModel: "anthropic/claude-opus-5",
		};
		const persisted: any = {
			modelProvider: "anthropic",
			modelId: "claude-opus-5",
			effectiveThinkingLevel: "high",
			projectId: "project-a",
		};
		const manager: any = {
			getPersistedSession: () => persisted,
			sessions: new Map([["session-a", session]]),
			_setupCallerThinkingAuthorities: new Map(),
			resolveExplicitThinkingCandidate: () => undefined,
		};

		assert.equal(hasExplicitThinkingChoice.call(manager, "session-a"), false, "durability alone must leave granted advice eligible");

		persisted.humanSelectionPins = { thinkingLevel: "high" };
		assert.equal(hasExplicitThinkingChoice.call(manager, "session-a"), true, "human pin must deny advice");
		delete persisted.humanSelectionPins;

		manager.resolveExplicitThinkingCandidate = (role: string | undefined) => role === "operator" ? "high" : undefined;
		assert.equal(hasExplicitThinkingChoice.call(manager, "session-a"), true, "role choice must deny advice");

		session.role = undefined;
		manager.resolveExplicitThinkingCandidate = (_role: string | undefined, projectId: string | undefined) => projectId === "project-a" ? "medium" : undefined;
		assert.equal(hasExplicitThinkingChoice.call(manager, "session-a"), true, "default choice must deny advice");
	});
});
