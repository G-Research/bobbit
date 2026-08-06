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

function state(thinkingLevel: string) {
	return {
		success: true,
		data: {
			model: { provider: "anthropic", id: "claude-sonnet-4-20250514" },
			thinkingLevel,
		},
	};
}

describe("runtime model selection human pins", () => {
	it("keeps pin provenance separate from durable tuple normalization", () => {
		assert.deepEqual(normalizeHumanSelectionPins({
			model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
			thinkingLevel: "high",
		}), {
			model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
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
				modelId: "claude-sonnet-4-20250514",
				effectiveThinkingLevel: "medium",
				humanSelectionPins: {
					model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
					thinkingLevel: "high",
				},
			});
			await store.flushAsync();
			assert.deepEqual(new SessionStore(stateDir).get("pin-session")?.humanSelectionPins, {
				model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
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
			spawnPinnedModel: "anthropic/claude-sonnet-4-20250514",
			spawnPinnedThinkingLevel: "high",
		};
		const persisted: any[] = [];
		const manager: any = {
			getPersistedSession: () => ({
				modelProvider: "anthropic",
				modelId: "claude-sonnet-4-20250514",
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
			id: "claude-sonnet-4-20250514",
			thinkingLevel: "medium",
		});
		assert.deepEqual(persisted, [["runtime-model-selection", "anthropic", "claude-sonnet-4-20250514", "medium"]]);
		assert.equal(session.spawnPinnedThinkingLevel, "medium");
		assert.equal(broadcasts.at(-1)?.data?.thinkingLevel, "medium");
	});

	it("writes pins only after successful user websocket selection paths", () => {
		const modelCase = handlerSource.slice(handlerSource.indexOf('case "set_model":'), handlerSource.indexOf('case "set_image_model":'));
		const thinkingCase = handlerSource.slice(handlerSource.indexOf('case "set_thinking_level":'), handlerSource.indexOf('case "compact":'));
		assert.match(modelCase, /await applyRuntimeSessionModelSelection[\s\S]*persistHumanModelSelection/);
		assert.match(thinkingCase, /await applyRuntimeSessionThinkingSelection[\s\S]*persistHumanThinkingSelection/);
		assert.match(managerSource, /humanSelectionPins:\s*normalizeHumanSelectionPins\(ps\.humanSelectionPins\)/);

		const durableTupleMethod = managerSource.slice(
			managerSource.indexOf("persistSessionModel(sessionId: string"),
			managerSource.indexOf("persistHumanModelSelection(sessionId: string"),
		);
		assert.doesNotMatch(durableTupleMethod, /humanSelectionPins/);
	});
});
