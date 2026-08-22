import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectToSession, selectSession, uncacheSession } from "../../src/app/session-manager.js";
import { isArchivedSessionActionSource } from "../../src/app/session-actions.js";
import { setRenderApp, state, type GatewaySession } from "../../src/app/state.js";

setRenderApp(() => {});

const SESSION_ID = "read-only-delegate-interaction";

type ProjectedMode = {
	archived: boolean;
	nonInteractive: boolean;
};

function sessionRecord(extra: Partial<GatewaySession> = {}): GatewaySession {
	return {
		id: SESSION_ID,
		title: "Read-only delegate",
		cwd: "/project",
		status: "idle",
		createdAt: 1,
		lastActivity: 2,
		clientCount: 0,
		delegateOf: "owner-session",
		...extra,
	};
}

async function projectedModeFor(record: GatewaySession): Promise<ProjectedMode> {
	uncacheSession(SESSION_ID);
	const agentInterface = {
		// `readOnly` is retained in this fixture only as a compatibility probe for
		// the reproducing revision. The corrected UI owns archive presentation in
		// a lifecycle-specific property instead.
		readOnly: false,
		archived: false,
		nonInteractive: false,
		session: null as any,
	};
	const remote = {
		connected: true,
		gatewaySessionId: SESSION_ID,
		state: { isArchived: false },
		registerHostApiTransports: vi.fn(),
		disconnect: vi.fn(),
	};
	agentInterface.session = remote;
	const panel = {
		agent: remote,
		agentInterface,
		classList: { add: vi.fn(), remove: vi.fn() },
		addEventListener: vi.fn(),
	};

	state.gatewaySessions = [record];
	state.selectedSessionId = SESSION_ID;
	state.remoteAgent = remote as any;
	state.chatPanel = panel as any;

	// Re-enter through the real cached-panel path. Interaction projection must be
	// synchronous, before any workspace or transcript hydration can paint.
	selectSession("parking-session");
	const pending = connectToSession(SESSION_ID, true);
	const hasLifecycleArchiveProperty = Object.prototype.hasOwnProperty.call(agentInterface, "archived")
		&& agentInterface.archived === true;
	const lifecycleRecordIsArchived = record.archived === true
		|| record.status === "archived"
		|| (record.status === "terminated" && (record as any).condition?.code !== "MODEL_SELECTION_REQUIRED");
	const legacyArchivePresentation = agentInterface.readOnly === true && agentInterface.nonInteractive !== true;
	const result = {
		archived: hasLifecycleArchiveProperty || lifecycleRecordIsArchived || legacyArchivePresentation,
		nonInteractive: agentInterface.nonInteractive,
	};
	state.switchGeneration++;
	await pending;
	return result;
}

beforeEach(() => {
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({}), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	})));
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.chatPanel = null;
	state.remoteAgent = null;
	state.selectedSessionId = null;
	state.connectionStatus = "disconnected";
});

afterEach(() => {
	uncacheSession(SESSION_ID);
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.chatPanel = null;
	state.remoteAgent = null;
	state.selectedSessionId = null;
	state.connectionStatus = "disconnected";
	vi.restoreAllMocks();
});

describe("delegate interaction-mode projection", () => {
	it("keeps an active read-only delegate interactive instead of projecting archive presentation", async () => {
		expect(
			await projectedModeFor(sessionRecord({ readOnly: true })),
			"READ_ONLY_DELEGATE_ARCHIVE_CONFLATION: active read-only delegate was projected as archived",
		).toEqual({ archived: false, nonInteractive: false });
	});

	it.each([
		["archived flag", { archived: true }],
		["archived status", { status: "archived" }],
		["ordinary termination", { status: "terminated" }],
	] as const)("closes genuine lifecycle state: %s", async (_name, extra) => {
		expect(await projectedModeFor(sessionRecord(extra as Partial<GatewaySession>)))
			.toEqual({ archived: true, nonInteractive: false });
	});

	it("keeps model-selection recovery interactive despite terminated transport state", async () => {
		expect(await projectedModeFor(sessionRecord({
			status: "terminated",
			condition: {
				code: "MODEL_SELECTION_REQUIRED",
				provider: "retired-provider",
				modelId: "retired-model",
			},
		} as any))).toEqual({ archived: false, nonInteractive: false });
	});

	it("preserves non-interactive policy independently and lets archive lifecycle win", async () => {
		expect(await projectedModeFor(sessionRecord({ nonInteractive: true })))
			.toEqual({ archived: false, nonInteractive: true });
		expect(await projectedModeFor(sessionRecord({ archived: true, nonInteractive: true })))
			.toEqual({ archived: true, nonInteractive: true });
	});
});

describe("archived session action ownership", () => {
	it("derives archived actions from lifecycle only, never the tool-capability marker", () => {
		expect(isArchivedSessionActionSource(sessionRecord({ readOnly: true })),
			"READ_ONLY_DELEGATE_ACTION_CONFLATION: capability-only readOnly exposed archived actions")
			.toBe(false);
		expect(isArchivedSessionActionSource(sessionRecord({ archived: true }))).toBe(true);
		expect(isArchivedSessionActionSource(sessionRecord({ status: "archived" }))).toBe(true);
		expect(isArchivedSessionActionSource(sessionRecord({ status: "terminated" }))).toBe(true);
	});
});
