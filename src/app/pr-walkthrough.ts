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
	base?: string;
	head?: string;
	baseRef?: string;
	headRef?: string;
	baseBranch?: string;
	headBranch?: string;
	prNumber?: string | number;
	url?: string;
	prUrl?: string;
	title?: string;
	prTitle?: string;
	provider?: string;
}

export function parseWalkthroughPrCommand(input: string): OpenPrWalkthroughInput | null {
	const match = /^\/walkthrough-pr(?:\s+(.+))?$/i.exec(input.trim());
	if (!match) return null;
	const target = (match[1] || "").trim();
	if (!target) return {};
	if (/^https?:\/\//i.test(target)) {
		const metadata = prMetadataFromUrl(target);
		return { url: target, prUrl: target, ...metadata };
	}
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

function prMetadataFromUrl(value: string): Pick<OpenPrWalkthroughInput, "prNumber" | "provider"> {
	try {
		const url = new URL(value);
		const match = /\/pull\/(\d+)(?:\/|$)/i.exec(url.pathname);
		return {
			prNumber: match?.[1],
			provider: /(^|\.)github\.com$/i.test(url.hostname) ? "github" : undefined,
		};
	} catch {
		return {};
	}
}

function urlSlug(value: string): string {
	try {
		const url = new URL(value);
		return `${url.host}${url.pathname}`.replace(/\/+$/, "") || value;
	} catch {
		return value;
	}
}

function mergeSessionPrMetadata(state: AppState, input: OpenPrWalkthroughInput): OpenPrWalkthroughInput {
	const chatPanel = (state as any)?.chatPanel as Record<string, unknown> | null | undefined;
	const inputNumber = normalizePrNumber(input.prNumber);
	const panelNumber = normalizePrNumber(chatPanel?.prNumber);
	const shouldUsePanelPr = !inputNumber || !panelNumber || inputNumber === panelNumber;
	if (!shouldUsePanelPr) return input;
	return {
		...input,
		prNumber: input.prNumber ?? panelNumber,
		url: input.url ?? cleanString(chatPanel?.prUrl),
		prUrl: input.prUrl ?? cleanString(chatPanel?.prUrl),
		prTitle: input.prTitle ?? cleanString(chatPanel?.prTitle),
	};
}

function normalizeInput(state: AppState, input: OpenPrWalkthroughInput): OpenPrWalkthroughInput {
	const merged = mergeSessionPrMetadata(state, input);
	const url = cleanString(merged.url) || cleanString(merged.prUrl);
	const urlMetadata = url ? prMetadataFromUrl(url) : {};
	return {
		...merged,
		baseSha: cleanString(merged.baseSha) || cleanString(merged.base) || cleanString(merged.baseRef) || cleanString(merged.baseBranch),
		headSha: cleanString(merged.headSha) || cleanString(merged.head) || cleanString(merged.headRef) || cleanString(merged.headBranch),
		url,
		prUrl: url,
		prNumber: normalizePrNumber(merged.prNumber) || normalizePrNumber(urlMetadata.prNumber),
		prTitle: cleanString(merged.prTitle) || cleanString(merged.title),
		title: cleanString(merged.title) || cleanString(merged.prTitle),
		provider: cleanString(merged.provider) || urlMetadata.provider || (url ? "external-pr" : undefined),
	};
}

function changesetIdForInput(input: OpenPrWalkthroughInput, baseSha: string, headSha: string): string {
	const url = cleanString(input.prUrl) || cleanString(input.url);
	if (url) return `url:${urlSlug(url)}`;
	const prNumber = normalizePrNumber(input.prNumber);
	if (prNumber) return `pr:${prNumber}`;
	return `${baseSha}..${headSha}`;
}

function titleForInput(input: OpenPrWalkthroughInput): string {
	const explicit = cleanString(input.prTitle) || cleanString(input.title);
	const prNumber = normalizePrNumber(input.prNumber);
	if (explicit && prNumber && !/^PR\s+#/i.test(explicit)) return `PR #${prNumber}: ${explicit}`;
	if (explicit) return explicit;
	if (prNumber) return `PR #${prNumber} Walkthrough`;
	if (input.url || input.prUrl) return "PR Walkthrough";
	return "Changeset Walkthrough";
}

export function changesetRefForWalkthrough(input: OpenPrWalkthroughInput): PrWalkthroughChangesetRef {
	const prNumber = normalizePrNumber(input.prNumber);
	const externalUrl = cleanString(input.prUrl) || cleanString(input.url);
	return {
		baseSha: cleanString(input.baseSha) || "fixture-base",
		headSha: cleanString(input.headSha) || "fixture-head",
		provider: cleanString(input.provider) || (externalUrl ? "external-pr" : prNumber ? "pr" : undefined),
		externalUrl,
		title: titleForInput(input),
	};
}

export function prWalkthroughStandaloneHref(sessionId: string, tabId: string): string {
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	params.set("tab", tabId);
	return `#/walkthrough?${params.toString()}`;
}

export function openPrWalkthroughPanel(state: AppState, sessionId: string, rawInput: OpenPrWalkthroughInput): PanelWorkspaceTab {
	const input = normalizeInput(state, rawInput);
	const changeset = changesetRefForWalkthrough(input);
	const changesetId = changesetIdForInput(input, changeset.baseSha, changeset.headSha);
	const tabId = walkthroughPanelTabId(changesetId);
	const prNumber = normalizePrNumber(input.prNumber);
	const prUrl = cleanString(input.prUrl) || cleanString(input.url) || changeset.externalUrl;
	const prTitle = cleanString(input.prTitle) || cleanString(input.title);
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
		prUrl,
		prNumber,
		prTitle,
	};
	const tab: PanelWorkspaceTab = {
		id: tabId,
		kind: "walkthrough",
		title,
		label: "Walkthrough",
		legacyTab: "walkthrough",
		source,
		state: { changesetId, changeset, prUrl, prNumber, prTitle, baseSha: changeset.baseSha, headSha: changeset.headSha },
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
