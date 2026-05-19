/**
 * Reproducer: compacted transcripts must not make the footer/session stats cost drop.
 *
 * The server already has cumulative CostTracker data, but a post-compaction
 * messages snapshot contains only the reduced visible transcript. The UI must
 * keep using the persisted cumulative cost, not the reduced visible-message sum.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, createSession, deleteSession, waitForSessionStatus } from "../e2e-setup.js";
import { openApp } from "./ui-helpers.js";

const BUG_MARKER = "COMPACT_COST_PERSISTED_COST_BUG";

function formatCost(cost: number): string {
	if (cost < 1) return `$${cost.toFixed(1).replace(/\.0$/, "")}`;
	return `$${Math.round(cost)}`;
}

function assistantMessage(id: string, text: string, cost: number, totalTokens: number) {
	return {
		id,
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: Math.max(0, totalTokens - 100),
			output: Math.min(100, totalTokens),
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: {
				input: cost / 2,
				output: cost / 2,
				cacheRead: 0,
				cacheWrite: 0,
				total: cost,
			},
		},
	};
}

function sumVisibleAssistantCost(messages: any[]): number {
	const total = messages
		.filter((msg) => msg?.role === "assistant")
		.reduce((sum, msg) => sum + (typeof msg?.usage?.cost?.total === "number" ? msg.usage.cost.total : 0), 0);
	return Math.round(total * 1_000_000) / 1_000_000;
}

async function setMockTranscript(gateway: any, sessionId: string, messages: any[]) {
	const session = gateway.sessionManager?.getSession(sessionId);
	if (!session) throw new Error(`session ${sessionId} not found`);
	const mockAgent = session.rpcClient?._agent;
	if (!mockAgent || !Array.isArray(mockAgent.conversationMessages)) {
		throw new Error("expected in-process mock agent with conversationMessages");
	}
	mockAgent.conversationMessages = messages;
	return session;
}

async function readCostSnapshot(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const agentInterface = document.querySelector("agent-interface");
		const text = agentInterface?.textContent ?? "";
		const dollarTexts = text.match(/\$\d+(?:\.\d+)?/g) ?? [];
		const remote = (window as any).__bobbitState?.remoteAgent;
		const messages = remote?.state?.messages ?? [];
		const visibleCost = messages
			.filter((msg: any) => msg?.role === "assistant")
			.reduce((sum: number, msg: any) => sum + (typeof msg?.usage?.cost?.total === "number" ? msg.usage.cost.total : 0), 0);
		return {
			footerCost: dollarTexts[dollarTexts.length - 1] ?? "",
			dollarTexts,
			messageCount: messages.length,
			visibleCost: Math.round(visibleCost * 1_000_000) / 1_000_000,
			serverCost: remote?.state?.serverCost ?? null,
		};
	});
}

async function readContextPopoverTotalCost(page: import("@playwright/test").Page): Promise<string> {
	return page.evaluate(() => {
		const popover = document.querySelector("agent-interface .context-popover");
		if (!popover) return "";
		const label = Array.from(popover.querySelectorAll("span"))
			.find((span) => span.textContent?.trim() === "Total cost");
		return label?.nextElementSibling?.textContent?.trim() ?? "";
	});
}

test.describe("Compact cost regression", () => {
	test(`${BUG_MARKER}: footer and session stats keep persisted cumulative cost after compaction-like snapshot shrink`, async ({ page, gateway }) => {
		const sessionId = await createSession();
		try {
			await waitForSessionStatus(sessionId, "idle");

			const persistedTotal = 2.5;
			const fullTranscript = [
				{ id: "u1", role: "user", content: [{ type: "text", text: "first" }] },
				assistantMessage("a1", "first assistant turn", 1.2, 48_000),
				{ id: "u2", role: "user", content: [{ type: "text", text: "second" }] },
				assistantMessage("a2", "second assistant turn", 1.3, 52_000),
			];
			const compactedTranscript = [
				{ id: "u3", role: "user", content: [{ type: "text", text: "after compaction" }] },
				assistantMessage("a3", "post-compaction visible assistant turn", 0.4, 18_000),
			];

			const liveSession = await setMockTranscript(gateway, sessionId, fullTranscript);
			const projectId = liveSession.projectId;
			const persisted = gateway.sessionManager.getCostTracker(projectId).recordUsage(sessionId, {
				inputTokens: 9_000,
				outputTokens: 1_000,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				cost: persistedTotal,
			});
			expect(persisted.totalCost, `${BUG_MARKER}: test setup should seed persisted cumulative cost`).toBe(persistedTotal);

			await openApp(page);
			await page.evaluate((id) => { window.location.hash = `#/session/${id}`; }, sessionId);
			await expect(page.locator("textarea").first()).toBeVisible({ timeout: 15_000 });

			// Ensure the real model/context state is present so the stats popover can open.
			await page.evaluate(() => (window as any).__bobbitState.remoteAgent.send({ type: "get_state" }));
			await expect.poll(async () => (await readCostSnapshot(page)).messageCount, {
				message: `${BUG_MARKER}: full transcript should hydrate before compaction simulation`,
				timeout: 10_000,
			}).toBe(fullTranscript.length);

			const before = await readCostSnapshot(page);
			expect(before.footerCost, `${BUG_MARKER}: baseline full transcript should display cumulative cost`).toBe(formatCost(persistedTotal));

			const sessionForRefresh = await setMockTranscript(gateway, sessionId, compactedTranscript);
			await gateway.sessionManager.refreshAfterCompaction(sessionForRefresh);

			await expect.poll(async () => (await readCostSnapshot(page)).messageCount, {
				message: `${BUG_MARKER}: compacted transcript snapshot should replace visible messages`,
				timeout: 10_000,
			}).toBe(compactedTranscript.length);

			const after = await readCostSnapshot(page);
			await expect(page.locator('agent-interface span[title^="Context:"]').first()).toBeVisible({ timeout: 10_000 });
			await page.locator('agent-interface span[title^="Context:"]').first().click();
			await expect(page.locator("agent-interface .context-popover")).toBeVisible({ timeout: 5_000 });
			const contextTotalCost = await readContextPopoverTotalCost(page);

			const apiCostResp = await apiFetch(`/api/sessions/${sessionId}/cost`);
			expect(apiCostResp.ok, `${BUG_MARKER}: test setup should expose persisted cost through the session cost API`).toBe(true);
			const apiCost = await apiCostResp.json();

			const result = {
				persistedApiCost: apiCost.totalCost,
				persistedApiCostText: formatCost(apiCost.totalCost),
				fullVisibleCost: sumVisibleAssistantCost(fullTranscript),
				compactedVisibleCost: sumVisibleAssistantCost(compactedTranscript),
				beforeFooterCost: before.footerCost,
				afterFooterCost: after.footerCost,
				contextPopoverTotalCost: contextTotalCost,
				afterServerCost: after.serverCost?.totalCost ?? null,
			};

			expect(result,
				`${BUG_MARKER}: persisted cumulative cost must win after a compaction-like messages snapshot shrink; ` +
				`the footer/session stats must not fall back to the reduced visible transcript cost.`
			).toMatchObject({
				persistedApiCost: persistedTotal,
				persistedApiCostText: formatCost(persistedTotal),
				fullVisibleCost: persistedTotal,
				compactedVisibleCost: 0.4,
				beforeFooterCost: formatCost(persistedTotal),
				afterFooterCost: formatCost(persistedTotal),
				contextPopoverTotalCost: formatCost(persistedTotal),
			});
		} finally {
			await deleteSession(sessionId).catch(() => {});
		}
	});
});
