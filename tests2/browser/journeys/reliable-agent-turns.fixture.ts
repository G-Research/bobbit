import type { BrowserContext, Locator, Page } from "@playwright/test";
import type { GatewayInfo } from "../gateway-harness.js";
import { expect, navigateToHash, openApp } from "../_helpers/journey-fixture.js";

/** A deterministic test seam: arrival is observable separately from release. */
export class TurnBarrier {
	readonly entered: Promise<void>;
	private readonly released: Promise<void>;
	private resolveEntered!: () => void;
	private resolveReleased!: () => void;
	private didEnter = false;
	private didRelease = false;

	constructor(readonly label: string) {
		this.entered = new Promise<void>((resolve) => { this.resolveEntered = resolve; });
		this.released = new Promise<void>((resolve) => { this.resolveReleased = resolve; });
	}

	arrive(): void {
		if (this.didEnter) return;
		this.didEnter = true;
		this.resolveEntered();
	}

	wait(): Promise<void> {
		this.arrive();
		return this.released;
	}

	release(): void {
		if (this.didRelease) return;
		this.didRelease = true;
		this.resolveReleased();
	}
}

interface CompactionHold {
	reason: "manual" | "threshold" | "overflow";
	outcome: "success" | "failure";
	compaction: TurnBarrier;
	retry?: TurnBarrier;
}

export interface CoreBarrierHold {
	occurrence: number;
	boundary: string;
	entered: Promise<void>;
	bindIntent(intentId: string): void;
	release(): void;
}

export interface AbortHold {
	occurrence: number;
	receivedBoundary: string;
	received: Promise<void>;
	beforeAgentEnd: CoreBarrierHold;
}

/**
 * Browser-owned deterministic barriers around the in-process mock Pi runtime.
 * They do not add alternate delivery state: they only pause existing RPC/event
 * boundaries so the journey can inspect the visible UI without arbitrary sleeps.
 */
export class ReliableTurnRuntime {
	private readonly sessionManager: any;
	private readonly sessionId: string;
	private readonly core: any;
	private readonly bridge: any;
	private readonly originalHandlePrompt: (...args: any[]) => Promise<any>;
	private readonly originalSteer: (...args: any[]) => Promise<any>;
	private readonly originalEmit: (event: any) => void;
	private readonly originalSleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly echoHolds = new Map<string, TurnBarrier[]>();
	private readonly steerAckHolds = new Map<string, TurnBarrier[]>();
	private readonly steerFailures = new Map<string, Error[]>();
	private nextTool: TurnBarrier | undefined;
	private activeTool: TurnBarrier | undefined;
	private nextCompaction: CompactionHold | undefined;
	private nextSteerUserStartOccurrence = 1;
	private nextAbortOccurrence = 1;
	private restored = false;

	constructor(gateway: GatewayInfo, sessionId: string) {
		this.sessionManager = gateway.sessionManager;
		this.sessionId = sessionId;
		const session = this.sessionManager?.getSession(sessionId);
		this.bridge = session?.rpcClient;
		this.core = this.bridge?._agent;
		if (!this.bridge || !this.core) {
			throw new Error("Reliable Agent Turns journey requires the in-process mock Pi bridge");
		}
		this.originalHandlePrompt = this.core.handlePrompt;
		this.originalSteer = this.bridge.steer;
		this.originalEmit = this.core.emit;
		this.originalSleep = this.core._sleep;
		this.nextSteerUserStartOccurrence = Number(this.core._commandSequence?.steer ?? 0) + 1;
		this.nextAbortOccurrence = Number(this.core._commandSequence?.abort ?? 0) + 1;

		const fixture = this;
		this.core.handlePrompt = async function heldPrompt(text: string, ...args: any[]) {
			const gate = fixture.shift(fixture.echoHolds, text);
			if (gate) await gate.wait();
			return fixture.originalHandlePrompt.call(this, text, ...args);
		};
		this.bridge.steer = async function heldSteer(text: string, ...args: any[]) {
			const failure = fixture.shift(fixture.steerFailures, text);
			if (failure) return { success: false, error: failure.message };
			const result = await fixture.originalSteer.call(this, text, ...args);
			const gate = fixture.shift(fixture.steerAckHolds, text);
			if (gate) await gate.wait();
			return result;
		};
		this.core.emit = function observedEmit(event: any) {
			return fixture.emitWithBarriers(this, event);
		};
		this.core.setSleep(async (ms: number, signal?: AbortSignal) => {
			if (fixture.activeTool) {
				const gate = fixture.activeTool;
				fixture.activeTool = undefined;
				await fixture.waitUnlessAborted(gate, signal);
				return;
			}
			return fixture.originalSleep(ms, signal);
		});
	}

	holdEcho(text: string, label = `echo:${text}`): TurnBarrier {
		return this.push(this.echoHolds, text, new TurnBarrier(label));
	}

	/** Hold the next prompt after its complete terminal idle lifecycle was emitted. */
	holdNextPromptTerminalIdle(): CoreBarrierHold {
		const occurrence = Number(this.core._commandSequence?.prompt ?? 0) + 1;
		return this.holdCoreBarrier(`prompt:${occurrence}:after-terminal-idle`, occurrence);
	}

	/** Hold the next steer after MockAgentCore has installed its abort controller. */
	holdNextSteerUserStart(): CoreBarrierHold {
		const occurrence = Math.max(
			this.nextSteerUserStartOccurrence,
			Number(this.core._commandSequence?.steer ?? 0) + 1,
		);
		this.nextSteerUserStartOccurrence = occurrence + 1;
		return this.holdCoreBarrier(`steer:${occurrence}:before-user-start`, occurrence);
	}

	holdSteerAcknowledgement(text: string, label = `steer-ack:${text}`): TurnBarrier {
		return this.push(this.steerAckHolds, text, new TurnBarrier(label));
	}

	/** Task notifications are trusted system prompts, so Pi receives their stable System prefix. */
	holdTaskNotificationEcho(text: string, label = `task-notification:${text}`): TurnBarrier {
		return this.holdEcho(`[System]: ${text}`, label);
	}

	/** Dispatch through the production task-notification source without supplying a browser-owned id. */
	dispatchTaskNotifications(texts: readonly string[]): Promise<unknown[]> {
		return Promise.all(texts.map((text) =>
			this.sessionManager.deliverLiveSteer(this.sessionId, text, { source: "task-notification" }),
		));
	}

	failSteer(text: string, message = "fixture definite pre-dispatch rejection"): void {
		this.push(this.steerFailures, text, new Error(message));
	}

	holdNextTool(label = "tool-body"): TurnBarrier {
		if (this.nextTool || this.activeTool) throw new Error("A tool barrier is already armed");
		this.nextTool = new TurnBarrier(label);
		return this.nextTool;
	}

	holdNextCompaction(options: {
		reason: CompactionHold["reason"];
		outcome?: CompactionHold["outcome"];
		willRetry?: boolean;
		preCompactionError?: string;
	}): CompactionHold {
		if (this.nextCompaction) throw new Error("A compaction barrier is already armed");
		const hold: CompactionHold = {
			reason: options.reason,
			outcome: options.outcome ?? "success",
			compaction: new TurnBarrier(`compaction:${options.reason}`),
			...(options.willRetry ? { retry: new TurnBarrier(`retry:${options.reason}`) } : {}),
		};
		this.nextCompaction = hold;
		this.core.configureReliableScenario({
			compaction: {
				[options.reason]: {
					outcome: hold.outcome,
					willRetry: options.willRetry,
					preCompactionError: options.preCompactionError,
				},
			},
		});

		const compactionBoundary = `${options.reason}:compaction-start`;
		this.core.armBarrier(compactionBoundary);
		void this.core.waitForBarrier(compactionBoundary).then(async () => {
			hold.compaction.arrive();
			await hold.compaction.wait();
			this.core.releaseBarrier(compactionBoundary);
			this.nextCompaction = undefined;
		});

		if (hold.retry) {
			const finalBoundary = `${options.reason}:before-final-agent-end`;
			this.core.armBarrier(finalBoundary);
			void this.core.waitForBarrier(finalBoundary).then(async () => {
				hold.retry!.arrive();
				await hold.retry!.wait();
				this.core.releaseBarrier(finalBoundary);
			});
		}
		return hold;
	}

	/** Observe abort command receipt independently from its held terminal event. */
	holdNextAbort(): AbortHold {
		const occurrence = Math.max(
			this.nextAbortOccurrence,
			Number(this.core._commandSequence?.abort ?? 0) + 1,
		);
		this.nextAbortOccurrence = occurrence + 1;
		const receivedBoundary = `abort:${occurrence}:received`;
		return {
			occurrence,
			receivedBoundary,
			received: Promise.resolve(this.core.waitForBarrier(receivedBoundary)).then(() => undefined),
			beforeAgentEnd: this.holdCoreBarrier(`abort:${occurrence}:before-agent-end`, occurrence),
		};
	}

	get commandJournal(): any[] {
		return this.core.commandJournal;
	}

	get barrierJournal(): any[] {
		return this.core.barrierJournal;
	}

	/**
	 * Snapshot the server-owned lifecycle revision without creating another event.
	 * Status frames and buffered Pi events use independent ordered lanes, so both
	 * high-water marks are required before a later lifecycle transition is safe.
	 */
	statusRevision(): RemoteLifecycleRevision {
		const session = this.sessionManager?.getSession(this.sessionId);
		if (!session || !Number.isFinite(session.statusVersion) || !Number.isFinite(session.eventBuffer?.lastSeq)) {
			throw new Error("Cannot read an authoritative mock session lifecycle revision");
		}
		return {
			status: session.status,
			statusVersion: session.statusVersion,
			eventSeq: session.eventBuffer.lastSeq,
			activeRun: session.status === "streaming" && Number.isFinite(session.streamingStartedAt),
		};
	}

	/**
	 * Join the server-owned compaction refresh while the serial mock prompt chain
	 * holds the replacement steer before its user start. The refresh broadcasts
	 * its final messages/state projection asynchronously after compaction_end; a
	 * later synthetic agent_start must not race that authoritative idle state.
	 */
	async joinCompactionTerminalProjection(): Promise<RemoteLifecycleRevision> {
		const session = this.sessionManager?.getSession(this.sessionId);
		const finalization = session?._compactionFinalization;
		if (!finalization || typeof finalization.then !== "function") {
			throw new Error("Cannot join the authoritative mock compaction finalization");
		}
		await finalization;
		return this.statusRevision();
	}

	/**
	 * Admit the already active held mock run after compaction overwrote its status.
	 * The accepted agent_start is the sole owner of the canonical status revision;
	 * waiting for its buffered event revision also fences the preceding terminal
	 * lifecycle before the Stop control is exercised.
	 */
	surfaceActiveRun(): RemoteLifecycleRevision {
		if (!this.core.currentAbortController) {
			throw new Error("Cannot surface a mock run without an active abort controller");
		}
		this.core.emit({ type: "agent_start" });
		const revision = this.statusRevision();
		if (revision.status !== "streaming" || !revision.activeRun) {
			throw new Error("Accepted mock run did not publish an authoritative streaming revision");
		}
		return revision;
	}

	restore(): void {
		if (this.restored) return;
		this.restored = true;
		this.nextTool?.release();
		this.activeTool?.release();
		this.nextCompaction?.compaction.release();
		this.nextCompaction?.retry?.release();
		this.core.releaseAllBarriers();
		for (const gates of [...this.echoHolds.values(), ...this.steerAckHolds.values()]) {
			for (const gate of gates) gate.release();
		}
		this.core.handlePrompt = this.originalHandlePrompt;
		this.bridge.steer = this.originalSteer;
		this.core.emit = this.originalEmit;
		this.core.setSleep(this.originalSleep);
	}

	private emitWithBarriers(receiver: any, input: any): void {
		let event = input;
		if (event?.type === "tool_execution_start" && this.nextTool) {
			this.activeTool = this.nextTool;
			this.nextTool = undefined;
			this.activeTool.arrive();
		}
		this.originalEmit.call(receiver, event);
	}

	private async waitUnlessAborted(gate: TurnBarrier, signal?: AbortSignal): Promise<void> {
		if (!signal) {
			await gate.wait();
			return;
		}
		if (signal.aborted) {
			gate.arrive();
			return;
		}
		await Promise.race([
			gate.wait(),
			new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true })),
		]);
	}

	private holdCoreBarrier(boundary: string, occurrence: number): CoreBarrierHold {
		this.core.armBarrier(boundary);
		return {
			occurrence,
			boundary,
			entered: Promise.resolve(this.core.waitForBarrier(boundary)).then(() => undefined),
			bindIntent: (intentId) => {
				const [kind] = boundary.split(":");
				this.core.bindReliableDeliveryIntent(kind, occurrence, intentId);
			},
			release: () => { this.core.releaseBarrier(boundary); },
		};
	}

	private push<T>(map: Map<string, T[]>, key: string, value: T): T {
		const values = map.get(key) ?? [];
		values.push(value);
		map.set(key, values);
		return value;
	}

	private shift<T>(map: Map<string, T[]>, key: string): T | undefined {
		const values = map.get(key);
		const value = values?.shift();
		if (values?.length === 0) map.delete(key);
		return value;
	}
}

export function editor(page: Page): Locator {
	return page.locator("message-editor textarea").first();
}

export function outbox(page: Page): Locator {
	return page.getByTestId("message-outbox");
}

export function intentRows(page: Page, text?: string): Locator {
	const rows = outbox(page).getByTestId("intent-row");
	return text === undefined ? rows : rows.filter({ hasText: text });
}

export function intentRow(page: Page, intentId: string): Locator {
	return outbox(page).locator(`[data-testid="intent-row"][data-intent-id="${intentId}"]`);
}

export function transcriptIntent(page: Page, intentId: string): Locator {
	return page.locator(`user-message[data-intent-id="${intentId}"]`);
}

export async function captureIntentIds(page: Page, text: string, count = 1): Promise<string[]> {
	const rows = intentRows(page, text);
	await expect(rows, `accepted intent '${text}' must remain in the visible outbox`).toHaveCount(count, { timeout: 15_000 });
	const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-intent-id") ?? ""));
	expect(ids.every(Boolean), "every accepted occurrence has a stable intent id").toBe(true);
	expect(new Set(ids).size, "identical text occurrences must have distinct intent ids").toBe(ids.length);
	return ids;
}

export async function expectOneCarrier(
	page: Page,
	intentId: string,
	expected: "outbox" | "transcript",
): Promise<void> {
	await expect.poll(async () => {
		const pending = await intentRow(page, intentId).count();
		const surfaced = await transcriptIntent(page, intentId).count();
		return { pending, surfaced, total: pending + surfaced };
	}, {
		timeout: 20_000,
		message: `intent ${intentId} must have exactly one visible carrier (${expected})`,
	}).toEqual(expected === "outbox"
		? { pending: 1, surfaced: 0, total: 1 }
		: { pending: 0, surfaced: 1, total: 1 });
}

export async function expectIntentState(
	page: Page,
	intentId: string,
	state: string,
	statusText?: RegExp | string,
): Promise<void> {
	const row = intentRow(page, intentId);
	await expect(row).toHaveAttribute("data-delivery-state", state, { timeout: 15_000 });
	if (statusText) await expect(row.getByTestId("intent-status")).toContainText(statusText);
}

export async function submit(page: Page, text: string, kind: "prompt" | "steer" = "prompt"): Promise<void> {
	const textarea = editor(page);
	await expect(textarea).toBeVisible({ timeout: 15_000 });
	await textarea.fill(text);
	await textarea.press(kind === "steer" ? "Control+Enter" : "Enter");
	await expect(textarea).toHaveValue("");
}

export async function submitManualCompact(page: Page): Promise<void> {
	const textarea = editor(page);
	await textarea.fill("/compact");
	await textarea.press("Escape");
	await textarea.press("Enter");
}

export async function openSessionPage(page: Page, sessionId: string): Promise<void> {
	await openApp(page);
	await navigateToHash(page, `#/session/${sessionId}`);
	await expect(editor(page)).toBeVisible({ timeout: 20_000 });
}

export interface RemoteLifecycleRevision {
	status: string;
	statusVersion: number;
	eventSeq: number;
	activeRun: boolean;
}

export async function waitForRemoteStatus(
	page: Page,
	expected: RemoteLifecycleRevision,
): Promise<void> {
	await expect.poll(() => page.evaluate(() => {
		const remote = (window as any).bobbitState?.remoteAgent ?? (window as any).__bobbitState?.remoteAgent;
		const state = remote?.state ?? remote?._state;
		return {
			status: state?.status,
			statusVersion: Number(remote?._lastStatusVersion ?? -1),
			eventSeq: Number(remote?._highestSeq ?? -1),
			activeRun: state?.status === "streaming" && Number.isFinite(state?.turnStartTime),
		};
	}), {
		timeout: 15_000,
		message: "the remote must accept the exact authoritative lifecycle revision",
	}).toEqual(expected);
}

export async function closeActiveSessionSocket(page: Page): Promise<void> {
	await page.evaluate(() => {
		const remote = (window as any).bobbitState?.remoteAgent ?? (window as any).__bobbitState?.remoteAgent;
		if (!remote?.ws) throw new Error("active RemoteAgent WebSocket test seam is unavailable");
		remote.ws.close();
	});
}

export async function openSecondSessionTab(context: BrowserContext, sessionId: string): Promise<Page> {
	const page = await context.newPage();
	await openSessionPage(page, sessionId);
	return page;
}

export async function transcriptIntentOrder(page: Page, ids: string[]): Promise<string[]> {
	const wanted = new Set(ids);
	return page.locator("user-message[data-intent-id]").evaluateAll(
		(nodes, expected) => nodes
			.map((node) => node.getAttribute("data-intent-id") ?? "")
			.filter((id) => (expected as string[]).includes(id)),
		[...wanted],
	);
}
