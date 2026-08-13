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

/**
 * Browser-owned deterministic barriers around the in-process mock Pi runtime.
 * They do not add alternate delivery state: they only pause existing RPC/event
 * boundaries so the journey can inspect the visible UI without arbitrary sleeps.
 */
export class ReliableTurnRuntime {
	private readonly core: any;
	private readonly bridge: any;
	private readonly originalHandlePrompt: (...args: any[]) => Promise<any>;
	private readonly originalSteer: (...args: any[]) => Promise<any>;
	private readonly originalEmit: (event: any) => void;
	private readonly originalSleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly originalAutoCompaction: (preCount: number, reason?: string) => Promise<void>;
	private readonly echoHolds = new Map<string, TurnBarrier[]>();
	private readonly steerAckHolds = new Map<string, TurnBarrier[]>();
	private readonly steerFailures = new Map<string, Error[]>();
	private nextTool: TurnBarrier | undefined;
	private activeTool: TurnBarrier | undefined;
	private nextCompaction: CompactionHold | undefined;
	private activeCompaction: CompactionHold | undefined;
	private overflowAwaitingTerminal: CompactionHold | undefined;
	private overflowRetryInProgress = false;
	private restored = false;

	constructor(gateway: GatewayInfo, sessionId: string) {
		const session = gateway.sessionManager?.getSession(sessionId);
		this.bridge = session?.rpcClient;
		this.core = this.bridge?._agent;
		if (!this.bridge || !this.core) {
			throw new Error("Reliable Agent Turns journey requires the in-process mock Pi bridge");
		}
		this.originalHandlePrompt = this.core.handlePrompt;
		this.originalSteer = this.bridge.steer;
		this.originalEmit = this.core.emit;
		this.originalSleep = this.core._sleep;
		this.originalAutoCompaction = this.core._handleAutoCompaction;

		const fixture = this;
		this.core.handlePrompt = async function heldPrompt(text: string, ...args: any[]) {
			const gate = fixture.shift(fixture.echoHolds, text);
			if (gate) await gate.wait();
			return fixture.originalHandlePrompt.call(this, text, ...args);
		};
		this.bridge.steer = async function heldSteer(text: string, ...args: any[]) {
			const failure = fixture.shift(fixture.steerFailures, text);
			if (failure) throw failure;
			const result = await fixture.originalSteer.call(this, text, ...args);
			const gate = fixture.shift(fixture.steerAckHolds, text);
			if (gate) await gate.wait();
			return result;
		};
		this.core.emit = function observedEmit(event: any) {
			return fixture.emitWithBarriers(this, event);
		};
		this.core.setSleep(async (ms: number, signal?: AbortSignal) => {
			if (fixture.activeCompaction) {
				await fixture.waitUnlessAborted(fixture.activeCompaction.compaction, signal);
				return;
			}
			if (fixture.activeTool) {
				const gate = fixture.activeTool;
				fixture.activeTool = undefined;
				await fixture.waitUnlessAborted(gate, signal);
				return;
			}
			return fixture.originalSleep(ms, signal);
		});
		this.core._handleAutoCompaction = async function heldCompaction(preCount: number, reason?: string) {
			const hold = fixture.nextCompaction;
			fixture.nextCompaction = undefined;
			if (!hold) return fixture.originalAutoCompaction.call(this, preCount, reason);
			fixture.activeCompaction = hold;
			try {
				return await fixture.originalAutoCompaction.call(this, preCount, hold.reason);
			} finally {
				fixture.activeCompaction = undefined;
			}
		};
	}

	holdEcho(text: string, label = `echo:${text}`): TurnBarrier {
		return this.push(this.echoHolds, text, new TurnBarrier(label));
	}

	holdSteerAcknowledgement(text: string, label = `steer-ack:${text}`): TurnBarrier {
		return this.push(this.steerAckHolds, text, new TurnBarrier(label));
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
	}): CompactionHold {
		if (this.nextCompaction || this.activeCompaction) throw new Error("A compaction barrier is already armed");
		const hold: CompactionHold = {
			reason: options.reason,
			outcome: options.outcome ?? "success",
			compaction: new TurnBarrier(`compaction:${options.reason}`),
			...(options.willRetry ? { retry: new TurnBarrier(`retry:${options.reason}`) } : {}),
		};
		this.nextCompaction = hold;
		return hold;
	}

	restore(): void {
		if (this.restored) return;
		this.restored = true;
		this.nextTool?.release();
		this.activeTool?.release();
		this.nextCompaction?.compaction.release();
		this.nextCompaction?.retry?.release();
		this.activeCompaction?.compaction.release();
		this.activeCompaction?.retry?.release();
		this.overflowAwaitingTerminal?.retry?.release();
		for (const gates of [...this.echoHolds.values(), ...this.steerAckHolds.values()]) {
			for (const gate of gates) gate.release();
		}
		this.core.handlePrompt = this.originalHandlePrompt;
		this.bridge.steer = this.originalSteer;
		this.core.emit = this.originalEmit;
		this.core.setSleep(this.originalSleep);
		this.core._handleAutoCompaction = this.originalAutoCompaction;
	}

	private emitWithBarriers(receiver: any, input: any): void {
		let event = input;
		if (event?.type === "tool_execution_start" && this.nextTool) {
			this.activeTool = this.nextTool;
			this.nextTool = undefined;
			this.activeTool.arrive();
		}
		if (event?.type === "compaction_start" || event?.type === "auto_compaction_start") {
			this.activeCompaction?.compaction.arrive();
		}
		if ((event?.type === "compaction_end" || event?.type === "auto_compaction_end") && this.activeCompaction) {
			if (this.activeCompaction.outcome === "failure") {
				event = { ...event, result: undefined, error: "fixture-compaction-failed" };
			}
			if (this.activeCompaction.reason === "overflow" && this.activeCompaction.retry) {
				this.overflowAwaitingTerminal = this.activeCompaction;
			}
		}
		if (event?.type === "agent_end" && event.willRetry !== true && this.overflowAwaitingTerminal?.retry) {
			const hold = this.overflowAwaitingTerminal;
			const retry = hold.retry!;
			this.overflowAwaitingTerminal = undefined;
			this.overflowRetryInProgress = true;
			this.originalEmit.call(receiver, { ...event, willRetry: true });
			retry.arrive();
			void retry.wait().then(() => {
				this.overflowRetryInProgress = false;
				this.originalEmit.call(receiver, { ...event, willRetry: false });
				this.originalEmit.call(receiver, { type: "session_status", status: "idle" });
			});
			return;
		}
		// The mock normally emits idle immediately after agent_end. During the held
		// overflow retry, final idle belongs to the retry barrier above.
		if (event?.type === "session_status" && event.status === "idle" && this.overflowRetryInProgress) return;
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
