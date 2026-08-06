import { describe, expect, it, vi } from "vitest";
import { AdvisoryThinkingConsumer } from "../../src/server/agent/advisory-thinking-consumer.ts";

function state(level = "low") {
	return { data: { model: { provider: "openai", id: "gpt-5.2" }, thinkingLevel: level } };
}

type FixtureOptions = {
	pin?: boolean;
	allowed?: boolean;
	initialState?: "unreadable";
	setThinking?: "reject";
	readBack?: "unreadable";
	copySession?: boolean;
};

function fixture(opts: FixtureOptions = {}) {
	const persisted: any = {
		projectId: "project-a",
		modelProvider: "openai",
		modelId: "gpt-5.2",
		effectiveThinkingLevel: "low",
		humanSelectionPins: opts.pin ? { thinkingLevel: "low" } : { model: { provider: "openai", modelId: "gpt-5.2" } },
	};
	let stateReads = 0;
	let thinkingLevel = "low";
	const rpc = {
		getState: vi.fn(async () => {
			stateReads++;
			if (opts.initialState === "unreadable" || (opts.readBack === "unreadable" && stateReads === 2)) return undefined;
			return state(thinkingLevel);
		}),
		setThinkingLevel: vi.fn(async (level: string) => {
			if (opts.setThinking === "reject") throw new Error("set thinking rejected");
			thinkingLevel = level;
		}),
		stop: vi.fn(async () => {}),
	};
	const session: any = { id: "session-a", projectId: "project-a", rpcClient: rpc, clients: new Set() };
	const manager: any = {
		getSession: () => session,
		getPersistedSession: () => persisted,
		persistSessionModel: vi.fn(),
		updateModelNameFile: vi.fn(),
		restartAgent: vi.fn(),
		terminateSession: vi.fn(),
		storeArchive: vi.fn(),
	};
	return {
		consumer: new AdvisoryThinkingConsumer({
			sessionManager: manager,
			getSession: () => opts.copySession ? { ...session } : session,
			getPersistedSession: manager.getPersistedSession,
			isAuthorized: () => opts.allowed ?? true,
		}),
		manager,
		persisted,
		rpc,
	};
}

const applyInput = {
	sessionId: "session-a", projectId: "project-a", requested: "high" as const, source: { packId: "pack", hookId: "hook" },
};

function expectNoDestructiveRecovery(manager: any) {
	expect(manager.restartAgent).not.toHaveBeenCalled();
	expect(manager.terminateSession).not.toHaveBeenCalled();
	expect(manager.storeArchive).not.toHaveBeenCalled();
}

describe("advisory thinking consumer", () => {
	it("honors an explicit human pin before authorization or RPC work", async () => {
		const { consumer } = fixture({ pin: true });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "pinned" });
	});

	it("requires a fresh grant before any runtime RPC", async () => {
		const { consumer } = fixture({ allowed: false });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "denied" });
	});

	it("applies through the manager-owned session rather than a copied session", async () => {
		const { consumer, manager, rpc } = fixture();
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "applied", effectiveThinkingLevel: "high" });
		expect(rpc.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(manager.persistSessionModel).toHaveBeenCalledWith("session-a", "openai", "gpt-5.2", "high");
	});

	it("rejects a copied session rather than mutating an unowned runtime bridge", async () => {
		const { consumer, manager, rpc } = fixture({ copySession: true });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "failed" });
		expect(rpc.setThinkingLevel).not.toHaveBeenCalled();
		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expectNoDestructiveRecovery(manager);
	});

	it.each([
		["initial snapshot is unreadable", { initialState: "unreadable" }],
		["setting thinking rejects", { setThinking: "reject" }],
		["read-back is unreadable", { readBack: "unreadable" }],
	] satisfies [string, FixtureOptions][]) ("returns failed without recovery when %s", async (_reason, opts) => {
		const { consumer, manager, persisted } = fixture(opts);
		const durableBefore = structuredClone(persisted);

		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "failed" });

		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expect(manager.updateModelNameFile).not.toHaveBeenCalled();
		expect(persisted).toEqual(durableBefore);
		expectNoDestructiveRecovery(manager);
	});
});
