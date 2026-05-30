import {
	panelTabsForSession,
	setActivePanelTabIdForSession,
	setPanelTabsForSession,
	walkthroughChangesetIdFromPanelTabId,
	walkthroughPanelTabId,
	type PanelWorkspaceTab,
} from "./panel-workspace.js";
import { gatewayFetch } from "./gateway-fetch.js";
import { renderApp } from "./state.js";
import type { state as appState } from "./state.js";
import type { PrWalkthroughCard, PrWalkthroughChangesetRef } from "../ui/components/pr-walkthrough/types.js";

export type AppState = typeof appState;

export type PrWalkthroughStatus = "fixture" | "loading" | "ready" | "error";

export interface WalkthroughWarning {
	code: string;
	severity: "info" | "warning" | "error";
	message: string;
	filePath?: string;
}

interface WalkthroughResolveResult {
	changesetId: string;
	changeset: PrWalkthroughChangesetRef;
	cards: PrWalkthroughCard[];
	warnings?: WalkthroughWarning[];
	limits?: unknown;
	export?: unknown;
	exportCapability?: unknown;
}

interface WalkthroughApiError extends Error {
	status?: number;
	body?: unknown;
	plainText?: string;
	missingRoute?: boolean;
}

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
	filesChanged?: number;
	additions?: number;
	deletions?: number;
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

function finiteNonNegativeNumber(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.trunc(value));
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
		filesChanged: finiteNonNegativeNumber(merged.filesChanged),
		additions: finiteNonNegativeNumber(merged.additions),
		deletions: finiteNonNegativeNumber(merged.deletions),
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

function labelForPrNumber(value: unknown): string | undefined {
	const prNumber = normalizePrNumber(value);
	return prNumber ? `PR: #${prNumber}` : undefined;
}

function labelForInput(input: OpenPrWalkthroughInput): string {
	return labelForPrNumber(input.prNumber) || (input.url || input.prUrl ? "PR" : "Walkthrough");
}

export function changesetRefForWalkthrough(input: OpenPrWalkthroughInput): PrWalkthroughChangesetRef {
	const prNumber = normalizePrNumber(input.prNumber);
	const externalUrl = cleanString(input.prUrl) || cleanString(input.url);
	return {
		baseSha: cleanString(input.baseSha) || "fixture-base",
		headSha: cleanString(input.headSha) || "fixture-head",
		provider: cleanString(input.provider) || (externalUrl ? "external-pr" : prNumber ? "pr" : undefined),
		externalUrl,
		prUrl: externalUrl,
		prNumber,
		prTitle: cleanString(input.prTitle),
		title: titleForInput(input),
		filesChanged: finiteNonNegativeNumber(input.filesChanged),
		additions: finiteNonNegativeNumber(input.additions),
		deletions: finiteNonNegativeNumber(input.deletions),
	};
}

export function prWalkthroughStandaloneHref(sessionId: string, tabId: string): string {
	const params = new URLSearchParams();
	if (sessionId) params.set("session", sessionId);
	params.set("tab", tabId);
	return `/walkthrough?${params.toString()}`;
}

function shouldResolveInput(input: OpenPrWalkthroughInput): boolean {
	return Boolean(cleanString(input.prUrl) || cleanString(input.url) || normalizePrNumber(input.prNumber) || (cleanString(input.baseSha) && cleanString(input.headSha)));
}

function resolveRequestForInput(sessionId: string, input: OpenPrWalkthroughInput): Record<string, unknown> {
	const prUrl = cleanString(input.prUrl) || cleanString(input.url);
	const prNumber = normalizePrNumber(input.prNumber);
	const provider = cleanString(input.provider);
	const shouldUseGithubPrDiff = Boolean(prUrl || prNumber || provider === "github" || provider === "external-pr");
	return {
		sessionId: sessionId || undefined,
		// PR walkthroughs should resolve through the GitHub PR API by default so the
		// diff matches GitHub's PR view, including already-merged PRs. Local refs are
		// only sent for explicit local changeset walkthroughs.
		baseSha: shouldUseGithubPrDiff ? undefined : cleanString(input.baseSha),
		headSha: shouldUseGithubPrDiff ? undefined : cleanString(input.headSha),
		prUrl,
		prNumber,
		prTitle: cleanString(input.prTitle),
		title: cleanString(input.title),
		provider,
		fixture: !shouldResolveInput(input) || undefined,
	};
}

function isResolveResult(value: unknown): value is WalkthroughResolveResult {
	const result = value as Partial<WalkthroughResolveResult> | null;
	return Boolean(result && typeof result === "object" && typeof result.changesetId === "string" && result.changeset && typeof result.changeset === "object" && Array.isArray(result.cards));
}

async function readJsonOrText(response: Response): Promise<{ body: unknown; text: string }> {
	const text = await response.text().catch(() => "");
	if (!text) return { body: undefined, text };
	try {
		return { body: JSON.parse(text), text };
	} catch {
		return { body: undefined, text };
	}
}

function errorMessageFromBody(body: unknown, fallback: string): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		for (const key of ["message", "error", "detail"]) {
			const value = record[key];
			if (typeof value === "string" && value.trim()) return value.trim();
		}
	}
	return fallback;
}

async function fetchWalkthroughJson(path: string, options?: RequestInit): Promise<unknown> {
	const response = await gatewayFetch(path, options);
	const contentType = response.headers.get("content-type") || "";
	const { body, text } = await readJsonOrText(response);
	if (!response.ok) {
		const err = new Error(errorMessageFromBody(body, text || `Request failed with ${response.status}`)) as WalkthroughApiError;
		err.status = response.status;
		err.body = body;
		err.plainText = text;
		err.missingRoute = response.status === 404 && !contentType.includes("application/json") && /^not found$/i.test(text.trim());
		throw err;
	}
	return body;
}

function patchWalkthroughTab(
	state: AppState,
	sessionId: string,
	tabId: string,
	patch: Record<string, unknown>,
	result?: WalkthroughResolveResult,
): string {
	const canonicalChangesetId = typeof patch.changesetId === "string" && patch.changesetId ? patch.changesetId : undefined;
	const nextTabId = canonicalChangesetId ? walkthroughPanelTabId(canonicalChangesetId) : tabId;
	let updatedTabId = tabId;
	let replaced = false;
	const tabs = panelTabsForSession(state, sessionId);
	const nextTabs = tabs.map((tab) => {
		if (tab.id !== tabId && tab.id !== nextTabId) return tab;
		if (tab.id === nextTabId && tab.id !== tabId) return tab;
		replaced = true;
		updatedTabId = nextTabId;
		const source = (tab.source || {}) as Record<string, unknown>;
		const tabState = (tab.state || {}) as Record<string, unknown>;
		const changeset = result?.changeset || (patch.changeset as PrWalkthroughChangesetRef | undefined) || (tabState.changeset as PrWalkthroughChangesetRef | undefined);
		const title = changeset?.title || (typeof patch.title === "string" ? patch.title : undefined) || tab.title;
		return {
			...tab,
			id: nextTabId,
			title,
			label: labelForPrNumber(changeset?.prNumber) || tab.label || "Walkthrough",
			source: {
				...source,
				type: "walkthrough",
				sessionId,
				...(canonicalChangesetId ? { changesetId: canonicalChangesetId } : {}),
				...(changeset ? {
					title,
					baseSha: changeset.baseSha,
					headSha: changeset.headSha,
					provider: changeset.provider,
					externalUrl: changeset.externalUrl,
					prUrl: changeset.prUrl || changeset.externalUrl,
					prNumber: changeset.prNumber,
					prTitle: changeset.prTitle,
					filesChanged: changeset.filesChanged,
					additions: changeset.additions,
					deletions: changeset.deletions,
				} : {}),
			} as PanelWorkspaceTab["source"],
			state: { ...tabState, ...patch },
		} as PanelWorkspaceTab;
	});

	const deduped = nextTabId !== tabId ? nextTabs.filter((tab, index, all) => tab.id !== nextTabId || all.findIndex((candidate) => candidate.id === nextTabId) === index) : nextTabs;
	if (replaced) {
		setPanelTabsForSession(state, sessionId, deduped);
		if (nextTabId !== tabId) setActivePanelTabIdForSession(state, sessionId, nextTabId);
	}
	return updatedTabId;
}

export async function resolvePrWalkthrough(state: AppState, sessionId: string, tabId: string, input: OpenPrWalkthroughInput): Promise<void> {
	try {
		const data = await fetchWalkthroughJson("/api/pr-walkthrough/resolve", {
			method: "POST",
			body: JSON.stringify(resolveRequestForInput(sessionId, input)),
		});
		if (!isResolveResult(data)) throw new Error("PR walkthrough resolver returned an invalid response");
		patchWalkthroughTab(state, sessionId, tabId, {
			status: "ready",
			changesetId: data.changesetId,
			changeset: data.changeset,
			cards: data.cards,
			warnings: data.warnings || [],
			limits: data.limits,
			exportCapability: data.exportCapability ?? data.export,
		}, data);
	} catch (error) {
		const err = error as WalkthroughApiError;
		patchWalkthroughTab(state, sessionId, tabId, err.missingRoute
			? {
				status: "fixture",
				warnings: [{ code: "resolver_unavailable", severity: "info", message: "Using fixture walkthrough because the resolver API is unavailable." }],
			}
			: {
				status: "error",
				error: err.message || "Failed to resolve PR walkthrough",
				warnings: [],
			});
	} finally {
		renderApp();
	}
}

const restoreInFlight = new Set<string>();

export function restorePrWalkthroughPanel(state: AppState, sessionId: string, tabId: string): void {
	const tabs = panelTabsForSession(state, sessionId);
	const tab = tabs.find((candidate) => candidate.id === tabId);
	if (!tab || tab.kind !== "walkthrough") return;
	const tabState = (tab.state || {}) as Record<string, unknown>;
	if (Array.isArray(tabState.cards) || tabState.status === "loading") return;
	const changesetId = typeof tabState.changesetId === "string" && tabState.changesetId
		? tabState.changesetId
		: walkthroughChangesetIdFromPanelTabId(tab.id);
	if (!changesetId || changesetId === "fixture") return;
	const key = `${sessionId}:${tab.id}:${changesetId}`;
	if (restoreInFlight.has(key)) return;
	restoreInFlight.add(key);
	patchWalkthroughTab(state, sessionId, tab.id, { status: "loading" });
	renderApp();
	void fetchWalkthroughJson(`/api/pr-walkthrough/${encodeURIComponent(changesetId)}`)
		.then((data) => {
			if (!isResolveResult(data)) throw new Error("PR walkthrough store returned an invalid response");
			patchWalkthroughTab(state, sessionId, tab.id, {
				status: "ready",
				changesetId: data.changesetId,
				changeset: data.changeset,
				cards: data.cards,
				warnings: data.warnings || [],
				limits: data.limits,
				exportCapability: data.exportCapability ?? data.export,
			}, data);
		})
		.catch((error: WalkthroughApiError) => {
			patchWalkthroughTab(state, sessionId, tab.id, {
				status: error.missingRoute ? "fixture" : "error",
				error: error.missingRoute ? undefined : error.message || "Failed to restore PR walkthrough",
				warnings: error.missingRoute ? [{ code: "resolver_unavailable", severity: "info", message: "Using fixture walkthrough because the resolver API is unavailable." }] : [],
			});
		})
		.finally(() => {
			restoreInFlight.delete(key);
			renderApp();
		});
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
	const shouldResolve = shouldResolveInput(input);
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
		filesChanged: changeset.filesChanged,
		additions: changeset.additions,
		deletions: changeset.deletions,
	};
	const tab: PanelWorkspaceTab = {
		id: tabId,
		kind: "walkthrough",
		title,
		label: labelForInput(input),
		legacyTab: "walkthrough",
		source,
		state: {
			status: shouldResolve ? "loading" : "fixture",
			changesetId,
			changeset,
			warnings: [],
			prUrl,
			prNumber,
			prTitle,
			baseSha: changeset.baseSha,
			headSha: changeset.headSha,
			filesChanged: changeset.filesChanged,
			additions: changeset.additions,
			deletions: changeset.deletions,
		},
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
	if (shouldResolve) void resolvePrWalkthrough(state, sessionId, tabId, input);
	return tab;
}
