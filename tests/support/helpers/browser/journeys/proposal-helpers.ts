/** Shared browser-journey helpers for proposal draft setup and synchronization. */
import type { Page } from "@playwright/test";
import { apiFetch, expect } from "./journey-fixture.js";

export async function authenticateMockProposalTools(
	page: Page,
	gateway: any,
): Promise<void> {
	const sessionId = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId as string | undefined;
	});
	const agent = sessionId ? gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent : undefined;
	if (!agent || typeof agent._gatewayPost !== "function") {
		throw new Error("proposal journey requires the in-process mock agent gateway adapter");
	}
	const sessionSecret = agent.env?.BOBBIT_SESSION_SECRET;
	if (typeof sessionSecret !== "string" || !sessionSecret) {
		throw new Error("proposal journey mock session is missing its owner capability");
	}
	const gatewayPost = agent._gatewayPost.bind(agent);
	agent._gatewayPost = (pathname: string, body: unknown, headers: Record<string, string> = {}) => gatewayPost(
		pathname,
		body,
		{ ...headers, "X-Bobbit-Session-Secret": sessionSecret },
	);
}

export async function holdProposalStream(
	page: Page,
	gateway: any,
	type: string,
): Promise<{ entered: Promise<unknown>; release: () => void }> {
	const sessionId = await page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		return state?.selectedSessionId as string | undefined;
	});
	const core = sessionId ? gateway.sessionManager?.getSession(sessionId)?.rpcClient?._agent : undefined;
	if (!core || typeof core.armBarrier !== "function" || typeof core.waitForBarrier !== "function") {
		throw new Error("proposal journey requires the in-process mock agent barrier seam");
	}
	const boundary = `proposal-stream:${type}:intermediate-delta`;
	core.armBarrier(boundary);
	const entered = Promise.resolve(core.waitForBarrier(boundary)).then((details: any) => {
		if (details?.proposalType !== type || details?.delta !== 1 || typeof details?.toolId !== "string") {
			throw new Error(`proposal stream reached an uncorrelated intermediate barrier: ${JSON.stringify(details)}`);
		}
		return details;
	});
	return {
		entered,
		release: () => { core.releaseBarrier(boundary); },
	};
}

export async function waitForProposalSlot(page: Page, type: string): Promise<void> {
	await page.waitForFunction(
		(t: string) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			const fields = state?.activeProposals?.[t]?.fields;
			return fields && typeof fields === "object" && Object.keys(fields).length > 0;
		},
		type,
		{ timeout: 20_000 },
	);
}

export async function setSubgoalsEnabledPreference(value: boolean): Promise<void> {
	const response = await apiFetch("/api/preferences", {
		method: "PUT",
		body: JSON.stringify({ subgoalsEnabled: value }),
	});
	expect(response.status).toBe(200);
}

export async function seedGoalProposal(
	page: Page,
	sessionId: string,
	args: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
	return page.evaluate(async ({ sid, candidate }) => {
		const response = await fetch(`/api/sessions/${encodeURIComponent(sid)}/proposal/goal/seed`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ args: candidate }),
		});
		return { status: response.status, body: await response.json().catch(() => null) };
	}, { sid: sessionId, candidate: args });
}

export async function waitForGoalProposal(
	page: Page,
	title: string,
): Promise<{ rev: number; fields: Record<string, unknown> }> {
	await page.waitForFunction(
		(expectedTitle: string) => {
			const state = (window as any).bobbitState ?? (window as any).__bobbitState;
			return state?.activeProposals?.goal?.fields?.title === expectedTitle;
		},
		title,
		{ timeout: 20_000 },
	);
	return page.evaluate(() => {
		const state = (window as any).bobbitState ?? (window as any).__bobbitState;
		const slot = state.activeProposals.goal;
		return { rev: slot.rev, fields: { ...slot.fields } };
	});
}
