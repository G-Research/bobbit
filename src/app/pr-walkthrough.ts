import {
	panelTabsForSession,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	walkthroughPanelTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import type { state as appState } from "./state.js";
import type { PrWalkthroughChangesetRef } from "../ui/components/pr-walkthrough/index.js";

export type AppState = typeof appState;

export interface OpenPrWalkthroughInput {
	baseSha?: string;
	headSha?: string;
	prNumber?: string | number;
	url?: string;
	title?: string;
	provider?: string;
}

export function parseWalkthroughPrCommand(input: string): OpenPrWalkthroughInput | null {
	const match = /^\/walkthrough-pr(?:\s+(.+))?$/i.exec(input.trim());
	if (!match) return null;
	const target = (match[1] || "").trim();
	if (!target) return {};
	if (/^https?:\/\//i.test(target)) return { url: target };
	return { prNumber: target.replace(/^#/, "") };
}

function cleanString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePrNumber(value: unknown): string | undefined {
	const raw = typeof value === "number" ? String(Math.trunc(value)) : cleanString(value);
	if (!raw) return undefined;
	const normalized = raw.replace(/^#/, "").trim();
	return normalized || undefined;
}

function urlSlug(value: string): string {
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname}`.replace(/\/+$/, "") || value;
	} catch {
		return value;
	}
}

function changesetIdForInput(input: OpenPrWalkthroughInput, baseSha: string, headSha: string): string {
	const url = cleanString(input.url);
	if (url) return `url:${urlSlug(url)}`;
	const prNumber = normalizePrNumber(input.prNumber);
	if (prNumber) return `pr:${prNumber}`;
	return `${baseSha}..${headSha}`;
}

function titleForInput(input: OpenPrWalkthroughInput): string {
	const explicit = cleanString(input.title);
	if (explicit) return explicit;
	const prNumber = normalizePrNumber(input.prNumber);
	if (prNumber) return `PR #${prNumber} Walkthrough`;
	if (input.url) return "PR Walkthrough";
	return "Changeset Walkthrough";
}

export function changesetRefForWalkthrough(input: OpenPrWalkthroughInput): PrWalkthroughChangesetRef {
	const prNumber = normalizePrNumber(input.prNumber);
	const externalUrl = cleanString(input.url);
	return {
		baseSha: cleanString(input.baseSha) || "fixture-base",
		headSha: cleanString(input.headSha) || "fixture-head",
		provider: cleanString(input.provider) || (externalUrl ? "external-pr" : prNumber ? "pr" : undefined),
		externalUrl,
		title: titleForInput(input),
	};
}

export function openPrWalkthroughPanel(state: AppState, sessionId: string, input: OpenPrWalkthroughInput): PanelWorkspaceTab {
	const changeset = changesetRefForWalkthrough(input);
	const changesetId = changesetIdForInput(input, changeset.baseSha, changeset.headSha);
	const tabId = walkthroughPanelTabId(changesetId);
	const prNumber = normalizePrNumber(input.prNumber);
	const title = changeset.title || titleForInput(input);
	const source = {
		type: "walkthrough" as const,
		sessionId,
		changesetId,
		title,
		baseSha: changeset.baseSha,
		headSha: changeset.headSha,
		provider: changeset.provider,
		externalUrl: changeset.externalUrl,
		prNumber,
	};
	const tab: PanelWorkspaceTab = {
		id: tabId,
		kind: "walkthrough",
		title,
		label: "Walkthrough",
		legacyTab: "walkthrough",
		source,
		state: { changesetId, changeset },
	};

	const existing = panelTabsForSession(state, sessionId);
	const next = existing.some((candidate) => candidate.id === tabId)
		? existing.map((candidate) => candidate.id === tabId
			? {
				...candidate,
				...tab,
				source: { ...(candidate.source as Record<string, unknown>), ...source } as PanelWorkspaceTab["source"],
				state: { ...(candidate.state || {}), ...(tab.state || {}) },
			}
			: candidate)
		: [...existing, tab];

	setPanelTabsForSession(state, sessionId, next);
	setActivePanelTabIdForSession(state, sessionId, tabId);
	(state as any).previewPanelTab = "walkthrough";
	(state as any).previewPanelActiveTab = "walkthrough";
	if ((state as any).assistantType) (state as any).assistantTab = "preview";
	return tab;
}
