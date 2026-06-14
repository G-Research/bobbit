import { gatewayFetch } from "./gateway-fetch.js";
import { legacyReviewDocumentIdFromTitle, rememberReviewDocumentIdentity, reviewPanelTabId } from "./panel-workspace.js";
import { selectReviewWorkspaceTab } from "./preview-panel.js";
import { closeSidePanelTab, getSidePanelWorkspace } from "./side-panel-workspace.js";
import {
	activeSessionId,
	renderApp,
	state,
	type ReviewDecisionPayload,
	type ReviewDocumentModel,
	type ReviewInlineCommentPayload,
	type ReviewSource,
} from "./state.js";
import {
	clearAnnotations,
	flushPendingWrites,
	getAnnotations,
	markReviewSubmitted,
} from "../ui/components/review/AnnotationStore.js";

const REVIEW_CONTEXT_STORAGE_PREFIX = "bobbit-review-contexts-v1:";

declare module "./state.js" {
	interface ReviewDocumentModel {
		documentId?: string;
	}
}

export interface OpenMarkdownReviewDocumentOptions {
	title: string;
	markdown: string;
	documentId?: string;
	replace?: boolean;
	sessionId?: string;
}

export interface OpenReviewDocumentOptions extends OpenMarkdownReviewDocumentOptions {
	source?: ReviewSource;
}

export interface SubmitReviewDecisionOptions {
	sessionId?: string;
	prompt?: (feedback: string) => void | Promise<void>;
}

function storageKey(sessionId: string): string {
	return `${REVIEW_CONTEXT_STORAGE_PREFIX}${sessionId}`;
}

function safeReadPersisted(sessionId: string): Record<string, ReviewDocumentModel> {
	if (!sessionId || typeof localStorage === "undefined") return {};
	try {
		const raw = localStorage.getItem(storageKey(sessionId));
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, ReviewDocumentModel>
			: {};
	} catch {
		return {};
	}
}

function safeWritePersisted(sessionId: string, docs: Record<string, ReviewDocumentModel>): void {
	if (!sessionId || typeof localStorage === "undefined") return;
	try {
		const key = storageKey(sessionId);
		if (Object.keys(docs).length === 0) localStorage.removeItem(key);
		else localStorage.setItem(key, JSON.stringify(docs));
	} catch { /* localStorage may be unavailable/full */ }
}

function shouldPersistReviewDocument(doc: ReviewDocumentModel): boolean {
	return doc.source?.kind === "verification-signoff-markdown" || doc.source?.kind === "verification-signoff-pr";
}

let generatedReviewDocumentCounter = 0;

function safeDocumentIdPart(value: string): string {
	return encodeURIComponent(value || "no-session").replace(/%/g, "_").slice(0, 80) || "no-session";
}

function normalizeDocumentId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 160 || /[\u0000-\u001f\u007f]/.test(trimmed)) return undefined;
	return trimmed;
}

function newReviewDocumentId(sessionId: string): string {
	generatedReviewDocumentCounter += 1;
	return `review-doc:${safeDocumentIdPart(sessionId)}:${Date.now().toString(36)}-${generatedReviewDocumentCounter.toString(36)}`;
}

function documentIdFromReviewTabId(tabId: string): string | undefined {
	if (!tabId.startsWith("review:")) return undefined;
	try { return normalizeDocumentId(decodeURIComponent(tabId.slice("review:".length))); }
	catch { return undefined; }
}

function reviewDocumentIdForOpen(options: OpenReviewDocumentOptions, title: string, sessionId: string): string {
	const explicit = normalizeDocumentId(options.documentId);
	if (explicit) return explicit;
	const existing = state.reviewDocuments instanceof Map ? state.reviewDocuments.get(title) : undefined;
	const existingId = normalizeDocumentId(existing?.documentId);
	if (existing) return existingId || legacyReviewDocumentIdFromTitle(title);
	const matchingWorkspaceTab = getSidePanelWorkspace(sessionId).tabs.find((tab) => {
		if (tab.kind !== "review") return false;
		const source = tab.source as Record<string, unknown> | undefined;
		const tabTitle = typeof source?.title === "string" ? source.title : tab.title.replace(/^Review:\s*/, "");
		return tabTitle === title;
	});
	const workspaceId = normalizeDocumentId((matchingWorkspaceTab?.source as Record<string, unknown> | undefined)?.documentId)
		|| (matchingWorkspaceTab ? documentIdFromReviewTabId(matchingWorkspaceTab.id) : undefined);
	if (workspaceId) return workspaceId;
	return newReviewDocumentId(sessionId);
}

export function persistReviewDocument(sessionId: string, doc: ReviewDocumentModel): void {
	if (!shouldPersistReviewDocument(doc)) return;
	const docs = safeReadPersisted(sessionId);
	docs[doc.documentId || doc.title] = doc;
	safeWritePersisted(sessionId, docs);
}

export function removePersistedReviewDocument(sessionId: string, title: string): void {
	const docs = safeReadPersisted(sessionId);
	let changed = false;
	for (const [key, doc] of Object.entries(docs)) {
		if (key === title || doc?.title === title || doc?.documentId === title) {
			delete docs[key];
			changed = true;
		}
	}
	if (!changed) return;
	safeWritePersisted(sessionId, docs);
}

export function clearPersistedReviewDocuments(sessionId: string): void {
	safeWritePersisted(sessionId, {});
}

function sourceWithDefault(source: ReviewSource | undefined, sessionId: string): ReviewSource {
	return source || { kind: "markdown-review", sessionId };
}

function signoffTitle(source: ReviewSource): string {
	if (source.kind !== "verification-signoff-markdown" && source.kind !== "verification-signoff-pr") return "Review";
	const goal = source.goalTitle || source.goalId;
	const gate = source.gateName || source.gateId;
	const step = source.stepLabel || source.stepName;
	return `Sign-off: ${goal} / ${gate} / ${step}`;
}

function normalizeReviewSource(value: unknown): ReviewSource | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const source = value as Record<string, unknown>;
	const kind = source.kind;
	if (kind === "markdown-review" && typeof source.sessionId === "string") {
		return { kind, sessionId: source.sessionId };
	}
	if (kind === "verification-signoff-markdown") {
		if (typeof source.goalId !== "string" || typeof source.gateId !== "string" || typeof source.signalId !== "string" || typeof source.stepName !== "string") return undefined;
		return {
			kind,
			goalId: source.goalId,
			gateId: source.gateId,
			signalId: source.signalId,
			stepName: source.stepName,
			goalTitle: typeof source.goalTitle === "string" ? source.goalTitle : undefined,
			gateName: typeof source.gateName === "string" ? source.gateName : undefined,
			stepLabel: typeof source.stepLabel === "string" ? source.stepLabel : undefined,
		};
	}
	if (kind === "verification-signoff-pr") {
		if (typeof source.goalId !== "string" || typeof source.gateId !== "string" || typeof source.signalId !== "string" || typeof source.stepName !== "string" || typeof source.prUrl !== "string") return undefined;
		return {
			kind,
			goalId: source.goalId,
			gateId: source.gateId,
			signalId: source.signalId,
			stepName: source.stepName,
			prUrl: source.prUrl,
			goalTitle: typeof source.goalTitle === "string" ? source.goalTitle : undefined,
			gateName: typeof source.gateName === "string" ? source.gateName : undefined,
			stepLabel: typeof source.stepLabel === "string" ? source.stepLabel : undefined,
		};
	}
	return undefined;
}

export function openMarkdownReviewDocument(options: OpenMarkdownReviewDocumentOptions): ReviewDocumentModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	return openReviewDocument({
		...options,
		sessionId,
		source: { kind: "markdown-review", sessionId },
	});
}

export function openReviewDocument(options: OpenReviewDocumentOptions): ReviewDocumentModel {
	const sessionId = options.sessionId || activeSessionId() || "";
	const source = sourceWithDefault(options.source, sessionId);
	const title = options.title || signoffTitle(source);
	const documentId = reviewDocumentIdForOpen(options, title, sessionId);
	const doc: ReviewDocumentModel = { title, markdown: options.markdown, source, documentId };
	state.reviewDocuments = new Map(state.reviewDocuments);
	if (options.replace !== false || !state.reviewDocuments.has(title)) {
		state.reviewDocuments.set(title, doc);
	}
	const storedDoc = state.reviewDocuments.get(title) || doc;
	if (!storedDoc.documentId) storedDoc.documentId = documentId;
	rememberReviewDocumentIdentity(title, storedDoc.documentId);
	state.reviewPanelOpen = true;
	state.reviewActiveTab = title;
	state.previewPanelActiveTab = "review";
	state.previewPanelTab = "review";
	selectReviewWorkspaceTab(title, { sessionId, select: true });
	if (options.replace !== false) {
		for (const tab of getSidePanelWorkspace(sessionId).tabs) {
			if (tab.kind !== "review" || tab.id === reviewPanelTabId(storedDoc.documentId || documentId)) continue;
			const source = tab.source as Record<string, unknown> | undefined;
			const tabTitle = typeof source?.title === "string" ? source.title : tab.title.replace(/^Review:\s*/, "");
			if (tabTitle === title) void closeSidePanelTab(tab.id, { sessionId });
		}
	}
	if (sessionId) {
		persistReviewDocument(sessionId, storedDoc);
	}
	renderApp();
	return storedDoc;
}

export function openReviewDocumentFromEvent(detail: unknown, sessionId = activeSessionId() || ""): ReviewDocumentModel | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
	const record = detail as Record<string, unknown>;
	const source = normalizeReviewSource(record.source);
	const markdown = typeof record.markdown === "string" ? record.markdown : "";
	if (!markdown && source?.kind !== "verification-signoff-pr") return undefined;
	const title = typeof record.title === "string" && record.title.trim()
		? record.title.trim()
		: source ? signoffTitle(source) : "Review";
	const replace = typeof record.replace === "boolean" ? record.replace : true;
	const documentId = normalizeDocumentId(record.documentId);
	return openReviewDocument({ title, markdown, source, documentId, replace, sessionId });
}

export function restorePersistedReviewDocuments(sessionId: string, _options: { select?: boolean } = {}): void {
	const docs = safeReadPersisted(sessionId);
	const entries = Object.values(docs).filter((doc) => doc?.title && typeof doc.markdown === "string" && shouldPersistReviewDocument(doc));
	if (entries.length === 0) return;
	state.reviewDocuments = new Map(state.reviewDocuments);
	let firstTitle = "";
	for (const doc of entries) {
		if (!firstTitle) firstTitle = doc.title;
		if (!doc.documentId) doc.documentId = legacyReviewDocumentIdFromTitle(doc.title);
		rememberReviewDocumentIdentity(doc.title, doc.documentId);
		if (!state.reviewDocuments.has(doc.title)) state.reviewDocuments.set(doc.title, doc);
	}
	state.reviewPanelOpen = state.reviewDocuments.size > 0;
	if (!state.reviewActiveTab && firstTitle) state.reviewActiveTab = firstTitle;
	renderApp();
}

function reviewWorkspaceTabMatchesTitle(tab: unknown, title: string): boolean {
	if (!tab || typeof tab !== "object") return false;
	const record = tab as Record<string, unknown>;
	if (record.kind !== "review") return false;
	const source = record.source && typeof record.source === "object" && !Array.isArray(record.source)
		? record.source as Record<string, unknown>
		: undefined;
	const tabTitle = typeof source?.title === "string" ? source.title
		: typeof record.title === "string" ? record.title.replace(/^Review:\s*/, "")
		: "";
	return tabTitle === title;
}

async function deleteReviewWorkspaceTabsFromServer(sessionId: string, title: string): Promise<void> {
	if (!sessionId) return;
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const response = await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/side-panel-workspace`).catch(() => null);
		if (!response?.ok) return;
		const workspace = await response.json().catch(() => null) as { tabs?: unknown[] } | null;
		const staleIds = (Array.isArray(workspace?.tabs) ? workspace!.tabs : [])
			.filter((tab) => reviewWorkspaceTabMatchesTitle(tab, title))
			.map((tab) => (tab as Record<string, unknown>).id)
			.filter((id): id is string => typeof id === "string" && id.startsWith("review:"));
		if (staleIds.length === 0) return;
		for (const tabId of staleIds) {
			await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/side-panel-workspace/tabs/${encodeURIComponent(tabId)}`, { method: "DELETE" }).catch(() => undefined);
		}
	}
}

function inlineCommentsFromAnnotations(sessionId: string, documentTitle: string): ReviewInlineCommentPayload[] {
	return getAnnotations(sessionId, documentTitle).map((ann) => ({
		documentTitle,
		quote: ann.quote,
		comment: ann.comment,
		prefix: ann.prefix,
		suffix: ann.suffix,
		start: ann.start,
		end: ann.end,
		isCode: ann.isCode,
	}));
}

function inlineCommentBelongsToDocument(comment: ReviewInlineCommentPayload, doc: ReviewDocumentModel): boolean {
	return !comment.documentTitle || comment.documentTitle === doc.title;
}

function normalizeDecisionPayload(input: ReviewDecisionPayload, sessionId: string, doc: ReviewDocumentModel): ReviewDecisionPayload {
	const providedInlineComments = Array.isArray(input.inlineComments) ? input.inlineComments : [];
	const inputInlineComments = providedInlineComments.filter((comment) => inlineCommentBelongsToDocument(comment, doc));
	const inlineComments = inputInlineComments.length > 0
		? inputInlineComments.map((comment) => ({ ...comment, documentTitle: comment.documentTitle || doc.title }))
		: inlineCommentsFromAnnotations(sessionId, doc.title);
	return {
		decision: input.decision,
		finalComment: typeof input.finalComment === "string" ? input.finalComment : "",
		inlineComments,
		feedback: providedInlineComments.length > 0 || inlineComments.length > 0 ? "" : typeof input.feedback === "string" ? input.feedback : "",
	};
}

export function reviewDecisionPayloadFromDetail(detail: unknown, sessionId: string, doc: ReviewDocumentModel | undefined): ReviewDecisionPayload | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
	const record = detail as Record<string, unknown>;
	const payloadRecord = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
		? record.payload as Record<string, unknown>
		: record;
	const decision = payloadRecord.decision;
	if (decision !== "approve" && decision !== "reject") return undefined;
	return normalizeDecisionPayload({
		decision,
		finalComment: typeof payloadRecord.finalComment === "string" ? payloadRecord.finalComment : "",
		inlineComments: Array.isArray(payloadRecord.inlineComments) ? payloadRecord.inlineComments as ReviewInlineCommentPayload[] : [],
		feedback: typeof payloadRecord.feedback === "string" ? payloadRecord.feedback : "",
	}, sessionId, doc || { title: "", markdown: "" });
}

export function reviewDocumentFromDecisionDetail(detail: unknown): ReviewDocumentModel | undefined {
	if (detail && typeof detail === "object" && !Array.isArray(detail)) {
		const record = detail as Record<string, unknown>;
		const embedded = record.document;
		if (embedded && typeof embedded === "object" && !Array.isArray(embedded)) {
			const doc = embedded as Record<string, unknown>;
			if (typeof doc.title === "string" && typeof doc.markdown === "string") {
				const documentId = normalizeDocumentId(doc.documentId);
				if (documentId) rememberReviewDocumentIdentity(doc.title, documentId);
				return { title: doc.title, markdown: doc.markdown, documentId, source: normalizeReviewSource(doc.source) || normalizeReviewSource(record.source) };
			}
		}
		const title = typeof record.title === "string" ? record.title
			: typeof record.documentTitle === "string" ? record.documentTitle
			: state.reviewActiveTab;
		if (title) return state.reviewDocuments.get(title);
	}
	return state.reviewActiveTab ? state.reviewDocuments.get(state.reviewActiveTab) : undefined;
}

function composeDecisionFeedback(doc: ReviewDocumentModel, payload: ReviewDecisionPayload, options: { emptyApprovalText?: string } = {}): string {
	const finalComment = payload.finalComment.trim();
	const sections: string[] = [];
	if (finalComment) sections.push(`## Final comment\n\n${finalComment}`);
	if (payload.inlineComments.length > 0) {
		const lines: string[] = [];
		for (const comment of payload.inlineComments) {
			const title = comment.documentTitle || doc.title;
			const quote = comment.isCode ? `\`${comment.quote}\`` : `"${comment.quote}"`;
			const locationParts: string[] = [];
			if (comment.start != null) locationParts.push(`offset ${comment.start}${comment.end != null ? `-${comment.end}` : ""}`);
			const location = locationParts.length > 0 ? ` (${locationParts.join(", ")})` : "";
			lines.push(`### "${title}"\n\n> ${quote}${location}\n\n${comment.comment}`);
		}
		sections.push(`## Inline comments\n\n${lines.join("\n\n")}`);
	}
	if (sections.length > 0) return sections.join("\n\n");
	if (payload.feedback.trim()) return payload.feedback.trim();
	return options.emptyApprovalText || "";
}

function composeMarkdownReviewDecisionFeedback(doc: ReviewDocumentModel, payload: ReviewDecisionPayload): string {
	const heading = payload.decision === "approve" ? "## Review Approved" : "## Review Rejected";
	const body = composeDecisionFeedback(doc, payload).trim();
	if (body) {
		if (body.startsWith("## Review Approved") || body.startsWith("## Review Rejected")) return body;
		return `${heading}\n\n${body}`;
	}
	return `${heading}\n\n${payload.decision === "approve" ? "Approved with no comments." : "Rejected."}`;
}

async function postSignoffDecision(source: Extract<ReviewSource, { kind: "verification-signoff-markdown" }>, doc: ReviewDocumentModel, payload: ReviewDecisionPayload): Promise<void> {
	const feedback = composeDecisionFeedback(doc, payload);
	const body: Record<string, unknown> = {
		signalId: source.signalId,
		stepName: source.stepName,
		decision: payload.decision === "approve" ? "pass" : "fail",
	};
	if (feedback.trim()) body.feedback = feedback.trim();
	const res = await gatewayFetch(`/api/goals/${encodeURIComponent(source.goalId)}/gates/${encodeURIComponent(source.gateId)}/signoff`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		let message = `Sign-off failed (${res.status})`;
		try {
			const data = await res.json();
			if (data?.error) message = String(data.error);
			else if (data?.message) message = String(data.message);
		} catch { /* keep status message */ }
		throw new Error(message);
	}
	const [{ refreshGateStatusForGoal }, { dispatchHumanSignoffResolved }] = await Promise.all([
		import("./api.js"),
		import("./gate-status-events.js"),
	]);
	dispatchHumanSignoffResolved({
		goalId: source.goalId,
		gateId: source.gateId,
		signalId: source.signalId,
		stepName: source.stepName,
		decision: body.decision as "pass" | "fail",
	});
	await refreshGateStatusForGoal(source.goalId);
}

export async function submitReviewDecision(doc: ReviewDocumentModel, inputPayload: ReviewDecisionPayload, options: SubmitReviewDecisionOptions = {}): Promise<void> {
	const sessionId = options.sessionId || activeSessionId() || "";
	const payload = normalizeDecisionPayload(inputPayload, sessionId, doc);
	const hasComment = payload.finalComment.trim().length > 0 || payload.inlineComments.length > 0;
	if (payload.decision === "reject" && !hasComment) {
		throw new Error("Reject requires at least one comment.");
	}
	const source = sourceWithDefault(doc.source, sessionId);
	if (source.kind === "verification-signoff-pr") {
		throw new Error("PR review source is not implemented yet.");
	}
	if (source.kind === "verification-signoff-markdown") {
		await postSignoffDecision(source, doc, payload);
	} else {
		const feedback = composeMarkdownReviewDecisionFeedback(doc, payload);
		if (!options.prompt) throw new Error("No active agent is available for this review.");
		await options.prompt(feedback);
		if (sessionId) {
			markReviewSubmitted(sessionId);
			await gatewayFetch(`/api/sessions/${encodeURIComponent(sessionId)}/review/submitted`, {
				method: "PUT",
				body: JSON.stringify({ submitted: true }),
			}).catch(() => undefined);
		}
	}
	if (sessionId) {
		clearAnnotations(sessionId, doc.title);
		removePersistedReviewDocument(sessionId, doc.title);
	}
	await flushPendingWrites();
	state.reviewDocuments = new Map(state.reviewDocuments);
	state.reviewDocuments.delete(doc.title);
	if (state.reviewActiveTab === doc.title) {
		state.reviewActiveTab = [...state.reviewDocuments.keys()][0] || "";
	}
	state.reviewPanelOpen = state.reviewDocuments.size > 0;
	const tabIdsToClose = new Set<string>();
	if (doc.documentId) tabIdsToClose.add(reviewPanelTabId(doc.documentId));
	for (const tab of getSidePanelWorkspace(sessionId).tabs) {
		if (tab.kind !== "review") continue;
		const source = tab.source as Record<string, unknown> | undefined;
		const tabTitle = typeof source?.title === "string" ? source.title : tab.title.replace(/^Review:\s*/, "");
		if (tabTitle === doc.title) tabIdsToClose.add(tab.id);
	}
	for (const tabId of tabIdsToClose) {
		try { await closeSidePanelTab(tabId, { sessionId }); }
		catch { /* best-effort; local review state is already cleared */ }
	}
	await deleteReviewWorkspaceTabsFromServer(sessionId, doc.title);
	renderApp();
}
