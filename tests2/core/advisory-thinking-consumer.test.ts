import { describe, expect, it } from "vitest";
import { AdvisoryThinkingConsumer } from "../../src/server/agent/advisory-thinking-consumer.ts";

function state(level = "low") {
	return { data: { model: { provider: "openai", id: "gpt-5.2" }, thinkingLevel: level } };
}

function fixture(opts: { pin?: boolean; allowed?: boolean } = {}) {
	const persisted: any = {
		projectId: "project-a", modelProvider: "openai", modelId: "gpt-5.2", effectiveThinkingLevel: "low",
		...(opts.pin ? { humanSelectionPins: { thinkingLevel: "low" } } : {}),
	};
	const rpc = {
		getState: async () => state(),
		setThinkingLevel: async () => { throw new Error("must not mutate"); },
	};
	const session: any = { id: "session-a", projectId: "project-a", rpcClient: rpc, clients: new Set() };
	const manager: any = {
		getSession: () => session,
		getPersistedSession: () => persisted,
		persistSessionModel: () => { throw new Error("must not persist"); },
		updateModelNameFile: () => { throw new Error("must not write"); },
		restartAgent: async () => { throw new Error("must not restart"); },
		terminateSession: async () => false,
		storeArchive: async () => false,
	};
	return {
		consumer: new AdvisoryThinkingConsumer({
			sessionManager: manager,
			getSession: manager.getSession,
			getPersistedSession: manager.getPersistedSession,
			isAuthorized: () => opts.allowed ?? true,
		}),
		rpc,
	};
}

describe("advisory thinking consumer", () => {
	it("honors an explicit human pin before authorization or RPC work", async () => {
		const { consumer } = fixture({ pin: true });
		await expect(consumer.apply({
			sessionId: "session-a", projectId: "project-a", requested: "high", source: { packId: "pack", hookId: "hook" },
		})).resolves.toEqual({ status: "pinned" });
	});

	it("requires a fresh grant before any runtime RPC", async () => {
		const { consumer } = fixture({ allowed: false });
		await expect(consumer.apply({
			sessionId: "session-a", projectId: "project-a", requested: "high", source: { packId: "pack", hookId: "hook" },
		})).resolves.toEqual({ status: "denied" });
	});
});
