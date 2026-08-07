import { describe, expect, it, vi } from "vitest";
import { AdvisoryThinkingConsumer } from "../../src/server/agent/advisory-thinking-consumer.ts";
import { applyRuntimeSessionThinkingSelection } from "../../src/server/ws/runtime-model-selection.ts";
import { SESSION_COMMAND_SERIALISER, sessionCommandSerialisationKey } from "../../src/server/ws/session-command-serialiser.ts";

function state(level = "low") {
	return { data: { model: { provider: "openai", id: "gpt-5.2" }, thinkingLevel: level } };
}

type FixtureOptions = {
	pin?: boolean;
	explicitChoice?: boolean;
	allowed?: boolean;
	initialState?: "unreadable";
	setThinking?: "reject";
	readBack?: "unreadable";
	copySession?: boolean;
	deferInitialState?: boolean;
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
	return { promise, resolve };
}

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
	let allowed = opts.allowed ?? true;
	let explicitChoice = opts.explicitChoice ?? false;
	const initialStateStarted = deferred<void>();
	const releaseInitialState = deferred<void>();
	const rpc = {
		getState: vi.fn(async () => {
			stateReads++;
			if (stateReads === 1 && opts.deferInitialState) {
				initialStateStarted.resolve();
				await releaseInitialState.promise;
			}
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
	const broadcasts = vi.fn();
	const manager: any = {
		getSession: () => session,
		getPersistedSession: () => persisted,
		persistSessionModel: vi.fn((_sessionId: string, provider: string, modelId: string, level: string) => {
			persisted.modelProvider = provider;
			persisted.modelId = modelId;
			persisted.effectiveThinkingLevel = level;
		}),
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
			isAuthorized: () => allowed,
			hasExplicitThinkingChoice: () => Boolean(persisted.humanSelectionPins?.thinkingLevel) || explicitChoice,
			broadcast: broadcasts,
		} as any),
		manager,
		persisted,
		rpc,
		broadcasts,
		initialStateStarted,
		releaseInitialState,
		setAllowed: (value: boolean) => { allowed = value; },
		setExplicitChoice: (value: boolean) => { explicitChoice = value; },
		session,
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
		const { consumer, rpc, manager, broadcasts } = fixture({ pin: true });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "pinned" });
		expect(rpc.getState).not.toHaveBeenCalled();
		expect(rpc.setThinkingLevel).not.toHaveBeenCalled();
		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expect(broadcasts).not.toHaveBeenCalled();
	});

	it.each(["role", "default", "operator"])("honors a live %s explicit choice before authorization or RPC work", async () => {
		const { consumer, rpc, manager, broadcasts } = fixture({ explicitChoice: true });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "pinned" });
		expect(rpc.getState).not.toHaveBeenCalled();
		expect(rpc.setThinkingLevel).not.toHaveBeenCalled();
		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expect(broadcasts).not.toHaveBeenCalled();
	});

	it("applies granted advice when the only state is an ordinary verified runtime tuple", async () => {
		const { consumer, persisted, session, rpc, manager } = fixture();
		session.spawnPinnedModel = "openai/gpt-5.2";
		session.spawnPinnedThinkingLevel = persisted.effectiveThinkingLevel;

		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "applied", effectiveThinkingLevel: "high" });
		expect(rpc.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(manager.persistSessionModel).toHaveBeenCalledWith("session-a", "openai", "gpt-5.2", "high");
	});

	it("requires a fresh grant before any runtime RPC", async () => {
		const { consumer } = fixture({ allowed: false });
		await expect(consumer.apply(applyInput)).resolves.toEqual({ status: "denied" });
	});

	it("rechecks a revoked grant after the deferred live read and before the mutation RPC", async () => {
		const { consumer, rpc, manager, broadcasts, initialStateStarted, releaseInitialState, setAllowed } = fixture({ deferInitialState: true });
		const applying = consumer.apply(applyInput);
		await initialStateStarted.promise;
		setAllowed(false);
		releaseInitialState.resolve();

		await expect(applying).resolves.toEqual({ status: "denied" });
		expect(rpc.setThinkingLevel).not.toHaveBeenCalled();
		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expect(manager.updateModelNameFile).not.toHaveBeenCalled();
		expect(broadcasts).not.toHaveBeenCalled();
		expectNoDestructiveRecovery(manager);
	});

	it("rechecks a role/default/operator choice after the live read and before the mutation RPC", async () => {
		const { consumer, rpc, manager, broadcasts, initialStateStarted, releaseInitialState, setExplicitChoice } = fixture({ deferInitialState: true });
		const applying = consumer.apply(applyInput);
		await initialStateStarted.promise;
		setExplicitChoice(true);
		releaseInitialState.resolve();

		await expect(applying).resolves.toEqual({ status: "pinned" });
		expect(rpc.setThinkingLevel).not.toHaveBeenCalled();
		expect(manager.persistSessionModel).not.toHaveBeenCalled();
		expect(broadcasts).not.toHaveBeenCalled();
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

	it("serialises a human selection first so the later advisory sees its pin", async () => {
		const { consumer, manager, persisted, session } = fixture();
		const key = sessionCommandSerialisationKey(session.id);
		const human = SESSION_COMMAND_SERIALISER.serialise(key, async () => {
			const verified = await applyRuntimeSessionThinkingSelection(manager, session, "medium");
			persisted.humanSelectionPins = { thinkingLevel: verified.thinkingLevel };
		});
		const advisory = consumer.apply(applyInput);

		await human;
		await expect(advisory).resolves.toEqual({ status: "pinned" });
		expect(persisted).toMatchObject({ effectiveThinkingLevel: "medium", humanSelectionPins: { thinkingLevel: "medium" } });
	});

	it("runs a queued human selection after advisory work and leaves the verified human tuple pinned", async () => {
		const { consumer, manager, persisted, rpc, session, initialStateStarted, releaseInitialState } = fixture({ deferInitialState: true });
		const key = sessionCommandSerialisationKey(session.id);
		const advisory = consumer.apply(applyInput);
		await initialStateStarted.promise;
		const human = SESSION_COMMAND_SERIALISER.serialise(key, async () => {
			const verified = await applyRuntimeSessionThinkingSelection(manager, session, "medium");
			persisted.humanSelectionPins = { thinkingLevel: verified.thinkingLevel };
		});
		releaseInitialState.resolve();

		await expect(advisory).resolves.toEqual({ status: "applied", effectiveThinkingLevel: "high" });
		await human;
		expect(rpc.setThinkingLevel.mock.calls.map(([level]: [string]) => level)).toEqual(["high", "medium"]);
		expect(persisted).toMatchObject({ effectiveThinkingLevel: "medium", humanSelectionPins: { thinkingLevel: "medium" } });
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
