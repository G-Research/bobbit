/**
 * Browser journey for the embedded Claude SDK subagent card. The production
 * bridge and WebSocket transport run unchanged; only the SDK Query iterator is
 * deterministic so its lifecycle can be driven without a real Claude process.
 */
import { test, expect, apiFetch, createSession, deleteSession, openApp, navigateToHash, waitForSessionStatus } from "./_helpers/journey-fixture.js";

const SDK_PROVIDER = "claude-agent-sdk";
const SDK_MODEL = "subagent-card-browser";
const SDK_SESSION_ID = "44444444-4444-4444-8444-444444444444";
const PARENT_TOOL_USE_ID = "sdk-agent-parent-card";
const CHILD_AGENT_ID = "sdk-child-card";
const CHILD_TEXT = "CHILD_CARD_ONLY_TEXT";
const LATE_CHILD_TEXT = "CHILD_CARD_RESUMED_TEXT";
const CHILD_FAILURE = "CHILD_CARD_TERMINAL_FAILURE";
const SAFE_CHILD_FAILURE = "Subagent failed";

type SdkQueryArgs = { prompt: AsyncIterable<unknown>; options: Record<string, any> };

class FixtureSdkQuery implements AsyncIterable<unknown> {
	private closed = false;
	private reader?: (value: IteratorResult<unknown>) => void;
	private queued: unknown[] = [];
	private emittedTurn = false;

	constructor(readonly args: SdkQueryArgs) {
		this.queued.push({ type: "system", subtype: "init", session_id: SDK_SESSION_ID });
		void this.consumePrompts();
	}

	async initializationResult(): Promise<Record<string, never>> { return {}; }
	async interrupt(): Promise<void> {}
	async setModel(): Promise<void> {}
	async setMaxThinkingTokens(): Promise<void> {}
	async close(): Promise<void> {
		this.closed = true;
		this.reader?.({ done: true, value: undefined });
		this.reader = undefined;
	}

	private emit(value: unknown): void {
		const row = value as Record<string, unknown>;
		if (row.type === "assistant" || row.type === "user") sdkHistory.push({ ...row });
		const reader = this.reader;
		if (reader) {
			this.reader = undefined;
			reader({ done: false, value });
		} else this.queued.push(value);
	}

	private async consumePrompts(): Promise<void> {
		for await (const _prompt of this.args.prompt) {
			if (this.emittedTurn) continue;
			this.emittedTurn = true;
			await this.emitEmbeddedChildTurn();
		}
	}

	private async emitEmbeddedChildTurn(): Promise<void> {
		const child = { agent_id: CHILD_AGENT_ID, agent_type: "bobbit-backend-parity-reviewer" };
		const parentInput = {
			subagent_type: child.agent_type,
			prompt: "Render only this bounded SDK child fixture.",
			run_in_background: false,
		};
		// The root Agent call establishes the sole card that may own child work.
		this.emit({
			type: "assistant", uuid: "root-agent-card", session_id: SDK_SESSION_ID,
			message: { content: [{ type: "tool_use", id: PARENT_TOOL_USE_ID, name: "Agent", input: parentInput }], stop_reason: "tool_use" },
		});
		await this.args.options.hooks.PreToolUse[0].hooks[0]({
			hook_event_name: "PreToolUse", session_id: SDK_SESSION_ID, tool_name: "Agent",
			tool_use_id: PARENT_TOOL_USE_ID, tool_input: parentInput,
		});
		await this.args.options.hooks.SubagentStart[0].hooks[0]({ hook_event_name: "SubagentStart", session_id: SDK_SESSION_ID, ...child });
		this.emit({
			type: "assistant", uuid: "child-tool-call", session_id: SDK_SESSION_ID,
			parent_tool_use_id: PARENT_TOOL_USE_ID, parent_agent_id: CHILD_AGENT_ID,
			message: { content: [{ type: "tool_use", id: "child-read-call", name: "mcp__bobbit__read", input: { path: "fixture.md" } }], stop_reason: "tool_use" },
		});
		this.emit({
			type: "user", uuid: "child-tool-result", session_id: SDK_SESSION_ID,
			parent_tool_use_id: PARENT_TOOL_USE_ID, parent_agent_id: CHILD_AGENT_ID,
			message: { content: [{ type: "tool_result", tool_use_id: "child-read-call", content: "fixture read result" }] },
		});
		this.emitChildText(CHILD_TEXT, "child-first-text");
	}

	emitChildText(text: string, uuid: string): void {
		this.emit({
			type: "assistant", uuid, session_id: SDK_SESSION_ID,
			parent_tool_use_id: PARENT_TOOL_USE_ID, parent_agent_id: CHILD_AGENT_ID,
			message: { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { cost_usd: 0.25 } },
		});
	}

	emitChildFailure(): void {
		this.emit({
			type: "result", uuid: "child-terminal-error", session_id: SDK_SESSION_ID,
			parent_tool_use_id: PARENT_TOOL_USE_ID, is_error: true, subtype: "error_during_execution", error: CHILD_FAILURE,
		});
	}

	/** The official history ends the real root Agent call with a safe result.
	 * This is distinct from the child terminal frame, which is not durable SDK
	 * session history and therefore cannot be the source of reload state. */
	emitRootFailureResult(): void {
		this.emit({
			type: "user", uuid: "root-agent-safe-failure", session_id: SDK_SESSION_ID,
			message: { content: [{ type: "tool_result", tool_use_id: PARENT_TOOL_USE_ID, is_error: true, content: SAFE_CHILD_FAILURE }] },
		});
	}

	[Symbol.asyncIterator](): AsyncIterator<unknown> {
		return {
			next: () => {
				if (this.closed) return Promise.resolve({ done: true, value: undefined });
				const queued = this.queued.shift();
				if (queued !== undefined) return Promise.resolve({ done: false, value: queued });
				return new Promise<IteratorResult<unknown>>((resolve) => { this.reader = resolve; });
			},
		};
	}
}

const queries: FixtureSdkQuery[] = [];
/** Official SDK history seam: reload reads the same mixed root/child history
 * that the live bridge emitted, so recovery uses the production partitioner. */
const sdkHistory: Record<string, unknown>[] = [];
test.use({
	claudeAgentSdkBridgeDepsFactory: {
		create: () => ({
			query: ((args: SdkQueryArgs) => {
				const query = new FixtureSdkQuery(args);
				queries.push(query);
				return query;
			}) as any,
			sessionAccess: {
				loadSdk: async () => ({
					getSessionInfo: async () => ({ sessionId: SDK_SESSION_ID, summary: "embedded card fixture", lastModified: 1 }),
					getSessionMessages: async () => sdkHistory.map((row) => ({ ...row })),
				}),
			},
			clock: {
				now: () => Date.now(),
				setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms),
				clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
				setInterval: (handler: () => void, ms: number) => setInterval(handler, ms),
				clearInterval: (handle: ReturnType<typeof setInterval>) => clearInterval(handle),
			},
		}),
	},
});

async function installSdkModel(): Promise<Record<string, unknown>> {
	const originalPreferences = await (await apiFetch("/api/preferences")).json() as Record<string, unknown>;
	const provider = await apiFetch("/api/custom-providers", {
		method: "POST",
		body: JSON.stringify({
			id: SDK_PROVIDER, name: SDK_PROVIDER, type: "manual", baseUrl: "http://127.0.0.1:9",
			models: [{ id: SDK_MODEL, name: "Subagent card browser" }],
		}),
	});
	expect(provider.status, await provider.text()).toBe(200);
	const preferences = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ "default.sessionModel": `${SDK_PROVIDER}/${SDK_MODEL}`, "default.sessionThinkingLevel": "off" }),
	});
	expect(preferences.ok, await preferences.text()).toBeTruthy();
	return originalPreferences;
}

async function expectNoRootChildProse(page: any): Promise<void> {
	const rootMessages = await page.evaluate(() => {
		const messages = (window as any).__bobbitState?.remoteAgent?._state?.messages ?? [];
		return JSON.stringify(messages);
	});
	expect(rootMessages).not.toContain(CHILD_TEXT);
	expect(rootMessages).not.toContain(LATE_CHILD_TEXT);
	expect(rootMessages).not.toContain(CHILD_FAILURE);
}

test.describe("Claude SDK embedded subagent card", () => {
	test("keeps SDK child lifecycle, errors, reload, and resumed frames inside the real Agent card", async ({ page }) => {
		test.setTimeout(60_000);
		queries.length = 0;
		sdkHistory.length = 0;
		const originalPreferences = await installSdkModel();
		let sessionId = "";
		try {
			sessionId = await createSession();
			await waitForSessionStatus(sessionId, "idle");
			await openApp(page);
			await navigateToHash(page, `#/session/${sessionId}`);
			const editor = page.locator("message-editor textarea").first();
			await expect(editor).toBeVisible({ timeout: 20_000 });
			await editor.fill("start embedded SDK child fixture");
			await editor.press("Enter");

			const parentCard = page.locator(`[data-subagent-parent-tool-use-id="${PARENT_TOOL_USE_ID}"]`);
			await expect(parentCard).toBeVisible({ timeout: 20_000 });
			await expect(parentCard).toContainText("Agent");
			await expect(parentCard.locator(`[data-subagent-agent-id="${CHILD_AGENT_ID}"]`)).toContainText(CHILD_TEXT);
			await expect(parentCard.locator('[data-tool-name="read"]')).toContainText("fixture read result");
			await expect(parentCard).toContainText("Working");
			await expectNoRootChildProse(page);

			// A browser reload reconstructs the same nested partition, rather than a
			// root transcript row or a second child session surface.
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			const reloadedParent = page.locator(`[data-subagent-parent-tool-use-id="${PARENT_TOOL_USE_ID}"]`);
			await expect(reloadedParent).toBeVisible({ timeout: 20_000 });
			await expect(reloadedParent.locator(`[data-subagent-agent-id="${CHILD_AGENT_ID}"]`)).toContainText(CHILD_TEXT);
			await expectNoRootChildProse(page);

			// Send a late child event through the existing query after the new socket
			// has resumed; it must update the recovered parent partition in place.
			expect(queries).toHaveLength(1);
			queries[0].emitChildText(LATE_CHILD_TEXT, "child-after-reconnect");
			await expect(reloadedParent).toContainText(LATE_CHILD_TEXT, { timeout: 20_000 });
			queries[0].emitChildFailure();
			await expect(reloadedParent.locator(`[data-subagent-agent-id="${CHILD_AGENT_ID}"]`)).toContainText("Failed");
			await expect(reloadedParent.locator('[role="alert"]')).toContainText(SAFE_CHILD_FAILURE);
			await expect(reloadedParent).not.toContainText(CHILD_FAILURE);
			await expectNoRootChildProse(page);

			// The child terminal is live-only. Persist the completed root Agent result
			// using the SDK's durable user/tool_result history shape before reload.
			queries[0].emitRootFailureResult();
			await expect(reloadedParent).toContainText(SAFE_CHILD_FAILURE);
			await expect(reloadedParent).not.toContainText(CHILD_FAILURE);
			await expectNoRootChildProse(page);

			// Reload after failure: the authoritative root result keeps the card failed
			// without deriving an unsafe child terminal from absent history.
			await page.reload({ waitUntil: "domcontentloaded" });
			await navigateToHash(page, `#/session/${sessionId}`);
			const terminalReloadedParent = page.locator(`[data-subagent-parent-tool-use-id="${PARENT_TOOL_USE_ID}"]`);
			await expect(terminalReloadedParent).toBeVisible({ timeout: 20_000 });
			await expect(terminalReloadedParent).toContainText("Failed");
			await expect(terminalReloadedParent).toContainText(SAFE_CHILD_FAILURE);
			await expect(terminalReloadedParent).not.toContainText(CHILD_FAILURE);
			await expectNoRootChildProse(page);

			// Child lifecycle never creates a Bobbit child session, sidebar row, task,
			// route, or a second standalone card outside its admitted root Agent call.
			await expect(page.locator(`[data-session-id="${CHILD_AGENT_ID}"]`)).toHaveCount(0);
			await expect(page.locator(`[data-task-id="${CHILD_AGENT_ID}"]`)).toHaveCount(0);
			await expect(page.locator(`a[href*="${CHILD_AGENT_ID}"]`)).toHaveCount(0);
			expect(await page.locator("[data-subagent-parent-tool-use-id]").count()).toBe(1);
		} finally {
			if (sessionId) await deleteSession(sessionId).catch(() => undefined);
			await apiFetch(`/api/custom-providers/${SDK_PROVIDER}`, { method: "DELETE" }).catch(() => undefined);
			await apiFetch("/api/preferences", {
				method: "PUT",
				body: JSON.stringify({
					"default.sessionModel": originalPreferences["default.sessionModel"] ?? null,
					"default.sessionThinkingLevel": originalPreferences["default.sessionThinkingLevel"] ?? null,
				}),
			}).catch(() => undefined);
		}
	});
});
