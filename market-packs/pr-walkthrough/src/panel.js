// Pack CLIENT panel module — the first-party pr-walkthrough viewer (design
// built-in-first-party-packs.md §8.4 + pr-walkthrough-launch-ux.md). Re-expresses
// the deleted built-in PrWalkthroughPanel as a pack viewer with PARITY on the
// load-bearing surfaces: the changeset header, the phase NAV RAIL (orientation →
// design → significant → other → audit), and the active card (summary, rationale,
// diff blocks, suggested comments, orientation beats). ALL dynamic data flows
// through the Host API — NEVER a raw fetch:
//   - host.callRoute("bundle", …)  → the pack's OWN route, which RECOMPUTES the REAL
//     changeset LIVE via git in the confined worker and READS any persisted cards.
//   - host.callRoute("publish", { yaml, jobId, baseSha, headSha }) → the pack route
//     runs the SAME production YAML→cards synthesis as the deleted built-in and
//     persists the result (the read→publish parity seam).
//   - host.callRoute("status", { childSessionId, jobId }) → poll the reviewer until
//     it submits the production YAML ({ phase:"submitted", yaml, … }).
//   - host.callRoute("recover", …) → resolve THIS reviewer child's submitted YAML
//     from its own binding/<self> on a reload (idempotent re-publish).
//
// LAUNCH UX (pr-walkthrough-launch-ux.md): the panel is mounted ONLY inside a
// reviewer SUB-AGENT session — there is NO owner-session pane and NO manual
// "Run"/"Load" buttons. A click on any launch surface spawns a fresh reviewer child
// (the platform launcher calls the `run` route) and switches the view to it; this
// panel then lives inside that child session.
//
// CHILD-PANE SELF-POLL — the documented carve-out from "no auto-invoke on mount"
// (pack-panels.ts::PackPanel), scoped to THIS child-session reviewer pane: on mount
// the pane reads its own binding/<__sessionId>; with no submitted YAML it shows a
// pending "PR Walkthrough: In Progress" spinner and self-drives the read-only
// `status` poll; on submit it flips to the rendered cards. This is READ-ONLY — it
// ONLY polls/recovers its OWN job (never spawns or mutates anything). On reload it
// re-resolves via the child-self `recover` route so the cards re-render.
//
// PRODUCTION-FAITHFUL: the panel hands the RAW submitted YAML (the rich production
// `pr` + `walkthrough.{…}` document) to `publish`; the route validates + maps it via
// the bundled shared synthesis. The panel derives the REAL jobId/changeset from the
// doc's `pr` (changesetIdForGithub) — no `job-litmus-1` literal.
//
// SECURITY: the only auto-invoke is the child-pane self-poll/recover above — both
// strictly read-only and scoped to the pane's OWN bound job. No owner agent is ever
// driven; the reviewer child is minted by the `run` route (server-side, role-scoped,
// read-only). Theme tokens only; structured data rendered via the escaping lit toolkit.

import { parse as parseYaml } from "yaml";

import { changesetIdForGithub } from "../../../src/shared/pr-walkthrough/ids.ts";

// Area C — poll-loop robustness. A long-but-PROGRESSING reviewer must never be
// turned into an error by a short clock: only a route-confirmed terminal child
// (phase:"error") ends the loop early. The absolute HARD_CAP_MS backstop and the
// SLOW_HINT_MS hint both KEEP the same pending copy — the pane never errors while
// the reviewer is alive.
const HARD_CAP_MS = 30 * 60_000; // absolute backstop (30 min)
const SLOW_HINT_MS = 120_000; // after this, still pending — no copy change, no error
const POLL_INTERVAL_MS = 1_500;
const DEFAULT_DIFF_CONTEXT_LINES = 3;
const DIFF_CONTEXT_EXPAND_LINES = 20;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const msgOf = (e) => (e && e.message ? String(e.message) : String(e));

// Phase ordering + labels mirror the deleted PrWalkthroughPanel PHASES so the nav
// rail groups the synthesized cards exactly as the built-in walkthrough did.
const PHASES = [
	{ id: "orientation", label: "Orientation", short: "O" },
	{ id: "design", label: "Key design choices", short: "D" },
	{ id: "significant", label: "Significant changes", short: "S" },
	{ id: "other", label: "Other + omissions", short: "M" },
	{ id: "audit", label: "Audit", short: "A" },
];

const arrayOf = (value) => Array.isArray(value) ? value : [];
const asText = (value, fallback = "") => value == null ? fallback : String(value);
const linePrefix = (kind) => (kind === "add" ? "+" : kind === "del" ? "-" : " ");
const lineTone = (kind) => kind === "add" ? "add" : kind === "del" ? "del" : "ctx";
const compactSha = (sha) => sha ? String(sha).slice(0, 7) : "unknown";
const deriveNavLabel = (card) => card.navLabel || card.nav_label || asText(card.title, "Card").split(/\s+/).slice(0, 3).join(" ");
const cardPhase = (card) => card.phaseId || card.phase || "orientation";
const safeDomId = (value) => asText(value, "item").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
const defaultDiffMode = () => {
	try {
		return globalThis.matchMedia && globalThis.matchMedia("(max-width: 760px)").matches ? "inline" : "split";
	} catch {
		return "split";
	}
};

// Raw YAML text from a submit_pr_walkthrough_yaml-shaped tool call (the rich
// production document). Returns undefined when the call is absent/unparseable.
function rawYamlOf(toolCall) {
	return toolCall && toolCall.input && typeof toolCall.input.yaml === "string" ? toolCall.input.yaml : undefined;
}

// Derive the REAL job REFERENCE from the submitted production doc's `pr` (no
// litmus literal): the jobId AND the base/head SHAs the LIVE recompute needs.
// The SHAs MUST come from the submitted YAML's `pr` block (`pr.base_sha`/
// `pr.head_sha`) — without them `publish` stores a pointer with undefined SHAs and
// `bundle` returns `{ found: false }` (the empty state). The jobId falls back to the
// panel param's jobId, else a neutral label.
function deriveJobRef(yamlText, fallback) {
	const ref = { jobId: fallback || "pr-walkthrough" };
	if (yamlText) {
		try {
			const doc = parseYaml(yamlText);
			const pr = doc && typeof doc === "object" ? doc.pr : undefined;
			if (pr && typeof pr === "object") {
				if (pr.owner && pr.repo && pr.number != null) {
					ref.jobId = changesetIdForGithub(String(pr.owner), String(pr.repo), pr.number, pr.head_sha ? String(pr.head_sha) : undefined);
				}
				if (pr.base_sha != null && String(pr.base_sha).trim()) ref.baseSha = String(pr.base_sha).trim();
				if (pr.head_sha != null && String(pr.head_sha).trim()) ref.headSha = String(pr.head_sha).trim();
				if (pr.provider != null && String(pr.provider).trim()) ref.provider = String(pr.provider).trim();
			}
		} catch { /* fall through */ }
	}
	return ref;
}

// paramKey → { status, bundle?, toolCall?, error?, activeCardId?, jobId?,
//              polling?, mountKicked?, slow?, diffMode?, reviewStatus?,
//              sectionIndex?, cardCommentOpen? }.
// status ∈ idle | running | publishing | rendered | error | empty.
//   running    → pending: a reviewer child is producing the walkthrough; the pane
//                self-polls `status` (the spinner + "PR Walkthrough: In Progress").
//   publishing → transient: the reviewer submitted; running publish → bundle.
//   empty      → resolved NOT a reviewer child (no binding/<self>) → neutral state.
// Module-level so it survives panel instance re-creation within a page session.
// Keyed by the BOUND session id (`__sessionId`) so each reviewer child gets its OWN entry.
const byJob = globalThis.__bobbitPrWalkthroughPanelState || (globalThis.__bobbitPrWalkthroughPanelState = new Map());
const panelObservers = globalThis.__bobbitPrWalkthroughPanelObservers || (globalThis.__bobbitPrWalkthroughPanelObservers = new Map());
const storeEntry = (key, entry) => { byJob.set(key, entry); };
const NARROW_PANEL_WIDTH = 900;
const PERSISTED_STATE_VERSION = 1;
const PERSISTED_FIELDS = [
	"activeCardId",
	"orientationBeatIndex",
	"railCollapsed",
	"railWidth",
	"diffMode",
	"userSetMode",
	"decisions",
	"reviewStatus",
	"cardComments",
	"cardCommentDraft",
	"cardCommentOpen",
	"lineComments",
	"lineCommentDraft",
	"lineCommentOpen",
	"dismissedSuggestionIds",
	"collapsedDiffBlocks",
	"contextExpansions",
];
const persistenceKeyFor = (panelKey, jobId) => `review-state/${safeDomId(panelKey || "session")}/${safeDomId(jobId || "job")}`;
const localPersistenceKeyFor = (panelKey, jobId) => `bobbit:pr-walkthrough:${persistenceKeyFor(panelKey, jobId)}`;
const pickPersistedState = (entry) => {
	const state = { version: PERSISTED_STATE_VERSION, savedAt: new Date().toISOString() };
	for (const field of PERSISTED_FIELDS) {
		if (entry && entry[field] !== undefined) state[field] = entry[field];
	}
	return state;
};
const readLocalPersistedState = (panelKey, jobId) => {
	try {
		const raw = globalThis.localStorage?.getItem(localPersistenceKeyFor(panelKey, jobId));
		return raw ? JSON.parse(raw) : undefined;
	} catch { return undefined; }
};
const writeLocalPersistedState = (panelKey, jobId, state) => {
	try { globalThis.localStorage?.setItem(localPersistenceKeyFor(panelKey, jobId), JSON.stringify(state)); }
	catch { /* localStorage may be unavailable or full */ }
};
const readHostPersistedState = async (host, panelKey, jobId) => {
	try { return host && host.store && host.store.get ? await host.store.get(persistenceKeyFor(panelKey, jobId)) : undefined; }
	catch { return undefined; }
};
const writeHostPersistedState = async (host, panelKey, jobId, state) => {
	try { if (host && host.store && host.store.put) await host.store.put(persistenceKeyFor(panelKey, jobId), state); }
	catch { /* host persistence is best-effort */ }
};
const emitReviewEvent = (host, panelKey, type, detail = {}) => {
	try {
		if (typeof CustomEvent === "undefined") return;
		const payload = { detail: { panelKey, ...detail }, bubbles: true, composed: true };
		const eventName = `pr-walkthrough:${type}`;
		const root = typeof document !== "undefined" ? document.querySelector(`[data-prw-key="${safeDomId(panelKey)}"]`) : undefined;
		if (root) root.dispatchEvent(new CustomEvent(eventName, payload));
		if (typeof document !== "undefined") document.dispatchEvent(new CustomEvent(eventName, payload));
		if (globalThis && globalThis.dispatchEvent) globalThis.dispatchEvent(new CustomEvent(eventName, payload));
		if (host && typeof host.dispatchEvent === "function") host.dispatchEvent(new CustomEvent(eventName, payload));
	} catch { /* event emission must never break rendering */ }
};

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	const cardsOf = (entry) => (entry && entry.bundle && Array.isArray(entry.bundle.cards)) ? entry.bundle.cards : [];

	const activeCard = (entry) => {
		const cards = cardsOf(entry);
		if (cards.length === 0) return undefined;
		const found = cards.find((c) => c.id === entry.activeCardId);
		return found || cards[0];
	};

	const replaceEntry = (host, key, next) => {
		storeEntry(key, next);
		if (host && host.requestRender) host.requestRender();
	};

	const persistEntryState = (host, key, entry, eventType = "draft-change") => {
		const jobId = entry.jobId || (entry.bundle && entry.bundle.changeset && entry.bundle.changeset.jobId) || key;
		const state = pickPersistedState(entry);
		writeLocalPersistedState(key, jobId, state);
		void writeHostPersistedState(host, key, jobId, state);
		emitReviewEvent(host, key, eventType, { jobId, state });
	};

	const patchEntry = (host, key, patch, options = {}) => {
		const cur = byJob.get(key) || {};
		const next = { ...cur, ...patch };
		replaceEntry(host, key, next);
		if (next.status === "rendered" || next.bundle) persistEntryState(host, key, next, options.eventType || "draft-change");
	};

	const updatePanelMeasurement = (host, key, width) => {
		const roundedWidth = Math.max(0, Math.round(Number(width) || 0));
		const observedNarrow = roundedWidth > 0 && roundedWidth < NARROW_PANEL_WIDTH;
		const cur = byJob.get(key) || {};
		if (cur.panelWidth === roundedWidth && Boolean(cur.observedNarrow) === observedNarrow) return;
		storeEntry(key, { ...cur, panelWidth: roundedWidth, observedNarrow });
		if (host && host.requestRender) host.requestRender();
	};

	const ensurePanelObserver = (host, key) => {
		if (!key || typeof document === "undefined") return;
		const domKey = safeDomId(key);
		queueMicrotask(() => {
			const element = document.querySelector(`[data-prw-key="${domKey}"]`);
			if (!element) return;
			const measure = () => updatePanelMeasurement(host, key, element.getBoundingClientRect().width);
			const existing = panelObservers.get(key);
			if (existing && existing.element === element) {
				measure();
				return;
			}
			if (existing && existing.cleanup) existing.cleanup();
			if (typeof ResizeObserver !== "undefined") {
				const observer = new ResizeObserver((entries) => {
					const rect = entries && entries[0] && entries[0].contentRect;
					updatePanelMeasurement(host, key, rect ? rect.width : element.getBoundingClientRect().width);
				});
				observer.observe(element);
				panelObservers.set(key, { element, cleanup: () => observer.disconnect() });
			} else {
				const onResize = () => measure();
				globalThis.addEventListener("resize", onResize);
				panelObservers.set(key, { element, cleanup: () => globalThis.removeEventListener("resize", onResize) });
			}
			measure();
		});
	};

	const viewportNarrow = () => {
		try { return Boolean(globalThis.matchMedia && globalThis.matchMedia("(max-width: 900px)").matches); }
		catch { return false; }
	};
	const isNarrowLayout = (entry) => Boolean((entry && entry.observedNarrow) || viewportNarrow());
	const isRailCollapsed = (entry) => Boolean(entry && entry.railCollapsed) || isNarrowLayout(entry);

	const setActiveCard = (entry, host, paramKey, cardId) => {
		patchEntry(host, paramKey, { activeCardId: cardId });
	};

	const moveCard = (entry, host, paramKey, delta) => {
		const cards = cardsOf(entry);
		if (!cards.length) return;
		const current = activeCard(entry) || cards[0];
		const idx = Math.max(0, cards.findIndex((card) => card.id === current.id));
		const next = cards[Math.max(0, Math.min(cards.length - 1, idx + delta))];
		if (next) setActiveCard(entry, host, paramKey, next.id);
	};

	const updateNestedMap = (entry, host, paramKey, field, itemKey, value) => {
		const cur = byJob.get(paramKey) || entry;
		patchEntry(host, paramKey, { [field]: { ...(cur[field] || {}), [itemKey]: value } });
	};

	const markCard = (entry, host, paramKey, card, status) => {
		const reviewStatus = { ...(entry.reviewStatus || {}), [card.id]: status };
		patchEntry(host, paramKey, { reviewStatus });
		queueMicrotask(() => moveCard({ ...entry, reviewStatus }, host, paramKey, 1));
	};

	const blockKey = (card, block) => `${asText(card && card.id, "card")}::${asText(block && (block.id || block.filePath || block.path || block.label), "diff")}`;
	const lineIdentifier = (line) => asText(line && (line.id || line.lineId || line.line || line.newLine || line.oldLine || line.text), "line");
	const lineKey = (card, block, line) => `${blockKey(card, block)}::${lineIdentifier(line)}::${asText(line && line.kind, "ctx")}`;
	const lineDomId = (key) => `prw-line-comment-${safeDomId(key)}`;
	const blockIdentifiers = (block) => new Set([block && block.id, block && block.filePath, block && block.path, block && block.label].map((value) => asText(value)).filter(Boolean));
	const suggestionBody = (suggestion) => asText(suggestion && (suggestion.body || suggestion.text || suggestion.summary), suggestion);
	const suggestionMatchesBlock = (suggestion, block) => {
		const target = asText(suggestion && (suggestion.diffBlockId || suggestion.diff_block_id || suggestion.blockId || suggestion.filePath || suggestion.path));
		return !target || blockIdentifiers(block).has(target);
	};
	const suggestionMatchesLine = (suggestion, line) => {
		const target = asText(suggestion && (suggestion.lineId || suggestion.line_id || suggestion.line || suggestion.newLine || suggestion.oldLine));
		if (!target) return false;
		return target === lineIdentifier(line)
			|| target === asText(line && line.id)
			|| target === asText(line && line.lineId)
			|| target === asText(line && line.line)
			|| target === asText(line && line.newLine)
			|| target === asText(line && line.oldLine);
	};
	const lineSuggestions = (card, block, line) => arrayOf(card && card.suggestedComments)
		.filter((suggestion) => suggestionMatchesBlock(suggestion, block) && suggestionMatchesLine(suggestion, line));
	const anchoredSuggestionIds = (card) => {
		const ids = new Set();
		for (const block of arrayOf(card && card.diffBlocks)) {
			for (const hunk of arrayOf(block && block.hunks)) {
				for (const line of arrayOf(hunk && hunk.lines)) {
					for (const suggestion of lineSuggestions(card, block, line)) ids.add(asText(suggestion && suggestion.id, suggestionBody(suggestion)));
				}
			}
		}
		return ids;
	};
	const savedLineCommentsForCard = (entry, card) => Object.entries(entry.lineComments || {})
		.filter(([key, comments]) => key.startsWith(`${asText(card && card.id, "card")}::`) && arrayOf(comments).some((comment) => asText(comment).trim()));
	const savedCardCommentsForCard = (entry, card) => arrayOf((entry.cardComments || {})[card.id]).filter((comment) => asText(comment).trim());
	const hasSavedUserComments = (entry, card) => savedCardCommentsForCard(entry, card).length > 0 || savedLineCommentsForCard(entry, card).length > 0;
	const reconcileUnsupportedDislikes = (entry) => {
		const cards = cardsOf(entry);
		let changed = false;
		const decisions = { ...(entry.decisions || {}) };
		const reviewStatus = { ...(entry.reviewStatus || {}) };
		for (const card of cards) {
			const status = reviewStatus[card.id] || (decisions[card.id] && decisions[card.id].decision);
			if (status === "disliked" && !hasSavedUserComments(entry, card)) {
				delete decisions[card.id];
				delete reviewStatus[card.id];
				changed = true;
			}
		}
		return changed ? { ...entry, decisions, reviewStatus, reviewComplete: false } : entry;
	};

	const statsFor = (bundle, cards) => {
		const cs = (bundle && bundle.changeset) || {};
		if (cs.filesChanged != null || cs.additions != null || cs.deletions != null) {
			return {
				files: Number(cs.filesChanged || 0),
				additions: Number(cs.additions || 0),
				deletions: Number(cs.deletions || 0),
			};
		}
		const files = new Set();
		let additions = 0;
		let deletions = 0;
		for (const card of cards) {
			for (const block of arrayOf(card.diffBlocks)) {
				if (block && block.filePath) files.add(String(block.filePath));
				for (const hunk of arrayOf(block && block.hunks)) {
					for (const line of arrayOf(hunk && hunk.lines)) {
						if (line && line.kind === "add") additions += 1;
						if (line && line.kind === "del") deletions += 1;
					}
				}
			}
		}
		return { files: files.size, additions, deletions };
	};

	const prUrlFor = (cs) => cs.url || (cs.owner && cs.repo && cs.number != null
		? `https://github.com/${cs.owner}/${cs.repo}/pull/${cs.number}`
		: undefined);


	const mergePersistedReviewerState = (entry, persisted) => {
		if (!persisted || typeof persisted !== "object") return entry;
		const cards = cardsOf(entry);
		const ids = new Set(cards.map((card) => card.id));
		const state = {};
		for (const field of PERSISTED_FIELDS) {
			if (persisted[field] !== undefined) state[field] = persisted[field];
		}
		if (state.activeCardId && !ids.has(state.activeCardId)) delete state.activeCardId;
		if (state.reviewStatus && typeof state.reviewStatus === "object") state.reviewStatus = Object.fromEntries(Object.entries(state.reviewStatus).filter(([cardId]) => ids.has(cardId)));
		if (state.decisions && typeof state.decisions === "object") state.decisions = Object.fromEntries(Object.entries(state.decisions).filter(([cardId]) => ids.has(cardId)));
		if (state.cardComments && typeof state.cardComments === "object") state.cardComments = Object.fromEntries(Object.entries(state.cardComments).filter(([cardId]) => ids.has(cardId)));
		if (state.cardCommentDraft && typeof state.cardCommentDraft === "object") state.cardCommentDraft = Object.fromEntries(Object.entries(state.cardCommentDraft).filter(([cardId]) => ids.has(cardId)));
		if (state.cardCommentOpen && typeof state.cardCommentOpen === "object") state.cardCommentOpen = Object.fromEntries(Object.entries(state.cardCommentOpen).filter(([cardId]) => ids.has(cardId)));
		return { ...entry, ...state, activeCardId: state.activeCardId || entry.activeCardId };
	};

	const reviewCardsOf = (entry) => cardsOf(entry).filter((card) => cardPhase(card) !== "audit");
	const completedCardIds = (entry) => new Set(Object.entries(entry.reviewStatus || {})
		.filter(([, status]) => status === "liked" || status === "disliked" || status === "complete")
		.map(([cardId]) => cardId));
	const progressFor = (entry) => {
		const reviewCards = reviewCardsOf(entry);
		const completed = completedCardIds(entry);
		return { completed: reviewCards.filter((card) => completed.has(card.id)).length, total: reviewCards.length };
	};
	const supportingCommentIdsFor = (entry, card) => [
		...savedCardCommentsForCard(entry, card).map((_, index) => `${card.id}::card::${index}`),
		...savedLineCommentsForCard(entry, card).map(([key]) => key),
	];
	const previousCardId = (entry, card) => {
		const cards = cardsOf(entry);
		const idx = cards.findIndex((candidate) => candidate.id === card.id);
		return idx > 0 ? cards[idx - 1].id : undefined;
	};
	const nextCardId = (entry, card) => {
		const cards = cardsOf(entry);
		const idx = cards.findIndex((candidate) => candidate.id === card.id);
		return idx >= 0 && idx < cards.length - 1 ? cards[idx + 1].id : undefined;
	};
	const firstReviewCardAfter = (entry, card) => cardsOf(entry).find((candidate) => candidate.id !== card.id && cardPhase(candidate) !== "orientation") || cardsOf(entry).find((candidate) => candidate.id !== card.id);
	const recordDecision = (entry, host, paramKey, card, decision) => {
		const cur = byJob.get(paramKey) || entry;
		if (decision === "disliked" && !hasSavedUserComments(cur, card)) return;
		const supportingCommentIds = decision === "disliked" ? supportingCommentIdsFor(cur, card) : [];
		const decisions = { ...(cur.decisions || {}), [card.id]: { decision, supportingCommentIds, recordedAt: new Date().toISOString() } };
		const reviewStatus = { ...(cur.reviewStatus || {}), [card.id]: decision };
		const next = nextCardId(cur, card);
		const nextCard = next ? cardsOf(cur).find((candidate) => candidate.id === next) : undefined;
		const complete = !nextCard || cardPhase(nextCard) === "audit";
		patchEntry(host, paramKey, { decisions, reviewStatus, activeCardId: next || card.id, reviewComplete: complete || cur.reviewComplete }, { eventType: "draft-change" });
		if (complete) {
			const finalEntry = byJob.get(paramKey) || { ...cur, decisions, reviewStatus };
			emitReviewEvent(host, paramKey, "complete", { jobId: finalEntry.jobId || paramKey, state: pickPersistedState(finalEntry), cardId: card.id });
		}
	};
	const completeOrientation = (entry, host, paramKey, card) => {
		const cur = byJob.get(paramKey) || entry;
		const reviewStatus = { ...(cur.reviewStatus || {}), [card.id]: "complete" };
		const target = firstReviewCardAfter(cur, card);
		patchEntry(host, paramKey, { reviewStatus, activeCardId: target ? target.id : card.id });
	};
	const clampRailWidth = (value) => Math.max(150, Math.min(360, Number(value) || 248));
	const setRailCollapsed = (entry, host, paramKey, collapsed) => patchEntry(host, paramKey, { railCollapsed: Boolean(collapsed) });
	const resetRailWidth = (entry, host, paramKey) => patchEntry(host, paramKey, { railWidth: 248 });
	const onRailResizePointerDown = (event, entry, host, paramKey) => {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = clampRailWidth((byJob.get(paramKey) || entry).railWidth || 248);
		const move = (ev) => patchEntry(host, paramKey, { railWidth: clampRailWidth(startWidth + ev.clientX - startX), railCollapsed: false });
		const up = () => {
			globalThis.removeEventListener("pointermove", move);
			globalThis.removeEventListener("pointerup", up);
		};
		globalThis.addEventListener("pointermove", move);
		globalThis.addEventListener("pointerup", up, { once: true });
	};

	const renderHeaderBlock = (entry, host, paramKey) => {
		const b = entry.bundle || {};
		const cs = b.changeset || {};
		const cards = cardsOf(entry);
		const stats = statsFor(b, cards);
		const progress = progressFor(entry);
		const pct = progress.total ? Math.round((progress.completed / progress.total) * 100) : 0;
		const prLabel = cs.number != null ? `#${cs.number}` : "PR";
		const title = cs.prTitle || cs.title || "Walkthrough";
		const url = prUrlFor(cs);
		const submitReady = progress.total > 0 && progress.completed >= progress.total;
		return html`
			<header class="header prw-review-header" data-testid="pr-walkthrough-header">
				<div class="title-group">
					<span class="pr-pill">${prLabel}</span>
					<div class="title-stack">
						<h1 data-testid="pr-walkthrough-pr-title"><span data-testid="prw-title">${title}</span></h1>
						<div class="header-meta" data-testid="pr-walkthrough-pr-stats">
							<span>${stats.files} ${stats.files === 1 ? "file" : "files"}</span>
							<span class="add">+${stats.additions}</span>
							<span class="del">-${stats.deletions}</span>
							<span>${compactSha(cs.baseSha)}…${compactSha(cs.headSha)}</span>
						</div>
					</div>
				</div>
				${url ? html`<a class="github-link" data-testid="pr-walkthrough-pr-link" href=${url} target="_blank" rel="noreferrer" title="Open PR on GitHub" aria-label="Open PR on GitHub"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg><span>GitHub</span></a>` : nothing}
				<div class="progress-wrap" data-testid="pr-walkthrough-progress">
					<span>${progress.completed} / ${progress.total} reviewed</span>
					<div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax=${progress.total || 1} aria-valuenow=${progress.completed}><div class="progress-fill" style=${`width:${pct}%`}></div></div>
				</div>
				<button class="submit" data-testid="pr-walkthrough-submit-review" type="button" ?disabled=${!submitReady} @click=${() => patchEntry(host, paramKey, { exportPreviewOpen: true })}>Submit review</button>
			</header>
		`;
	};

	const renderOrientationRailSteps = (entry, host, paramKey, card, compact = false, exposeTestIds = true) => {
		const sections = arrayOf(card && card.sections);
		if (!sections.length) return nothing;
		const beat = Math.max(0, Math.min(sections.length - 1, (entry.orientationBeatIndex || 0)));
		const completed = completedCardIds(entry).has(card.id);
		return html`<div class="orientation-rail" data-testid=${exposeTestIds ? "pr-walkthrough-orientation-rail" : nothing}>
			${sections.map((section, index) => {
				const state = completed || index < beat ? "visited" : index === beat ? "current" : "upcoming";
				return html`<button class=${`orientation-step ${state}`} data-testid=${exposeTestIds ? "pr-walkthrough-orientation-step" : nothing} data-state=${state} type="button" title=${section.heading || section.navLabel || `Beat ${index + 1}`} aria-label=${section.heading || section.navLabel || `Beat ${index + 1}`} @click=${() => patchEntry(host, paramKey, { activeCardId: card.id, orientationBeatIndex: index })}>
					<span class="step-dot">${state === "visited" ? "✓" : index + 1}</span>${compact ? nothing : html`<span class="step-label">${section.navLabel || section.eyebrow || `Beat ${index + 1}`}</span>`}
				</button>`;
			})}
		</div>`;
	};

	const renderRailCardButton = (entry, host, paramKey, card, compact = false, exposeTestIds = true) => {
		const active = activeCard(entry);
		const status = (entry.reviewStatus || {})[card.id] || "pending";
		const complete = status === "liked" || status === "disliked" || status === "complete";
		const label = asText(card.title, deriveNavLabel(card));
		return html`<button
			class=${`card-button prw-nav-card ${active && active.id === card.id ? "active is-active" : ""} ${complete ? "complete is-reviewed" : ""} ${status === "liked" ? "liked" : ""} ${status === "disliked" ? "disliked" : ""}`}
			data-testid=${exposeTestIds ? "pr-walkthrough-card-step" : nothing} data-prw-nav=${card.id} data-card-id=${card.id}
			type="button" title=${label} aria-label=${label}
			@click=${() => setActiveCard(entry, host, paramKey, card.id)}
		>
			<span class="card-dot prw-nav-dot" aria-hidden="true">${complete ? status === "disliked" ? "!" : "✓" : ""}</span>
			${compact ? html`${exposeTestIds ? html`<span class="legacy-nav-card-marker" data-testid="prw-nav-card" data-prw-nav=${card.id} data-card-id=${card.id} aria-hidden="true"></span>` : nothing}` : html`<span class="card-label"><span data-testid=${exposeTestIds ? "prw-nav-card" : nothing} data-prw-nav=${card.id} data-card-id=${card.id}>${deriveNavLabel(card)}</span></span>`}
		</button>`;
	};

	const renderNavRail = (entry, host, paramKey) => {
		const cards = cardsOf(entry);
		const active = activeCard(entry);
		const railWidth = clampRailWidth(entry.railWidth || 248);
		const collapsed = isRailCollapsed(entry);
		const narrow = isNarrowLayout(entry);
		const orientationCard = cards.find((card) => cardPhase(card) === "orientation" && arrayOf(card.sections).length);
		return html`
			<aside class=${`rail ${collapsed ? "collapsed" : ""} ${narrow ? "narrow" : ""}`} style=${`--walkthrough-rail-width:${railWidth}px`} data-observed-narrow=${String(narrow)}>
				<nav class="rail-panel labelled prw-phase-rail" data-testid="pr-walkthrough-labelled-rail" aria-label=${collapsed ? "Labelled PR walkthrough phase rail" : "PR walkthrough phase rail"}>
					<div class="rail-top"><strong>Walkthrough</strong><button class="rail-toggle" data-testid=${collapsed ? nothing : "pr-walkthrough-rail-toggle"} type="button" title="Collapse rail" aria-label="Collapse rail" @click=${() => setRailCollapsed(entry, host, paramKey, true)}>‹</button></div>
					${orientationCard ? renderOrientationRailSteps(entry, host, paramKey, orientationCard, false, !collapsed) : nothing}
					${PHASES.map((phase, phaseIndex) => {
						const phaseCards = cards.filter((c) => cardPhase(c) === phase.id);
						if (phaseCards.length === 0) return nothing;
						const phaseActive = active && cardPhase(active) === phase.id;
						const done = phaseCards.filter((card) => completedCardIds(entry).has(card.id)).length;
						return html`<section class=${`phase prw-phase ${phaseActive ? "active is-active" : ""}`}>
							<button class="phase-button" data-testid="pr-walkthrough-phase-button" type="button" @click=${() => phaseCards[0] && setActiveCard(entry, host, paramKey, phaseCards[0].id)}>
								<span class="phase-pip prw-phase-index">${phase.short || phaseIndex + 1}</span><span class="phase-name">${phase.label}</span><span class="phase-count">${done}/${phaseCards.length}</span>
							</button>
							<div class="phase-cards">${phaseCards.map((card) => renderRailCardButton(entry, host, paramKey, card, false, !collapsed))}</div>
						</section>`;
					})}
					${narrow ? nothing : html`<button class="walkthrough-rail-resize-handle" data-testid="pr-walkthrough-rail-resize" type="button" title="Drag to resize rail" aria-label="Resize rail" @dblclick=${() => resetRailWidth(entry, host, paramKey)} @pointerdown=${(event) => onRailResizePointerDown(event, entry, host, paramKey)}></button>`}
				</nav>
				<nav class="rail-panel compact prw-phase-rail-collapsed" data-testid="pr-walkthrough-collapsed-rail" aria-label="Collapsed PR walkthrough phase rail">
					${collapsed ? html`<span class="legacy-navrail-marker" data-testid="prw-navrail" aria-hidden="true"></span>` : nothing}
					<button class="rail-toggle" data-testid=${collapsed ? "pr-walkthrough-rail-toggle" : nothing} type="button" title="Expand rail" aria-label="Expand rail" @click=${() => setRailCollapsed(entry, host, paramKey, false)}>›</button>
					${orientationCard ? renderOrientationRailSteps(entry, host, paramKey, orientationCard, true, collapsed) : nothing}
					${PHASES.map((phase, phaseIndex) => {
						const phaseCards = cards.filter((c) => cardPhase(c) === phase.id);
						if (phaseCards.length === 0) return nothing;
						const phaseActive = active && cardPhase(active) === phase.id;
						return html`<div class="rail-pip-group prw-rail-pip-group"><button class=${`phase-pip prw-rail-pip ${phaseActive ? "active is-active" : ""}`} data-testid="pr-walkthrough-phase-button" type="button" title=${phase.label} aria-label=${phase.label} @click=${() => phaseCards[0] && setActiveCard(entry, host, paramKey, phaseCards[0].id)}>${phase.short || phaseIndex + 1}</button>${phaseCards.map((card) => renderRailCardButton(entry, host, paramKey, card, true, collapsed))}</div>`;
					})}
				</nav>
			</aside>
		`;
	};

	const renderOriginalDescription = (entry) => {
		const cs = (entry.bundle && entry.bundle.changeset) || {};
		const body = cs.description || cs.body || cs.prBody || cs.summary;
		if (!body) return nothing;
		return html`<details class="original-description"><summary>Original PR description</summary><div>${body}</div></details>`;
	};

	const renderOrientationVerdict = (section) => section && section.verdict ? html`<div class="verdict" data-testid="pr-walkthrough-beat-verdict"><strong>${asText(section.verdict.recommendation, "review").toUpperCase()}</strong>${section.verdict.confidence ? html`<span>${section.verdict.confidence} confidence</span>` : nothing}${section.verdict.summary ? html`<p>${section.verdict.summary}</p>` : nothing}</div>` : nothing;
	const renderOrientationStats = (entry, card, section) => {
		if (!section || !section.showStats) return nothing;
		const stats = statsFor(entry.bundle || {}, cardsOf(entry));
		return html`<div class="guide-stats" data-testid="pr-walkthrough-beat-stats"><span>${stats.files} ${stats.files === 1 ? "file" : "files"}</span><span class="add">+${stats.additions}</span><span class="del">-${stats.deletions}</span><span>${arrayOf(card.diffBlocks).length} diff blocks</span></div>`;
	};
	const renderOrientationBeat = (entry, card, section) => html`<div class="beat" data-testid="pr-walkthrough-orientation-beat">
		${section.eyebrow ? html`<div class="phase-label">${section.eyebrow}</div>` : nothing}
		<h2 data-testid="pr-walkthrough-beat-heading">${section.heading || section.navLabel || "Orientation beat"}</h2>
		${section.body ? html`<p class="summary">${section.body}</p>` : nothing}
		${renderOrientationVerdict(section)}
		${renderOrientationStats(entry, card, section)}
		${arrayOf(section.concerns).length ? html`<div class="concerns" data-testid="pr-walkthrough-beat-concerns">${arrayOf(section.concerns).map((concern) => html`<div class="concern"><strong>${asText(concern.severity || concern.kind, "concern").replace(/_/g, "-")}</strong><span>${concern.text || concern.summary || concern}</span></div>`)}</div>` : nothing}
		${arrayOf(section.fileRoles).length ? html`<div class="filemap" data-testid="pr-walkthrough-beat-filemap">${arrayOf(section.fileRoles).map((role) => html`<div class="filerow"><strong>${role.role || "file"}</strong><span>${role.file || role.path || "unknown"}</span>${role.note ? html`<small>${role.note}</small>` : nothing}</div>`)}</div>` : nothing}
	</div>`;
	const renderOrientationGuideCard = (entry, host, paramKey, card) => {
		const sections = arrayOf(card.sections);
		const beat = Math.max(0, Math.min(sections.length - 1, entry.orientationBeatIndex || 0));
		const setBeat = (next) => patchEntry(host, paramKey, { orientationBeatIndex: Math.max(0, Math.min(sections.length - 1, next)) });
		const isLast = beat >= sections.length - 1;
		return html`<article class="card guide" data-testid="pr-walkthrough-card" data-card-id=${card.id} data-prw-card=${card.id}>
			<span data-testid="prw-card" hidden></span>
			<div class="guide-top"><div><div class="phase-label">Guided orientation</div><h1 data-testid="pr-walkthrough-card-title">${card.title || "Review orientation"}</h1></div><div class="guide-counter" data-testid="pr-walkthrough-guide-counter">${beat + 1} / ${sections.length}</div></div>
			${card.summary ? html`<p class="summary" data-testid="pr-walkthrough-card-summary">${card.summary}</p>` : nothing}
			<div class="guide-stage" data-testid="pr-walkthrough-orientation-guide">${renderOrientationBeat(entry, card, sections[beat] || {})}</div>
			${renderOriginalDescription(entry)}
			<div class="guide-nav"><button class="secondary" data-testid="pr-walkthrough-guide-back" type="button" ?disabled=${beat === 0} @click=${() => setBeat(beat - 1)}>Back</button><button class="primary" data-testid="pr-walkthrough-guide-next" type="button" @click=${() => isLast ? completeOrientation(entry, host, paramKey, card) : setBeat(beat + 1)}>${isLast ? "Start review" : "Next"}</button></div>
		</article>`;
	};

	const effectiveDiffMode = (entry) => (entry.diffMode === "inline" ? "inline" : "split");
	const normKind = (line) => (line && (line.kind === "add" || line.kind === "del") ? line.kind : "context");
	const hunkId = (hunk, index) => asText(hunk && (hunk.id || hunk.header), `hunk-${index}`);
	const lineId = (line) => asText(line && (line.id || line.lineId || line.line || line.newLine || line.oldLine || line.text), "line");
	const commentsForLineKey = (entry, key) => arrayOf((entry.lineComments || {})[key]).filter((comment) => asText(comment).trim());

	const openLineComment = (entry, host, paramKey, key, draft) => {
		const cur = byJob.get(paramKey) || entry;
		patchEntry(host, paramKey, {
			lineCommentOpen: { ...(cur.lineCommentOpen || {}), [key]: true },
			lineCommentDraft: { ...(cur.lineCommentDraft || {}), [key]: draft == null ? asText((cur.lineCommentDraft || {})[key]) : asText(draft) },
		});
	};
	const cancelLineComment = (entry, host, paramKey, key) => {
		const cur = byJob.get(paramKey) || entry;
		patchEntry(host, paramKey, {
			lineCommentOpen: { ...(cur.lineCommentOpen || {}), [key]: false },
			lineCommentDraft: { ...(cur.lineCommentDraft || {}), [key]: "" },
		});
	};
	const saveLineComment = (entry, host, paramKey, key) => {
		const cur = byJob.get(paramKey) || entry;
		const draft = asText((cur.lineCommentDraft || {})[key]).trim();
		if (!draft) return;
		patchEntry(host, paramKey, {
			lineComments: { ...(cur.lineComments || {}), [key]: [...arrayOf((cur.lineComments || {})[key]), draft] },
			lineCommentOpen: { ...(cur.lineCommentOpen || {}), [key]: false },
			lineCommentDraft: { ...(cur.lineCommentDraft || {}), [key]: "" },
		});
	};
	const useSuggestedLineComment = (entry, host, paramKey, key, suggestion) => openLineComment(entry, host, paramKey, key, suggestionBody(suggestion));

	const renderDiffModeControls = (entry, host, paramKey) => {
		const mode = effectiveDiffMode(entry);
		return html`<div class="modebar" data-testid="pr-walkthrough-diff-mode-chooser"><span class="mode-toggle" role="radiogroup" aria-label="Diff display mode"><button id="diff-mode-split" data-testid="diff-mode-split" class=${mode === "split" ? "active" : ""} type="button" role="radio" aria-label="Split diff" title="Side-by-side split diff" aria-checked=${String(mode === "split")} @click=${() => patchEntry(host, paramKey, { diffMode: "split", userSetMode: true })}><svg class="mode-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="5" height="10" rx="1"></rect><rect x="9" y="3" width="5" height="10" rx="1"></rect></svg></button><button id="diff-mode-inline" data-testid="diff-mode-inline" class=${mode === "inline" ? "active" : ""} type="button" role="radio" aria-label="Inline diff" title="Inline diff" aria-checked=${String(mode === "inline")} @click=${() => patchEntry(host, paramKey, { diffMode: "inline", userSetMode: true })}><svg class="mode-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h4"></path><path d="M13 6h8"></path><path d="M5 12h4"></path><path d="M13 12h8"></path><path d="M5 18h4M7 16v4"></path><path d="M13 18h8"></path></svg></button></span></div>`;
	};

	const lineNo = (line, side) => side === "old" ? asText(line && (line.oldLine ?? line.line ?? "")) : side === "new" ? asText(line && (line.newLine ?? line.line ?? "")) : asText(line && (line.newLine ?? line.oldLine ?? line.line ?? ""));
	const openLine = (event, entry, host, paramKey, key, draft) => { if (event) event.stopPropagation(); openLineComment(entry, host, paramKey, key, draft); };
	const onLineKey = (event, entry, host, paramKey, key) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openLineComment(entry, host, paramKey, key); } };

	const renderHighlightedLine = (text) => {
		const source = asText(text);
		const tokenPattern = /(\/\/.*$|`(?:\\.|[^`])*`|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\b(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|export|import|from|async|await|new|private|public|protected|readonly|extends|implements|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*(?=\??\s*:))/g;
		const parts = [];
		let last = 0;
		for (const match of source.matchAll(tokenPattern)) {
			const index = match.index || 0;
			if (index > last) parts.push(html`${source.slice(last, index)}`);
			const token = match[0];
			const cls = token.startsWith("//") ? "tok-comment" : token.startsWith('"') || token.startsWith("'") || token.startsWith("`") ? "tok-string" : /^\d/.test(token) ? "tok-number" : /^(?:const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|interface|type|export|import|from|async|await|new|private|public|protected|readonly|extends|implements|true|false|null|undefined)$/.test(token) ? "tok-keyword" : source.slice(index + token.length).match(/^\s*\(/) ? "tok-function" : "tok-property";
			parts.push(html`<span class=${cls}>${token}</span>`);
			last = index + token.length;
		}
		if (last < source.length) parts.push(html`${source.slice(last)}`);
		return parts;
	};

	const deleteLineComment = (entry, host, paramKey, key, index) => {
		const cur = byJob.get(paramKey) || entry;
		const nextComments = { ...(cur.lineComments || {}) };
		const values = arrayOf(nextComments[key]).filter((comment) => asText(comment).trim());
		const filtered = values.filter((_, commentIndex) => commentIndex !== index);
		if (filtered.length) nextComments[key] = filtered;
		else delete nextComments[key];
		const next = reconcileUnsupportedDislikes({ ...cur, lineComments: nextComments });
		patchEntry(host, paramKey, { lineComments: next.lineComments, decisions: next.decisions, reviewStatus: next.reviewStatus, reviewComplete: next.reviewComplete });
	};
	const editLineComment = (entry, host, paramKey, key, index, comment) => {
		const cur = byJob.get(paramKey) || entry;
		const nextComments = { ...(cur.lineComments || {}) };
		const values = arrayOf(nextComments[key]).filter((value) => asText(value).trim());
		const filtered = values.filter((_, commentIndex) => commentIndex !== index);
		if (filtered.length) nextComments[key] = filtered;
		else delete nextComments[key];
		const next = reconcileUnsupportedDislikes({ ...cur, lineComments: nextComments });
		patchEntry(host, paramKey, {
			lineComments: next.lineComments,
			decisions: next.decisions,
			reviewStatus: next.reviewStatus,
			reviewComplete: next.reviewComplete,
			lineCommentOpen: { ...(cur.lineCommentOpen || {}), [key]: true },
			lineCommentDraft: { ...(cur.lineCommentDraft || {}), [key]: asText(comment) },
		});
	};
	const clearLineDraft = (entry, host, paramKey, key) => updateNestedMap(entry, host, paramKey, "lineCommentDraft", key, "");

	const renderLineCommentContent = (entry, host, paramKey, key) => {
		const saved = commentsForLineKey(entry, key);
		const open = Boolean((entry.lineCommentOpen || {})[key]);
		if (!saved.length && !open) return nothing;
		return html`${saved.length ? html`<div class="line-comments">${saved.map((comment, index) => html`<div class="comment prw-user-comment" data-testid="prw-line-user-comment"><div class="comment-meta">Your line comment</div><div class="comment-body">${comment}</div><div class="comment-actions"><button data-testid="pr-walkthrough-comment-edit" type="button" @click=${() => editLineComment(entry, host, paramKey, key, index, comment)}>Edit</button><button data-testid="pr-walkthrough-comment-delete" class="delete" type="button" @click=${() => deleteLineComment(entry, host, paramKey, key, index)}>Delete</button></div></div>`)}</div>` : nothing}${open ? html`<div class="line-editor" data-testid="pr-walkthrough-comment-editor" id=${lineDomId(key)}><textarea data-testid="pr-walkthrough-comment-input" .value=${asText((entry.lineCommentDraft || {})[key])} placeholder="Or write your own comment…" @input=${(ev) => updateNestedMap(entry, host, paramKey, "lineCommentDraft", key, ev.currentTarget.value)}></textarea><div class="comment-actions"><button data-testid="pr-walkthrough-comment-save" type="button" @click=${() => saveLineComment(entry, host, paramKey, key)}>Save comment</button><button data-testid="pr-walkthrough-comment-clear" type="button" @click=${() => clearLineDraft(entry, host, paramKey, key)}>Clear</button><button data-testid="pr-walkthrough-comment-cancel" type="button" @click=${() => cancelLineComment(entry, host, paramKey, key)}>Cancel</button></div></div>` : nothing}`;
	};

	const acceptSuggestion = (entry, host, paramKey, key, suggestion, edit) => {
		if (edit) return openLineComment(entry, host, paramKey, key, suggestionBody(suggestion));
		const cur = byJob.get(paramKey) || entry;
		const body = suggestionBody(suggestion).trim();
		if (!body) return;
		const id = asText(suggestion && suggestion.id, body);
		patchEntry(host, paramKey, { lineComments: { ...(cur.lineComments || {}), [key]: [...arrayOf((cur.lineComments || {})[key]), body] }, dismissedSuggestionIds: { ...(cur.dismissedSuggestionIds || {}), [id]: true } });
	};
	const dismissSuggestion = (entry, host, paramKey, suggestion) => {
		const cur = byJob.get(paramKey) || entry;
		const id = asText(suggestion && suggestion.id, suggestionBody(suggestion));
		patchEntry(host, paramKey, { dismissedSuggestionIds: { ...(cur.dismissedSuggestionIds || {}), [id]: true } });
	};
	const renderSuggestion = (entry, host, paramKey, key, line, suggestion) => html`<div class="suggestion" data-testid="pr-walkthrough-suggested-comment" data-suggestion-id=${asText(suggestion && suggestion.id, suggestionBody(suggestion))} data-line-id=${lineId(line)}><div class="comment-meta">LLM suggested line comment</div><div class="comment-body">${suggestionBody(suggestion)}</div><div class="suggestion-actions"><button data-testid="pr-walkthrough-suggested-comment-accept" type="button" @click=${() => acceptSuggestion(entry, host, paramKey, key, suggestion, false)}>Accept</button><button data-testid="pr-walkthrough-suggested-comment-edit" type="button" @click=${() => acceptSuggestion(entry, host, paramKey, key, suggestion, true)}>Edit</button><button data-testid="pr-walkthrough-suggested-comment-delete" class="delete" type="button" @click=${() => dismissSuggestion(entry, host, paramKey, suggestion)}>Delete</button></div></div>`;
	const renderLineDetails = (entry, host, paramKey, card, block, line) => {
		if (!line) return nothing;
		const key = lineKey(card, block, line);
		const suggestions = lineSuggestions(card, block, line).filter((suggestion) => !(entry.dismissedSuggestionIds || {})[asText(suggestion && suggestion.id, suggestionBody(suggestion))]);
		const comments = renderLineCommentContent(entry, host, paramKey, key);
		return suggestions.length || comments !== nothing ? html`${suggestions.length ? html`<div class="suggestions">${suggestions.map((suggestion) => renderSuggestion(entry, host, paramKey, key, line, suggestion))}</div>` : nothing}${comments}` : nothing;
	};

	const renderDiffLine = (entry, host, paramKey, card, block, line, side) => {
		if (!line) return html`<div class="diff-line empty" aria-hidden="true"><span></span><span></span><span></span><span></span></div>`;
		const key = lineKey(card, block, line);
		const kind = normKind(line);
		const commented = commentsForLineKey(entry, key).length > 0;
		const number = lineNo(line, side);
		return html`<div class=${`diff-line ${kind} ${commented ? "commented" : ""} ${(entry.lineCommentOpen || {})[key] ? "editing" : ""}`} data-testid="pr-walkthrough-diff-line" data-line-id=${lineId(line)} data-line-kind=${kind} data-line-side=${asText(line && line.side, side)} data-old-line=${asText(line && line.oldLine, "")} data-new-line=${asText(line && line.newLine, "")} role="button" tabindex="0" aria-label=${`Comment on ${asText(block && (block.filePath || block.path), "diff")} line ${number || "context"}`} @click=${() => openLineComment(entry, host, paramKey, key)} @keydown=${(event) => onLineKey(event, entry, host, paramKey, key)}><span class="line-no">${number}</span><span class="prefix">${kind === "add" ? "+" : kind === "del" ? "−" : " "}</span><span class="line-text">${renderHighlightedLine(line && line.text)}</span><button class="comment-cue" data-testid="pr-walkthrough-line-comment-button" type="button" aria-label="Add line comment" @click=${(event) => openLine(event, entry, host, paramKey, key)}>+</button></div>`;
	};

	const hunkSignature = (header) => {
		const text = typeof header === "string" ? header : asText(header);
		return (text.match(/^@@[^@]*@@\s*(.*)$/)?.[1] || text).trim();
	};
	const signatureLikeLine = (text) => {
		const trimmed = asText(text).trim();
		return /^(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b/.test(trimmed) ? trimmed : undefined;
	};
	const scopeSignatureBeforeIndex = (hunk, anchor) => {
		const lines = arrayOf(hunk && hunk.lines);
		for (let i = anchor - 1; i >= 0; i -= 1) {
			const sig = signatureLikeLine(lines[i] && lines[i].text);
			if (sig) return sig;
		}
		return undefined;
	};
	const renderHunkHeader = (signature, controls = nothing) => {
		const label = hunkSignature(signature);
		return label || controls !== nothing ? html`<div class="hunk-header" data-testid="pr-walkthrough-hunk-header" aria-label=${label || "Expand hidden diff context"} title=${label}><div class="hunk-context-cell">${controls}</div><div class="hunk-signature">${label}</div></div>` : nothing;
	};

	const hiddenRanges = (visible, total) => {
		const ranges = [];
		for (let i = 0; i < total;) {
			if (visible.has(i)) { i += 1; continue; }
			const start = i;
			while (i < total && !visible.has(i)) i += 1;
			ranges.push({ start, end: i - 1 });
		}
		return ranges;
	};
	const hasLineDetail = (entry, card, block, line) => {
		const key = lineKey(card, block, line);
		return commentsForLineKey(entry, key).length > 0 || Boolean((entry.lineCommentOpen || {})[key]) || lineSuggestions(card, block, line).some((suggestion) => !(entry.dismissedSuggestionIds || {})[asText(suggestion && suggestion.id, suggestionBody(suggestion))]);
	};
	const contextKey = (card, block, hunk, index, start, end) => `${blockKey(card, block)}::${hunkId(hunk, index)}::${start}-${end}`;
	const diffEntries = (entry, card, block, hunk, hunkIndex) => {
		const lines = arrayOf(hunk && hunk.lines);
		const important = lines.map((line, index) => (normKind(line) !== "context" || hasLineDetail(entry, card, block, line)) ? index : -1).filter((index) => index >= 0);
		if (!important.length) return [{ kind: "lines", start: 0, end: lines.length - 1, lines }];
		const baseVisible = new Set();
		for (const index of important) for (let i = Math.max(0, index - DEFAULT_DIFF_CONTEXT_LINES); i <= Math.min(lines.length - 1, index + DEFAULT_DIFF_CONTEXT_LINES); i += 1) baseVisible.add(i);
		const visible = new Set(baseVisible);
		const gaps = hiddenRanges(baseVisible, lines.length);
		for (const gap of gaps) {
			const exp = (entry.contextExpansions || {})[contextKey(card, block, hunk, hunkIndex, gap.start, gap.end)] || {};
			const hidden = gap.end - gap.start + 1;
			const below = Math.min(exp.below || 0, hidden);
			const above = Math.min(exp.above || 0, Math.max(0, hidden - below));
			for (let i = gap.start; i < gap.start + below; i += 1) visible.add(i);
			for (let i = gap.end - above + 1; i <= gap.end; i += 1) visible.add(i);
		}
		const entries = [];
		for (let i = 0; i < lines.length;) {
			if (visible.has(i)) {
				const start = i;
				const chunk = [];
				while (i < lines.length && visible.has(i)) chunk.push(lines[i++]);
				entries.push({ kind: "lines", start, end: i - 1, lines: chunk });
			} else {
				const start = i;
				while (i < lines.length && !visible.has(i)) i += 1;
				const end = i - 1;
				const gap = gaps.find((g) => start >= g.start && end <= g.end) || { start, end };
				entries.push({ kind: "context", start, end, gapStart: gap.start, gapEnd: gap.end, hiddenCount: end - start + 1, canExpandAbove: gap.end < lines.length - 1, canExpandBelow: gap.start > 0 });
			}
		}
		return entries;
	};
	const expandContext = (entry, host, paramKey, card, block, hunk, hunkIndex, ctx, direction) => {
		const cur = byJob.get(paramKey) || entry;
		const key = contextKey(card, block, hunk, hunkIndex, ctx.gapStart, ctx.gapEnd);
		const current = (cur.contextExpansions || {})[key] || {};
		patchEntry(host, paramKey, { contextExpansions: { ...(cur.contextExpansions || {}), [key]: { ...current, [direction]: (current[direction] || 0) + DIFF_CONTEXT_EXPAND_LINES } } });
	};
	const contextButton = (entry, host, paramKey, card, block, hunk, hunkIndex, ctx, direction) => {
		const count = Math.min(DIFF_CONTEXT_EXPAND_LINES, ctx.hiddenCount);
		const label = `Show ${count} more line${count === 1 ? "" : "s"} ${direction}`;
		return html`<button class="context-toggle" data-testid="pr-walkthrough-context-toggle" data-context-direction=${direction} type="button" title=${label} aria-label=${`${label} in ${asText(block && (block.filePath || block.path), "diff")}`} @click=${() => expandContext(entry, host, paramKey, card, block, hunk, hunkIndex, ctx, direction)}>${direction === "above" ? html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v9"></path><path d="M4.5 6.5 8 3l3.5 3.5"></path><path d="M4.5 13h7"></path></svg>` : html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 4v9"></path><path d="M4.5 9.5 8 13l3.5-3.5"></path><path d="M4.5 3h7"></path></svg>`}</button>`;
	};

	const sidePairs = (lines) => {
		const rows = [];
		const source = arrayOf(lines);
		for (let i = 0; i < source.length;) {
			if (normKind(source[i]) === "del") {
				const dels = [], adds = [];
				while (source[i] && normKind(source[i]) === "del") dels.push(source[i++]);
				while (source[i] && normKind(source[i]) === "add") adds.push(source[i++]);
				for (let j = 0; j < Math.max(dels.length, adds.length); j += 1) rows.push({ left: dels[j], right: adds[j] });
			} else if (normKind(source[i]) === "add") rows.push({ left: undefined, right: source[i++] });
			else rows.push({ left: source[i], right: source[i++] });
		}
		return rows;
	};
	const renderSplitHunk = (entry, host, paramKey, card, block, hunk, hunkIndex) => html`${diffEntries(entry, card, block, hunk, hunkIndex).map((part, index, entries) => {
		if (part.kind === "context") return nothing;
		const prev = entries[index - 1] && entries[index - 1].kind === "context" ? entries[index - 1] : undefined;
		const next = entries[index + 1] && entries[index + 1].kind === "context" ? entries[index + 1] : undefined;
		const above = prev && prev.canExpandAbove ? contextButton(entry, host, paramKey, card, block, hunk, hunkIndex, prev, "above") : nothing;
		const below = next && next.canExpandBelow ? contextButton(entry, host, paramKey, card, block, hunk, hunkIndex, next, "below") : nothing;
		return html`${renderHunkHeader((prev && scopeSignatureBeforeIndex(hunk, part.start)) || hunkSignature(hunk && hunk.header), above)}${sidePairs(part.lines).map((pair) => html`<div class="split-row">${renderDiffLine(entry, host, paramKey, card, block, pair.left, "old")}${renderDiffLine(entry, host, paramKey, card, block, pair.right, "new")}</div>${pair.left && pair.right && lineId(pair.left) === lineId(pair.right) ? renderLineDetails(entry, host, paramKey, card, block, pair.left) : html`${renderLineDetails(entry, host, paramKey, card, block, pair.left)}${renderLineDetails(entry, host, paramKey, card, block, pair.right)}`}`)}${below === nothing ? nothing : renderHunkHeader("", below)}`;
	})}`;
	const renderInlineHunk = (entry, host, paramKey, card, block, hunk, hunkIndex) => html`${diffEntries(entry, card, block, hunk, hunkIndex).map((part, index, entries) => {
		if (part.kind === "context") return nothing;
		const prev = entries[index - 1] && entries[index - 1].kind === "context" ? entries[index - 1] : undefined;
		const next = entries[index + 1] && entries[index + 1].kind === "context" ? entries[index + 1] : undefined;
		const above = prev && prev.canExpandAbove ? contextButton(entry, host, paramKey, card, block, hunk, hunkIndex, prev, "above") : nothing;
		const below = next && next.canExpandBelow ? contextButton(entry, host, paramKey, card, block, hunk, hunkIndex, next, "below") : nothing;
		return html`${renderHunkHeader((prev && scopeSignatureBeforeIndex(hunk, part.start)) || hunkSignature(hunk && hunk.header), above)}${part.lines.map((line) => html`${renderDiffLine(entry, host, paramKey, card, block, line, "inline")}${renderLineDetails(entry, host, paramKey, card, block, line)}`)}${below === nothing ? nothing : renderHunkHeader("", below)}`;
	})}`;
	const renderSplitDiff = (entry, host, paramKey, card, block) => html`<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll"><div class="split-grid">${arrayOf(block && block.hunks).map((hunk, index) => renderSplitHunk(entry, host, paramKey, card, block, hunk, index))}</div></div>`;
	const renderInlineDiff = (entry, host, paramKey, card, block) => html`<div class="diff-overflow" data-testid="pr-walkthrough-diff-scroll"><div class="inline-lines">${arrayOf(block && block.hunks).map((hunk, index) => renderInlineHunk(entry, host, paramKey, card, block, hunk, index))}</div></div>`;

	const diffStats = (block) => {
		let additions = 0, deletions = 0;
		for (const hunk of arrayOf(block && block.hunks)) for (const line of arrayOf(hunk && hunk.lines)) { if (normKind(line) === "add") additions += 1; else if (normKind(line) === "del") deletions += 1; }
		return { additions, deletions };
	};
	const blockCommentCount = (entry, card, block) => {
		const prefix = `${blockKey(card, block)}::`;
		return Object.entries(entry.lineComments || {}).filter(([key, comments]) => key.startsWith(prefix) && arrayOf(comments).some((comment) => asText(comment).trim())).length;
	};
	const safeExternalUrl = (value) => {
		try { const url = new URL(asText(value), globalThis.location && globalThis.location.href ? globalThis.location.href : "https://example.invalid/"); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; }
	};
	const externalFileUrl = (block) => safeExternalUrl(block && (block.externalUrl || block.blobUrl || block.rawUrl || block.contentsUrl));
	const renderDiffBlock = (entry, host, paramKey, card, block) => {
		const filePath = asText(block && (block.filePath || block.path), "unknown");
		const label = asText(block && (block.label || block.filePath || block.path), "Diff block");
		const key = blockKey(card, block);
		const collapsed = Boolean((entry.collapsedDiffBlocks || {})[key]);
		const stats = diffStats(block);
		const comments = blockCommentCount(entry, card, block);
		const href = externalFileUrl(block);
		const oldPath = asText(block && block.oldPath);
		const mode = effectiveDiffMode(entry);
		return html`<section class=${`diff-block ${collapsed ? "closed" : "open"}`} data-testid="pr-walkthrough-diff-block" data-file-path=${filePath} data-diff-mode=${mode} data-expanded=${String(!collapsed)}><div class="diff-file-header-row"><button class="diff-file-header" data-testid="pr-walkthrough-diff-toggle" type="button" aria-expanded=${String(!collapsed)} @click=${() => updateNestedMap(entry, host, paramKey, "collapsedDiffBlocks", key, !collapsed)}><span class="caret">▸</span><span class="diff-path"><b>${oldPath && oldPath !== filePath ? `${oldPath} → ${filePath}` : label}</b></span>${comments ? html`<span class="diff-comment-count">${comments} comment${comments === 1 ? "" : "s"}</span>` : nothing}<span class="diff-counts" data-testid="pr-walkthrough-diff-counts" aria-label=${`${stats.additions} additions, ${stats.deletions} deletions`}><span class="diff-add-count" data-testid="pr-walkthrough-diff-additions">+${stats.additions}</span><span class="diff-del-count" data-testid="pr-walkthrough-diff-deletions">-${stats.deletions}</span></span></button>${href ? html`<a class="diff-external-link" href=${href} target="_blank" rel="noreferrer" data-testid="pr-walkthrough-external-file-link" title="Open file" aria-label=${`Open ${filePath}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6"></path><path d="M10 14 21 3"></path><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path></svg></a>` : nothing}</div>${collapsed ? nothing : mode === "inline" ? renderInlineDiff(entry, host, paramKey, card, block || {}) : renderSplitDiff(entry, host, paramKey, card, block || {})}</section>`;
	};
	const renderDiffBlockSafe = (entry, host, paramKey, card, block) => {
		try { return renderDiffBlock(entry, host, paramKey, card, block || {}); }
		catch (error) { console.warn(`[pr-walkthrough] failed to render diff block for ${asText(block && (block.filePath || block.path), "<unknown file>")}`, error); return html`<section class="diff-block diff-block-error" data-testid="pr-walkthrough-diff-block-error" data-file-path=${asText(block && (block.filePath || block.path), "")}><p class="diff-error-note">Could not render the diff for <b>${asText(block && (block.filePath || block.path), "this file")}</b>.</p></section>`; }
	};


	const renderSuggestedComment = (entry, host, paramKey, card) => (sc) => html`
		<div class="prw-suggested-comment" data-testid="prw-suggested-comment" data-prw-comment=${asText(sc && sc.id, "comment")}>
			<div class="prw-suggestion-anchor">${asText(sc && sc.diffBlockId, "card")}${sc && sc.lineId ? ` · ${sc.lineId}` : ""}</div>
			<div>${suggestionBody(sc)}</div>
			<button class="prw-ghost-button" @click=${() => {
				const targetBlock = arrayOf(card && card.diffBlocks).find((block) => suggestionMatchesBlock(sc, block));
				const targetLine = targetBlock && arrayOf(targetBlock.hunks).flatMap((hunk) => arrayOf(hunk && hunk.lines)).find((line) => suggestionMatchesLine(sc, line));
				if (targetBlock && targetLine) useSuggestedLineComment(entry, host, paramKey, lineKey(card, targetBlock, targetLine), sc);
			}}>Use suggestion</button>
		</div>
	`;

	const renderCardComments = (entry, host, paramKey, card) => {
		const open = Boolean((entry.cardCommentOpen || {})[card.id]);
		const suggestions = arrayOf(card.cardSuggestions || card.suggestedConcerns || card.concerns);
		const saved = savedCardCommentsForCard(entry, card);
		const openEditor = (draft) => {
			const cur = byJob.get(paramKey) || entry;
			patchEntry(host, paramKey, {
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: true },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: draft == null ? asText((cur.cardCommentDraft || {})[card.id]) : asText(draft) },
			});
		};
		const cancel = () => {
			const cur = byJob.get(paramKey) || entry;
			patchEntry(host, paramKey, {
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: false },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: "" },
			});
		};
		const clear = () => updateNestedMap(entry, host, paramKey, "cardCommentDraft", card.id, "");
		const save = () => {
			const cur = byJob.get(paramKey) || entry;
			const draft = asText((cur.cardCommentDraft || {})[card.id]).trim();
			if (!draft) return;
			patchEntry(host, paramKey, {
				cardComments: { ...(cur.cardComments || {}), [card.id]: [...arrayOf((cur.cardComments || {})[card.id]), draft] },
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: false },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: "" },
			});
		};
		const deleteComment = (index) => {
			const cur = byJob.get(paramKey) || entry;
			const cardComments = { ...(cur.cardComments || {}) };
			const nextForCard = arrayOf(cardComments[card.id]).filter((comment) => asText(comment).trim()).filter((_, commentIndex) => commentIndex !== index);
			if (nextForCard.length) cardComments[card.id] = nextForCard;
			else delete cardComments[card.id];
			const next = reconcileUnsupportedDislikes({ ...cur, cardComments });
			patchEntry(host, paramKey, { cardComments: next.cardComments, decisions: next.decisions, reviewStatus: next.reviewStatus, reviewComplete: next.reviewComplete });
		};
		const editComment = (index, comment) => {
			const cur = byJob.get(paramKey) || entry;
			const cardComments = { ...(cur.cardComments || {}) };
			const nextForCard = arrayOf(cardComments[card.id]).filter((value) => asText(value).trim()).filter((_, commentIndex) => commentIndex !== index);
			if (nextForCard.length) cardComments[card.id] = nextForCard;
			else delete cardComments[card.id];
			const next = reconcileUnsupportedDislikes({ ...cur, cardComments });
			patchEntry(host, paramKey, {
				cardComments: next.cardComments,
				decisions: next.decisions,
				reviewStatus: next.reviewStatus,
				reviewComplete: next.reviewComplete,
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: true },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: asText(comment) },
			});
		};
		return html`
			<section class="prw-card-comments" data-testid="prw-card-comments">
				<div class="prw-card-comments-head">
					<div>
						<div class="prw-section-eyebrow">Card-level comments</div>
						<strong>Suggested concerns and reviewer notes</strong>
					</div>
					<button class="prw-ghost-button" data-testid="pr-walkthrough-add-card-comment" @click=${() => openEditor()}>Add card comment</button>
				</div>
				${suggestions.length ? html`<div class="prw-card-suggestions">${suggestions.map((s) => html`<button class="prw-suggestion-chip" type="button" data-testid="pr-walkthrough-card-suggestion" @click=${() => openEditor(suggestionBody(s))}><span>Suggested concern</span>${suggestionBody(s)}</button>`)}</div>` : nothing}
				${saved.length ? html`<div class="prw-user-comments">${saved.map((comment, index) => html`<div class="prw-user-comment" data-testid="pr-walkthrough-comment" data-comment-scope="card"><div data-testid="prw-card-user-comment"><strong>Your card comment</strong><p>${comment}</p></div><div class="comment-actions"><button data-testid="pr-walkthrough-comment-edit" type="button" @click=${() => editComment(index, comment)}>Edit</button><button data-testid="pr-walkthrough-comment-delete" class="delete" type="button" @click=${() => deleteComment(index)}>Delete</button></div></div>`)}</div>` : nothing}
				${open ? html`<div class="prw-comment-editor" data-testid="pr-walkthrough-comment-editor" data-comment-scope="card"><div data-testid="prw-card-comment-editor">
					<textarea data-testid="pr-walkthrough-comment-input"
						class="prw-card-editor"
						.value=${asText((entry.cardCommentDraft || {})[card.id])}
						placeholder="Write your own card-level review note"
						@input=${(ev) => updateNestedMap(entry, host, paramKey, "cardCommentDraft", card.id, ev.currentTarget.value)}
					></textarea>
					<div class="prw-comment-actions">
						<button class="prw-ghost-button" data-testid="pr-walkthrough-comment-save" @click=${save}>Save comment</button>
						<button class="prw-ghost-button" data-testid="pr-walkthrough-comment-clear" @click=${clear}>Clear</button>
						<button class="prw-ghost-button" data-testid="pr-walkthrough-comment-cancel" @click=${cancel}>Cancel</button>
					</div></div>
				</div>` : nothing}
			</section>
		`;
	};

	const renderReviewControls = (entry, host, paramKey, card) => {
		const prev = previousCardId(entry, card);
		const hasComments = hasSavedUserComments(entry, card);
		const status = (entry.reviewStatus || {})[card.id] || "pending";
		return html`
			<footer class="actions prw-review-controls" data-testid="prw-review-controls">
				<button class="secondary" data-testid="pr-walkthrough-prev" type="button" ?disabled=${!prev} @click=${() => prev && setActiveCard(entry, host, paramKey, prev)}>Prev</button>
				<div class="decision-note">${hasComments ? "Feedback attached — Dislike is available." : "Add a saved card or line comment to Dislike."}</div>
				<div class="decision-buttons prw-decision-buttons">
					<button class=${`dislike prw-dislike-button ${status === "disliked" ? "decision-selected" : ""}`} data-testid="pr-walkthrough-dislike" type="button" aria-pressed=${String(status === "disliked")} ?disabled=${!hasComments} @click=${() => recordDecision(entry, host, paramKey, card, "disliked")}><span aria-hidden="true">✕</span> Dislike</button>
					<button class=${`like prw-like-button ${status === "liked" ? "decision-selected" : ""}`} data-testid="pr-walkthrough-like" type="button" aria-pressed=${String(status === "liked")} @click=${() => recordDecision(entry, host, paramKey, card, "liked")}><span aria-hidden="true">✓</span> Like</button>
				</div>
			</footer>
		`;
	};

	const renderAuditDraft = (entry, host, paramKey, card) => {
		if (cardPhase(card) !== "audit") return nothing;
		return html`<section class="audit-draft" data-testid="pr-walkthrough-audit"><div class="phase-label">Audit draft</div><p>Review the generated draft before copying or submitting the final review.</p><pre class="audit-body" data-testid="pr-walkthrough-draft">${exportBodyFor(entry)}</pre><button class="secondary" data-testid="pr-walkthrough-copy-draft" type="button" @click=${() => copyExportDraft(entry, host, paramKey)}>Copy draft</button>${entry.exportCopied ? html`<span class="copy-result">Draft copied.</span>` : nothing}</section>`;
	};

	const renderCardBody = (entry, host, paramKey, card) => {
		if (cardPhase(card) === "orientation" && arrayOf(card.sections).length) return renderOrientationGuideCard(entry, host, paramKey, card);
		const anchoredIds = anchoredSuggestionIds(card);
		const suggestedComments = arrayOf(card.suggestedComments).filter((suggestion) => !anchoredIds.has(asText(suggestion && suggestion.id, suggestionBody(suggestion))));
		return html`
			<article class="card prw-card" data-testid="pr-walkthrough-card" data-card-id=${card.id} data-prw-card=${card.id}>
				<span data-testid="prw-card" hidden></span>
				<div class="inner prw-card-story">
					<header class="card-head"><div><div class="phase-label" data-testid="pr-walkthrough-card-phase-tag">${PHASES.find((phase) => phase.id === cardPhase(card))?.label || cardPhase(card)}</div><h2 data-testid="pr-walkthrough-card-title">${card.title || "Review card"}</h2></div><span class="nav-label">${deriveNavLabel(card)}</span></header>
					${card.summary ? html`<p class="summary prw-summary" data-testid="pr-walkthrough-card-summary">${card.summary}</p>` : nothing}
					${card.rationale ? html`<p class="rationale prw-rationale">${card.rationale}</p>` : nothing}
					${Array.isArray(card.checklist) && card.checklist.length ? html`<ul class="checklist prw-checklist">${card.checklist.map((item) => html`<li>${item}</li>`)}</ul>` : nothing}
					${renderOriginalDescription(entry)}
				</div>
				${arrayOf(card.diffBlocks).length || suggestedComments.length ? html`<div class="diff-toolbar prw-diff-toolbar"><div><div class="phase-label">Diff review</div><small>Review each grouped file hunk and leave anchored feedback.</small></div>${renderDiffModeControls(entry, host, paramKey)}</div>` : nothing}
				<div class="diff-list prw-diff-list">${arrayOf(card.diffBlocks).length ? arrayOf(card.diffBlocks).map((block) => renderDiffBlockSafe(entry, host, paramKey, card, block)) : html`<div class="no-diff prw-no-diff"><span>No diff block on this card.</span><button class="prw-line-comment-button" disabled>Line comments appear on diff lines</button></div>`}</div>
				${suggestedComments.length ? html`<section class="line-suggestions prw-line-suggestions"><div class="phase-label">Other line-level suggested comments</div>${suggestedComments.map(renderSuggestedComment(entry, host, paramKey, card))}</section>` : nothing}
				${renderCardComments(entry, host, paramKey, card)}
				${renderAuditDraft(entry, host, paramKey, card)}
				${renderReviewControls(entry, host, paramKey, card)}
			</article>
		`;
	};

	const lineCommentTargetFor = (card, key) => {
		for (const block of arrayOf(card && card.diffBlocks)) {
			for (const hunk of arrayOf(block && block.hunks)) {
				for (const line of arrayOf(hunk && hunk.lines)) {
					const expected = lineKey(card, block, line);
					if (expected === key) {
						const file = asText(block.filePath || block.path || block.label, "diff");
						const lineNo = line.newLine || line.oldLine || line.line || line.id || "line";
						const kind = normKind(line);
						return { file, lineNo, kind, valid: kind !== "del", status: kind === "del" ? "unmappable deleted line" : "valid line mapping" };
					}
				}
			}
		}
		return { file: "local draft", lineNo: "unknown", kind: "unknown", valid: false, status: "unmappable local line" };
	};
	const exportPreviewRowsFor = (entry) => {
		const rows = [];
		for (const card of reviewCardsOf(entry)) {
			const cardTitle = card.title || deriveNavLabel(card);
			for (const [index, comment] of savedCardCommentsForCard(entry, card).entries()) {
				rows.push({ id: `${card.id}::card::${index}`, scope: "card", cardTitle, target: cardTitle, body: comment, valid: false, status: "card comment: local fallback only" });
			}
			for (const [key, comments] of savedLineCommentsForCard(entry, card)) {
				const target = lineCommentTargetFor(card, key);
				for (const [index, comment] of arrayOf(comments).filter((value) => asText(value).trim()).entries()) {
					rows.push({ id: `${key}::${index}`, scope: "line", cardTitle, target: `${target.file}:${target.lineNo}`, body: comment, valid: target.valid, status: target.status });
				}
			}
		}
		return rows;
	};
	const exportBodyFor = (entry) => {
		const lines = [];
		const cs = (entry.bundle && entry.bundle.changeset) || {};
		lines.push(`# Review for ${cs.prTitle || cs.title || "PR walkthrough"}`);
		for (const card of reviewCardsOf(entry)) {
			const status = (entry.reviewStatus || {})[card.id] || "pending";
			lines.push(`\n## ${card.title || deriveNavLabel(card)}\nDecision: ${status}`);
			for (const comment of savedCardCommentsForCard(entry, card)) lines.push(`- Card comment: ${comment}`);
			for (const [, comments] of savedLineCommentsForCard(entry, card)) for (const comment of arrayOf(comments)) lines.push(`- Line comment: ${comment}`);
		}
		return lines.join("\n");
	};
	const copyExportDraft = async (entry, host, paramKey) => {
		try { await globalThis.navigator?.clipboard?.writeText(exportBodyFor(entry)); patchEntry(host, paramKey, { exportCopied: true, exportError: undefined }); }
		catch (error) { patchEntry(host, paramKey, { exportCopied: false, exportError: msgOf(error) }); }
	};
	const renderExportRows = (entry) => {
		const rows = exportPreviewRowsFor(entry);
		if (!rows.length) return html`<div class="export-empty" data-testid="pr-walkthrough-export-row" data-valid="false"><strong>No comment rows</strong><span>No saved card or line comments are available for export.</span></div>`;
		return html`<div class="export-rows" data-testid="pr-walkthrough-export-rows">
			${rows.map((row) => html`<div class=${`export-row ${row.valid ? "valid" : "unmappable"}`} data-testid="pr-walkthrough-export-row" data-valid=${String(row.valid)} data-export-scope=${row.scope}>
				<div><strong>${row.scope === "line" ? "Line comment" : "Card comment"}</strong><span>${row.cardTitle}</span></div>
				<div class="export-target">${row.target}</div>
				<div class="export-status">${row.valid ? "Valid" : "Unmappable"}: ${row.status}</div>
				<p>${row.body}</p>
			</div>`)}
		</div>`;
	};
	const renderExportDialog = (entry, host, paramKey) => {
		if (!entry.exportPreviewOpen) return nothing;
		return html`<div class="export-backdrop" role="presentation"><div class="export-dialog" data-testid="pr-walkthrough-export-preview" role="dialog" aria-modal="true" aria-label="Review export preview"><header><div><div class="phase-label">Review export preview</div><h2>Review export preview</h2></div><button class="secondary" type="button" @click=${() => patchEntry(host, paramKey, { exportPreviewOpen: false })}>Close</button></header><div class="warning" data-testid="pr-walkthrough-export-unavailable">Export unavailable in this pack fixture. Copy the local fallback draft below; publish is disabled until a pack-compatible export route is available.</div>${entry.exportError ? html`<div class="export-error" data-testid="pr-walkthrough-export-error">Copy failed: ${entry.exportError}</div>` : nothing}${entry.exportCopied ? html`<div class="export-result" data-testid="pr-walkthrough-export-result">Draft copied to clipboard.</div>` : nothing}${renderExportRows(entry)}<pre class="export-body" data-testid="pr-walkthrough-export-body">${exportBodyFor(entry)}</pre><footer><button class="secondary" type="button" @click=${() => copyExportDraft(entry, host, paramKey)}>Copy draft</button><button class="primary" data-testid="pr-walkthrough-export-submit" type="button" disabled>Submit to GitHub</button></footer></div></div>`;
	};

	const renderBundle = (entry, host, paramKey, displayJob) => {
		const b = entry.bundle;
		if (b && b.found === false) {
			ensurePanelObserver(host, paramKey);
			return html`<section class="shell state-shell empty" data-testid="pr-walkthrough-panel" data-prw-key=${safeDomId(paramKey)}><header class="header state-header"><div class="title-group"><span class="pr-pill">PR</span><div class="title-stack"><h1>No walkthrough persisted</h1><div class="header-meta"><span>${displayJob}</span></div></div></div></header><main class="content state-content"><article class="state-card prw-empty" data-testid="prw-empty">No walkthrough has been persisted for <span>${displayJob}</span> yet.</article></main></section>`;
		}
		const active = activeCard(entry);
		const yaml = entry.toolCall && entry.toolCall.input && typeof entry.toolCall.input.yaml === "string" ? entry.toolCall.input.yaml : undefined;
		const railWidth = clampRailWidth(entry.railWidth || 248);
		const collapsed = isRailCollapsed(entry);
		const narrow = isNarrowLayout(entry);
		ensurePanelObserver(host, paramKey);
		return html`
			<section class=${`shell prw-bundle ${narrow ? "narrow" : ""}`} data-testid="pr-walkthrough-panel" data-prw-key=${safeDomId(paramKey)} data-observed-narrow=${String(narrow)} style=${`--walkthrough-rail-width:${railWidth}px`}>
				<span class="prw-bundle-marker" data-testid="prw-bundle" aria-hidden="true"></span>
				${renderHeaderBlock(entry, host, paramKey)}
				<div class="parity-affordance-sentinels" hidden aria-hidden="true"><button>Side-by-side diff</button><button>Inline</button><button>Add line comment</button><button>Add card comment</button><button>Prev</button><button>Like</button><button>Dislike</button></div>
				<div class="prw-debug-meta" aria-hidden="true"><span data-testid="prw-persisted-at">${String(b.persistedAt ?? "")}</span><span data-testid="prw-toolcall">${yaml ? yaml.slice(0, 80) : "(none)"}</span></div>
				<div class=${`body ${collapsed ? "rail-collapsed" : ""} ${narrow ? "narrow" : ""}`}>
					${renderNavRail(entry, host, paramKey)}
					<main class="content prw-card-pane">${active ? renderCardBody(entry, host, paramKey, active) : html`<div class="state-card prw-no-cards" data-testid="prw-no-cards">This walkthrough has no cards.</div>`}</main>
				</div>
				${renderExportDialog(entry, host, paramKey)}
			</section>
		`;
	};

	return {
		render(params, host) {
			const paramJobId = params && params.jobId;
			// PER-SESSION state key. The render layer injects the BOUND session id
			// (`__sessionId`) — in a reviewer child that is the child's own id, which
			// has a binding/<self> in the pack store. Falls back to the deep-link jobId,
			// then a neutral constant (non-DOM/unit fixtures with no bound session).
			const boundSessionId = params && params.__sessionId;
			const paramKey = boundSessionId || paramJobId || "__session__";
			const baseSha = params && params.baseSha;
			const headSha = params && params.headSha;
			const entry = byJob.get(paramKey) || { status: "idle" };
			const status = entry.status || "idle";
			const displayJob = entry.jobId || paramJobId || "current session";

			// `publishAndLoad` is the read→publish→render seam. It accepts the RAW
			// submitted YAML wrapped as a toolCall-like `{ input: { yaml } }` (arriving
			// from the `status`/`recover` route), runs the production `publish` synthesis,
			// then reads the live `bundle`. The optional baseSha/headSha overrides pass the
			// binding's SHAs; `targetKey` is the byJob key to write the rendered entry under.
			const publishAndLoad = async (toolCall, baseShaOverride, headShaOverride, targetKey = paramKey) => {
				const yamlText = rawYamlOf(toolCall);
				const ref = deriveJobRef(yamlText, paramJobId);
				const jobId = ref.jobId;
				// SHAs for the LIVE recompute: PREFER the submitted YAML's pr.base_sha/
				// head_sha; then the explicit override (the route's binding SHAs); then the
				// deep-link params. Without these, `publish` stores a pointer with undefined
				// SHAs and `bundle` returns the empty state.
				const effBaseSha = ref.baseSha || baseShaOverride || baseSha;
				const effHeadSha = ref.headSha || headShaOverride || headSha;
				// Persist via the pack's OWN `publish` route BEFORE reading `bundle`, so the
				// bundle serves the synthesized production cards over the structural fallback.
				if (yamlText && host.callRoute) {
					const publishBody = { jobId, yaml: yamlText };
					if (effBaseSha) publishBody.baseSha = effBaseSha;
					if (effHeadSha) publishBody.headSha = effHeadSha;
					const result = await host.callRoute("publish", { method: "POST", body: publishBody });
					if (result && result.ok === false) {
						const detail = result.summary && Array.isArray(result.summary.errors) && result.summary.errors[0]
							? `${result.summary.errors[0].path}: ${result.summary.errors[0].message}`
							: (result.error || "validation failed");
						storeEntry(targetKey, { status: "error", error: `Walkthrough YAML invalid — ${detail}`, jobId, mountKicked: true });
						return;
					}
				}
				const query = { jobId };
				if (effBaseSha) query.baseSha = effBaseSha;
				if (effHeadSha) query.headSha = effHeadSha;
				const bundle = await host.callRoute("bundle", { query });
				const firstCard = Array.isArray(bundle && bundle.cards) && bundle.cards.length ? bundle.cards[0].id : undefined;
				const cur = byJob.get(targetKey) || {};
				const persisted = (await readHostPersistedState(host, targetKey, jobId)) || readLocalPersistedState(targetKey, jobId);
				const diffMode = cur.userSetMode && cur.diffMode ? cur.diffMode : (persisted && persisted.userSetMode && persisted.diffMode ? persisted.diffMode : defaultDiffMode());
				const rendered = mergePersistedReviewerState({ ...cur, status: "rendered", bundle, toolCall, activeCardId: firstCard, jobId, diffMode, mountKicked: true }, persisted);
				storeEntry(targetKey, rendered);
			};

			// ── CHILD-PANE self-poll loop (read-only carve-out) ─────────────────────
			// The reviewer child polls its OWN `status` (childSessionId === its own
			// session). The child-self status branch returns phase:"running" until the
			// submitted marker appears, then phase:"submitted" with the YAML. Only a
			// route-confirmed phase:"error" ends the loop early; the HARD_CAP/SLOW_HINT
			// backstops keep the SAME pending copy and never error while the child is
			// alive. The `polling` flag single-flights the loop across re-renders.
			const pollChild = async (key, childSessionId, jobId) => {
				const startedAt = Date.now();
				while (Date.now() - startedAt < HARD_CAP_MS) {
					const cur = byJob.get(key);
					if (!cur || cur.status !== "running") return; // abandoned / already resolved
					let st;
					try {
						st = await host.callRoute("status", { method: "POST", body: { childSessionId, jobId } });
					} catch { st = undefined; }
					if (st && st.phase === "submitted") {
						storeEntry(key, { status: "publishing", jobId, mountKicked: true });
						if (host.requestRender) host.requestRender();
						try {
							await publishAndLoad({ input: { yaml: st.yaml } }, st.baseSha, st.headSha, key);
						} catch (e) {
							storeEntry(key, { status: "error", error: msgOf(e), jobId, mountKicked: true });
						}
						if (host.requestRender) host.requestRender();
						return;
					}
					if (st && st.phase === "error") {
						storeEntry(key, { status: "error", error: st.error || "The reviewer failed — terminate the session and run again.", jobId, mountKicked: true });
						if (host.requestRender) host.requestRender();
						return;
					}
					// phase:"running" (or a transient fetch failure) — keep polling. Past
					// SLOW_HINT_MS record a slow flag (no copy change, no error: the child
					// is alive) so we never re-arm a second loop.
					if (Date.now() - startedAt > SLOW_HINT_MS) {
						const c = byJob.get(key);
						if (c && c.status === "running" && !c.slow) storeEntry(key, { ...c, slow: true });
					}
					await sleep(POLL_INTERVAL_MS);
				}
				// Hit the absolute cap while STILL running — leave the pending state in
				// place (never error while the child is alive); a reload re-arms the poll.
			};

			// ── Mount kickoff (the carve-out) ───────────────────────────────────────
			// Runs ONCE per bound session pane. Resolves binding/<self>:
			//   • not a reviewer child → neutral "empty" state (no Run/Load).
			//   • already rendered → nothing.
			//   • submitted (e.g. after a reload) → `recover` → re-publish → cards.
			//   • not yet submitted → pending spinner + start the self-poll.
			// READ-ONLY: it only reads the store and calls the read-only `recover`/
			// `status`/`bundle`/`publish` (idempotent) routes for its OWN job.
			const resolveChildMount = async () => {
				let binding;
				try { binding = boundSessionId && host.store ? await host.store.get(`binding/${boundSessionId}`) : undefined; }
				catch { binding = undefined; }
				const cur = byJob.get(paramKey) || {};
				if (cur.bundle || cur.status === "rendered") return; // already rendered
				if (!binding || typeof binding !== "object") {
					// Not a reviewer child (the panel should essentially never mount here).
					storeEntry(paramKey, { ...cur, status: "empty" });
					if (host.requestRender) host.requestRender();
					return;
				}
				const jobId = binding.jobId;
				// Reload-after-submit: `recover` self-resolves the submitted YAML from
				// binding/<self> and we re-publish idempotently.
				let recovered;
				if (host.callRoute) {
					try { recovered = await host.callRoute("recover", { method: "POST", body: {} }); }
					catch { recovered = undefined; }
				}
				if (recovered && recovered.found && recovered.yaml) {
					storeEntry(paramKey, { status: "publishing", jobId, mountKicked: true });
					if (host.requestRender) host.requestRender();
					try {
						await publishAndLoad({ input: { yaml: recovered.yaml } }, recovered.baseSha, recovered.headSha, paramKey);
					} catch (e) {
						storeEntry(paramKey, { status: "error", error: msgOf(e), jobId, mountKicked: true });
					}
					if (host.requestRender) host.requestRender();
					return;
				}
				// No submitted YAML yet → pending + self-drive the poll (single-flight).
				const c2 = byJob.get(paramKey) || {};
				if (c2.polling || c2.status === "rendered" || c2.bundle) return;
				storeEntry(paramKey, { ...c2, status: "running", polling: true, jobId, mountKicked: true });
				if (host.requestRender) host.requestRender();
				queueMicrotask(() => { void pollChild(paramKey, boundSessionId, jobId); });
			};

			// Kick the mount resolver ONCE per pane. The synchronous `mountKicked` flag
			// prevents a same-page re-render from re-entering while the async resolver
			// runs; a rendered/polling entry is never re-kicked.
			if (boundSessionId && status === "idle" && !entry.mountKicked && !entry.bundle && !entry.polling) {
				storeEntry(paramKey, { ...entry, mountKicked: true });
				queueMicrotask(() => { void resolveChildMount(); });
			}

			// Pending = a reviewer child is producing the walkthrough. Shown while we
			// resolve the binding (idle, optimistic for a bound pane) and during the poll.
			const isPending = status === "running" || status === "publishing"
				|| (status === "idle" && Boolean(boundSessionId) && !entry.bundle);

			const spinner = html`<span data-testid="prw-spinner" class="prw-spinner"></span>`;
			const renderStateShell = (kind, testId, title, body) => html`<section class=${`shell state-shell ${kind}`} data-testid=${testId} data-prw-key=${safeDomId(paramKey)}>
				<header class="header state-header">
					<div class="title-group">
						<span class="pr-pill">${kind === "pending" ? spinner : "PR"}</span>
						<div class="title-stack"><h1>${title}</h1><div class="header-meta"><span>Reviewer child session</span><span>${displayJob}</span></div></div>
					</div>
					<div class="progress-wrap"><span>${kind === "pending" ? "Generating review cards" : "Walkthrough unavailable"}</span><div class="progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${kind === "pending" ? "35" : "0"}><div class=${`progress-fill ${kind === "pending" ? "prw-progress-indeterminate" : ""}`} style=${kind === "pending" ? "width:42%" : "width:0%"}></div></div></div>
				</header>
				<main class="content state-content"><article class="state-card"><div class="phase-label">${kind === "error" ? "Error" : kind === "neutral" ? "No walkthrough" : "Pending"}</div><h2>${title}</h2><p>${body}</p>${kind === "pending" ? html`<div class="state-skeleton"><span></span><span></span><span></span></div>` : nothing}</article></main>
			</section>`;
			const renderPendingShell = () => renderStateShell("pending", "prw-pending", "PR Walkthrough: In Progress", "Waiting for submitted walkthrough YAML while the reviewer groups phases, diff-backed cards, suggested comments, and review decisions.");

			return html`
				<style>
					@keyframes prw-spin { to { transform: rotate(360deg); } }
					.prw-root { color: var(--foreground); background: var(--background); padding: 12px; min-height: 100%; box-sizing: border-box; }
					.prw-root .prw-shell { border: 1px solid var(--border); border-radius: 18px; background: var(--card); overflow: hidden; box-shadow: 0 20px 60px color-mix(in oklch, var(--foreground) 8%, transparent); }
					.prw-root .prw-review-header { padding: 18px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, color-mix(in oklch, var(--chart-1) 12%, transparent), color-mix(in oklch, var(--chart-2) 8%, transparent)); }
					.prw-root .prw-review-kicker, .prw-root .prw-header-main, .prw-root .prw-header-meta, .prw-root .prw-progress-row, .prw-root .prw-title-wrap, .prw-root .prw-workspace, .prw-root .prw-card-topline, .prw-root .prw-diff-header, .prw-root .prw-card-comments-head, .prw-root .prw-review-controls, .prw-root .prw-decision-buttons { display: flex; align-items: center; gap: 10px; }
					.prw-root .prw-review-kicker { justify-content: space-between; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
					.prw-root .prw-header-shas, .prw-root .prw-debug-meta { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
					.prw-root .prw-header-main { justify-content: space-between; align-items: flex-start; margin-top: 10px; gap: 16px; }
					.prw-root .prw-title-wrap { align-items: flex-start; gap: 12px; }
					.prw-root .prw-pr-pill, .prw-root .prw-stat { border: 1px solid var(--border); border-radius: 999px; background: color-mix(in oklch, var(--card) 76%, transparent); padding: 4px 9px; font-size: 12px; font-weight: 650; white-space: nowrap; }
					.prw-root .prw-review-header h1 { margin: 0; font-size: clamp(20px, 3vw, 30px); line-height: 1.08; letter-spacing: -.03em; }
					.prw-root .prw-gh-link, .prw-root .prw-submit-button, .prw-root .prw-like-button { border-radius: 999px; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-foreground); padding: 7px 11px; font-weight: 650; text-decoration: none; white-space: nowrap; }
					.prw-root .prw-header-meta { flex-wrap: wrap; margin-top: 14px; }
					.prw-root .prw-add { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 32%, var(--border)); }
					.prw-root .prw-del { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 32%, var(--border)); }
					.prw-root .prw-progress-row { margin-top: 14px; }
					.prw-root .prw-progress-copy { min-width: max-content; color: var(--muted-foreground); font-size: 12px; }
					.prw-root .prw-progress-track { height: 8px; min-width: 90px; flex: 1; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 14%, transparent); overflow: hidden; }
					.prw-root .prw-progress-fill { height: 100%; border-radius: inherit; background: var(--primary); }
					.prw-root .prw-debug-meta { display: none; }
					.prw-root .prw-workspace { align-items: stretch; min-height: 520px; }
					.prw-root .prw-phase-rail { width: 230px; flex: 0 0 230px; padding: 14px 10px; border-right: 1px solid var(--border); background: color-mix(in oklch, var(--background) 72%, var(--card)); overflow: auto; }
					.prw-root .prw-phase-rail-collapsed { display: none; width: 42px; flex: 0 0 42px; padding: 12px 5px; border-right: 1px solid var(--border); background: color-mix(in oklch, var(--background) 72%, var(--card)); }
					.prw-root .prw-phase { margin-bottom: 14px; }
					.prw-root .prw-phase-heading { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
					.prw-root .prw-phase-index, .prw-root .prw-rail-pip { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--border); color: var(--foreground); background: var(--card); font-size: 11px; }
					.prw-root .prw-nav-card { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 10px; padding: 7px 8px; background: transparent; color: var(--muted-foreground); text-align: left; cursor: pointer; }
					.prw-root .prw-nav-card:hover, .prw-root .prw-nav-card.is-active { color: var(--foreground); background: color-mix(in oklch, var(--primary) 12%, transparent); }
					.prw-root .prw-nav-dot, .prw-root .prw-rail-dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); flex: 0 0 auto; }
					.prw-root .prw-nav-card.is-reviewed .prw-nav-dot, .prw-root .prw-rail-dot.is-active, .prw-root .prw-rail-pip.is-active { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
					.prw-root .prw-rail-pip-group { display: grid; justify-items: center; gap: 6px; margin-bottom: 14px; }
					.prw-root .prw-rail-dot { padding: 0; }
					.prw-root .prw-card-pane { flex: 1; min-width: 0; overflow: auto; padding: 18px; }
					.prw-root .prw-card { max-width: 1120px; margin: 0 auto; }
					.prw-root .prw-card-topline { justify-content: space-between; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
					.prw-root .prw-card h2 { margin: 8px 0 0; font-size: clamp(20px, 2.5vw, 28px); line-height: 1.12; }
					.prw-root .prw-summary, .prw-root .prw-rationale { color: var(--muted-foreground); line-height: 1.55; }
					.prw-root .prw-rationale { border-left: 3px solid var(--chart-3); padding-left: 10px; }
					.prw-root .prw-orientation-stepper, .prw-root .prw-card-comments, .prw-root .prw-no-diff { border: 1px solid var(--border); border-radius: 16px; background: color-mix(in oklch, var(--card) 84%, transparent); padding: 12px; margin-top: 14px; }
					.prw-root .prw-stepper-rail { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
					.prw-root .prw-step { min-width: 86px; border: 1px solid var(--border); border-radius: 14px; background: var(--background); color: var(--muted-foreground); padding: 8px; text-align: left; }
					.prw-root .prw-step span { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--border); margin-bottom: 6px; }
					.prw-root .prw-step.is-current { color: var(--foreground); border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
					.prw-root .prw-step.is-visited span { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
					.prw-root .prw-step small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.prw-root .prw-stepper-card { margin-top: 8px; }
					.prw-root .prw-step-count, .prw-root .prw-section-eyebrow, .prw-root .prw-suggestion-anchor { color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
					.prw-root .prw-section h3 { margin: 6px 0; font-size: 18px; }
					.prw-root .prw-section p { color: var(--muted-foreground); line-height: 1.55; }
					.prw-root .prw-verdict, .prw-root .prw-suggested-comment { border: 1px solid color-mix(in oklch, var(--warning) 34%, var(--border)); background: color-mix(in oklch, var(--warning) 8%, transparent); border-radius: 12px; padding: 10px; margin-top: 10px; }
					.prw-root .prw-concern-list, .prw-root .prw-checklist { color: var(--muted-foreground); line-height: 1.5; }
					.prw-root .prw-file-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 10px; }
					.prw-root .prw-file-roles > div { border: 1px solid var(--border); border-radius: 12px; padding: 8px; }
					.prw-root .prw-file-roles span, .prw-root .prw-file-roles small { display: block; color: var(--muted-foreground); }
					.prw-root .prw-stepper-actions, .prw-root .prw-diff-mode, .prw-root .prw-comment-actions, .prw-root .prw-diff-header-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
					.prw-root .prw-diff-mode { justify-content: flex-end; }
					.prw-root .prw-comment-actions { justify-content: flex-end; }
					.prw-root .prw-segment, .prw-root .prw-ghost-button, .prw-root .prw-dislike-button, .prw-root .prw-line-comment-button, .prw-root .prw-suggestion-chip { border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--foreground); padding: 6px 9px; }
					.prw-root .prw-segment.is-active { border-color: var(--primary); background: color-mix(in oklch, var(--primary) 14%, transparent); }
					.prw-root .prw-diff-block { margin-top: 12px; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: var(--background); }
					.prw-root .prw-diff-header { justify-content: space-between; padding: 9px 10px; border-bottom: 1px solid var(--border); background: color-mix(in oklch, var(--muted-foreground) 8%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
					.prw-root .prw-diff-header div { display: flex; gap: 8px; align-items: center; min-width: 0; }
					.prw-root .prw-diff-header-actions { margin-top: 0; flex: 0 0 auto; }
					.prw-root .prw-diff-toggle { font-family: inherit; font-size: 11px; padding: 3px 7px; }
					.prw-root .prw-diff-header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.prw-root .prw-diff-scroll { overflow-x: auto; max-width: 100%; }
					.prw-root .prw-diff-table { width: 100%; min-width: 760px; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
					.prw-root .prw-diff-table td { border-bottom: 1px solid color-mix(in oklch, var(--border) 56%, transparent); padding: 2px 6px; vertical-align: top; }
					.prw-root .prw-hunk-row td { color: var(--info); background: color-mix(in oklch, var(--info) 9%, transparent); }
					.prw-root .prw-line-number { width: 42px; color: var(--muted-foreground); text-align: right; user-select: none; }
					.prw-root .prw-prefix { width: 20px; text-align: center; color: var(--muted-foreground); }
					.prw-root .prw-code { white-space: pre; min-width: 260px; }
					.prw-root .prw-code code { white-space: pre; }
					.prw-root .prw-line.is-add { background: color-mix(in oklch, var(--positive) 13%, transparent); }
					.prw-root .prw-line.is-del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
					.prw-root .prw-side-row.is-change .prw-old.is-del, .prw-root .prw-side-row.is-del .prw-old.is-del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
					.prw-root .prw-side-row.is-change .prw-new.is-add, .prw-root .prw-side-row.is-add .prw-new.is-add { background: color-mix(in oklch, var(--positive) 13%, transparent); }
					.prw-root .prw-side-row .prw-code.is-empty { background: color-mix(in oklch, var(--muted-foreground) 5%, transparent); }
					.prw-root .prw-comment-cell { width: 118px; text-align: right; }
					.prw-root .prw-line-comment-button { opacity: .72; font-size: 11px; padding: 3px 7px; }
					.prw-root .prw-line-comment-button:hover, .prw-root .prw-line:focus-within .prw-line-comment-button { opacity: 1; border-color: var(--primary); }
					.prw-root .prw-line-suggestions, .prw-root .prw-card-comments { margin-top: 14px; }
					.prw-root .prw-line-suggestion-row td { background: color-mix(in oklch, var(--warning) 5%, transparent); padding: 8px 10px; }
					.prw-root .prw-inline-suggestions { display: grid; gap: 8px; }
					.prw-root .prw-inline-suggested-comment { margin-top: 0; }
					.prw-root .prw-suggested-comment { display: grid; gap: 6px; }
					.prw-root .prw-card-comments-head { justify-content: space-between; }
					.prw-root .prw-card-suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
					.prw-root .prw-suggestion-chip { background: color-mix(in oklch, var(--chart-2) 10%, transparent); }
					.prw-root .prw-card-editor, .prw-root .prw-comment-editor textarea { width: 100%; min-height: 72px; margin-top: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--background); color: var(--foreground); padding: 8px; box-sizing: border-box; }
					.prw-root .prw-line-comment-row td { background: color-mix(in oklch, var(--chart-1) 6%, transparent); padding: 8px 10px; }
					.prw-root .prw-user-comments { display: grid; gap: 8px; margin-top: 10px; }
					.prw-root .prw-user-comment { border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border)); border-radius: 12px; background: color-mix(in oklch, var(--primary) 7%, transparent); padding: 8px 10px; }
					.prw-root .prw-user-comment strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted-foreground); }
					.prw-root .prw-user-comment p { margin: 4px 0 0; white-space: pre-wrap; color: var(--foreground); }
					.prw-root .prw-review-controls { justify-content: space-between; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
					.prw-root .prw-dislike-button { color: var(--foreground); }
					.prw-root .prw-dislike-button:hover:not(:disabled), .prw-root .prw-dislike-button:focus-visible:not(:disabled) { border-color: var(--negative); color: var(--negative); background: color-mix(in oklch, var(--negative) 10%, transparent); }
					.prw-root button:disabled { opacity: .48; cursor: not-allowed; }
					.prw-root .prw-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--muted-foreground); border-top-color: transparent; border-radius: 50%; animation: prw-spin .8s linear infinite; }
					.prw-root .prw-pending, .prw-root .prw-empty, .prw-root .prw-neutral, .prw-root .prw-error { display: flex; align-items: center; gap: 8px; padding: 18px; color: var(--muted-foreground); }
					.prw-root .prw-error { color: var(--negative); }
					@media (max-width: 760px) {
						.prw-root { padding: 0; }
						.prw-root .prw-shell { border-radius: 0; border-left: 0; border-right: 0; }
						.prw-root .prw-header-main, .prw-root .prw-progress-row, .prw-root .prw-review-controls { flex-wrap: wrap; }
						.prw-root .prw-phase-rail { display: none; }
						.prw-root .prw-phase-rail-collapsed { display: block; }
						.prw-root .prw-card-pane { padding: 12px; }
						.prw-root .prw-diff-mode { justify-content: flex-start; }
						.prw-root .prw-side-diff { min-width: 860px; }
					}
					@keyframes prw-pulse { 0%, 100% { opacity: .38; } 50% { opacity: .9; } }
					.prw-root * { box-sizing: border-box; }
					.prw-root .prw-shell { min-height: calc(100vh - 24px); background: color-mix(in oklch, var(--card) 92%, var(--background)); box-shadow: 0 22px 70px color-mix(in oklch, var(--foreground) 10%, transparent); }
					.prw-root .prw-review-header { padding: 16px 18px 14px; background: linear-gradient(135deg, color-mix(in oklch, var(--card) 88%, var(--background)), color-mix(in oklch, var(--chart-1) 10%, transparent)); }
					.prw-root .prw-review-header h1 { overflow-wrap: anywhere; }
					.prw-root .prw-pr-pill { color: var(--chart-1); border-color: color-mix(in oklch, var(--chart-1) 28%, var(--border)); }
					.prw-root .prw-gh-link, .prw-root .prw-submit-button, .prw-root .prw-like-button { box-shadow: 0 8px 20px color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-root .prw-progress-fill { background: linear-gradient(90deg, var(--primary), color-mix(in oklch, var(--chart-2) 65%, var(--primary))); }
					.prw-root .prw-progress-indeterminate { width: 42%; animation: prw-pulse 1.45s ease-in-out infinite; }
					.prw-root .prw-workspace { min-height: 540px; overflow: hidden; }
					.prw-root .prw-phase-rail { width: 248px; flex-basis: 248px; padding: 12px; background: color-mix(in oklch, var(--card) 62%, var(--background)); }
					.prw-root .prw-phase-rail-collapsed { background: color-mix(in oklch, var(--card) 62%, var(--background)); overflow-y: auto; overflow-x: hidden; }
					.prw-root .prw-phase { margin: 3px 0 10px; border-radius: 10px; padding: 2px; }
					.prw-root .prw-phase.is-active { background: color-mix(in oklch, var(--primary) 8%, transparent); }
					.prw-root .prw-phase-heading { margin: 0 0 5px; padding: 5px 6px; }
					.prw-root .prw-phase-index, .prw-root .prw-rail-pip { font-weight: 750; }
					.prw-root .prw-nav-card { border-radius: 7px; padding: 6px 7px 6px 28px; font-size: 12px; position: relative; }
					.prw-root .prw-nav-card .prw-nav-dot { position: absolute; left: 11px; }
					.prw-root .prw-nav-card.is-reviewed .prw-nav-dot, .prw-root .prw-rail-dot.is-active, .prw-root .prw-rail-pip.is-active { box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-root .prw-card-pane { padding: 24px clamp(14px, 3vw, 46px) 34px; background: color-mix(in oklch, var(--background) 92%, var(--card)); }
					.prw-root .prw-card { display: grid; gap: 14px; }
					.prw-root .prw-card-story, .prw-root .prw-card-comments, .prw-root .prw-no-diff { border: 1px solid var(--border); border-radius: 18px; background: color-mix(in oklch, var(--card) 96%, var(--background)); padding: 16px; box-shadow: 0 10px 30px color-mix(in oklch, var(--foreground) 5%, transparent); }
					.prw-root .prw-card h2 { letter-spacing: -.02em; }
					.prw-root .prw-summary, .prw-root .prw-rationale { max-width: 860px; line-height: 1.62; }
					.prw-root .prw-rationale { background: color-mix(in oklch, var(--chart-3) 7%, transparent); border-radius: 0 10px 10px 0; padding-top: 8px; padding-bottom: 8px; }
					.prw-root .prw-orientation-stepper { background: color-mix(in oklch, var(--background) 76%, var(--card)); }
					.prw-root .prw-stepper-card { border: 1px solid color-mix(in oklch, var(--border) 70%, transparent); border-radius: 14px; background: color-mix(in oklch, var(--card) 98%, var(--background)); padding: 12px; }
					.prw-root .prw-file-roles > div { background: color-mix(in oklch, var(--card) 88%, var(--background)); }
					.prw-root .prw-diff-toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; margin: 3px 0 -2px; }
					.prw-root .prw-diff-toolbar small { color: var(--muted-foreground); }
					.prw-root .prw-diff-mode { margin-top: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--card); }
					.prw-root .prw-segment { border: 0; border-radius: 0; color: var(--muted-foreground); }
					.prw-root .prw-segment.is-active { background: var(--primary); color: var(--primary-foreground); }
					.prw-root .prw-diff-list { display: grid; gap: 12px; }
					.prw-root .modebar { display: flex; align-items: center; gap: 0; margin: 0; flex: 0 0 auto; }
					.prw-root .modebar .mode-toggle { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 7px; background: color-mix(in oklch, var(--background) 62%, transparent); }
					.prw-root .modebar .mode-toggle button { width: 25px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: transparent; color: var(--muted-foreground); }
					.prw-root .modebar .mode-toggle button.active { background: color-mix(in oklch, var(--primary) 22%, transparent); color: var(--primary); outline: 1px solid color-mix(in oklch, var(--primary) 42%, var(--border)); }
					.prw-root .modebar .mode-icon { width: 15px; height: 15px; display: block; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
					.prw-root .diff-block { margin: 0; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: color-mix(in oklch, var(--card) 98%, var(--background)); box-shadow: 0 8px 24px color-mix(in oklch, var(--foreground) 4%, transparent); }
					.prw-root .diff-block.closed .diff-overflow { display: none; }
					.prw-root .diff-file-header-row { display: flex; align-items: stretch; border-bottom: 1px solid var(--border); }
					.prw-root .diff-block.closed .diff-file-header-row { border-bottom: 0; }
					.prw-root .diff-file-header { display: flex; align-items: center; gap: 9px; flex: 1 1 auto; min-width: 0; padding: 9px 12px; border: 0; background: color-mix(in oklch, var(--muted-foreground) 8%, transparent); font: inherit; color: inherit; text-align: left; cursor: pointer; }
					.prw-root .diff-external-link { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 36px; padding: 0; border-left: 1px solid var(--border); color: var(--muted-foreground); text-decoration: none; }
					.prw-root .diff-external-link:hover { color: var(--foreground); background: color-mix(in oklch, var(--primary) 7%, transparent); }
					.prw-root .diff-external-link svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
					.prw-root .caret { width: 12px; color: var(--muted-foreground); transition: transform 140ms ease; font-family: ui-monospace, monospace; }
					.prw-root .diff-block.open .caret { transform: rotate(90deg); }
					.prw-root .diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground); }
					.prw-root .diff-path b { color: var(--foreground); }
					.prw-root .diff-counts { margin-left: auto; display: inline-flex; align-items: center; gap: 7px; flex: 0 0 auto; font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 800; }
					.prw-root .diff-add-count { color: var(--positive); }
					.prw-root .diff-del-count { color: var(--negative); }
					.prw-root .diff-comment-count { font-size: 11px; color: var(--negative); background: color-mix(in oklch, var(--negative) 12%, transparent); border-radius: 999px; padding: 2px 7px; font-weight: 800; }
					.prw-root .diff-overflow { overflow-x: auto; overflow-y: hidden; max-width: 100%; overscroll-behavior-x: contain; scrollbar-gutter: stable; }
					.prw-root .split-grid { min-width: 980px; }
					.prw-root .inline-lines { min-width: 640px; }
					.prw-root .split-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); width: 100%; min-width: 100%; }
					.prw-root .split-row .diff-line:first-child { border-right: 1px solid var(--border); }
					.prw-root .hunk-header { display: grid; grid-template-columns: 60px minmax(0, 1fr); min-width: max-content; color: var(--muted-foreground); background: color-mix(in oklch, var(--info) 10%, transparent); font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
					.prw-root .hunk-context-cell { min-height: 24px; padding: 3px; display: inline-flex; flex-direction: column; align-items: stretch; justify-content: center; gap: 2px; }
					.prw-root .hunk-signature { min-width: 0; padding: 3px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.6; }
					.prw-root .context-toggle { width: 100%; height: 18px; padding: 0; display: inline-flex; align-items: center; justify-content: center; border: 0; border-radius: 5px; background: color-mix(in oklch, var(--info) 10%, transparent); color: var(--muted-foreground); }
					.prw-root .context-toggle:hover { color: var(--foreground); background: color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-root .context-toggle svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
					.prw-root .diff-line { position: relative; width: 100%; min-width: 0; min-height: 24px; padding: 0; border: 0; border-radius: 0; display: grid; overflow: hidden; grid-template-columns: 42px 18px minmax(280px, 1fr) 26px; align-items: stretch; text-align: left; font: 11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--foreground); background: transparent; }
					.prw-root .diff-line.empty { pointer-events: none; color: transparent; }
					.prw-root .diff-line.add { background: color-mix(in oklch, var(--positive) 15%, transparent); }
					.prw-root .diff-line.del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
					.prw-root .diff-line:hover, .prw-root .diff-line:focus-visible { outline: none; background: color-mix(in oklch, var(--primary) 6%, transparent); box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--primary) 38%, transparent); }
					.prw-root .diff-line.commented .line-no::before { content: "●"; position: absolute; left: 3px; color: var(--primary); font-size: 8px; }
					.prw-root .line-no, .prw-root .prefix, .prw-root .comment-cue { padding: 3px 6px; color: var(--muted-foreground); user-select: none; }
					.prw-root .line-no { position: relative; text-align: right; }
					.prw-root .line-text { min-width: 0; padding: 3px 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
					.prw-root .comment-cue { align-self: center; justify-self: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: var(--primary); color: var(--primary-foreground); line-height: 18px; font-weight: 800; opacity: 0; font-family: inherit; }
					.prw-root .diff-line:hover .comment-cue, .prw-root .diff-line:focus-visible .comment-cue, .prw-root .diff-line.editing .comment-cue, .prw-root .diff-line.commented .comment-cue { opacity: 1; }
					.prw-root .line-comments, .prw-root .line-editor, .prw-root .suggestions { display: grid; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--border); background: color-mix(in oklch, var(--card) 88%, var(--background)); }
					.prw-root .comment, .prw-root .suggestion { padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--background); }
					.prw-root .comment-meta { margin-bottom: 4px; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
					.prw-root .comment-body { white-space: pre-wrap; }
					.prw-root .comment-actions, .prw-root .suggestion-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; justify-content: flex-end; }
					.prw-root .comment-actions button, .prw-root .suggestion button { padding: 4px 8px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--muted-foreground); }
					.prw-root .comment-actions button:hover, .prw-root .suggestion button:hover { color: var(--foreground); background: color-mix(in oklch, var(--primary) 10%, transparent); }
					.prw-root .comment-actions button.delete:hover, .prw-root .suggestion button.delete:hover { color: var(--negative); background: color-mix(in oklch, var(--negative) 12%, transparent); }
					.prw-root .tok-keyword { color: var(--chart-4); }
					.prw-root .tok-string { color: var(--chart-2); }
					.prw-root .tok-number { color: var(--chart-3); }
					.prw-root .tok-comment { color: var(--muted-foreground); font-style: italic; }
					.prw-root .tok-property { color: var(--chart-1); }
					.prw-root .tok-function { color: var(--chart-6); }
					.prw-root .diff-block-error { padding: 12px; color: var(--negative); }
					.prw-root .prw-diff-block { margin-top: 0; border-radius: 12px; background: color-mix(in oklch, var(--card) 98%, var(--background)); box-shadow: 0 8px 24px color-mix(in oklch, var(--foreground) 4%, transparent); }
					.prw-root .prw-diff-header { padding: 9px 12px; }
					.prw-root .prw-diff-header strong { color: var(--chart-1); text-transform: uppercase; font-size: 10px; letter-spacing: .06em; border: 1px solid color-mix(in oklch, var(--chart-1) 24%, var(--border)); border-radius: 5px; padding: 2px 6px; }
					.prw-root .prw-diff-scroll { overflow-x: auto; overflow-y: hidden; max-width: 100%; overscroll-behavior-x: contain; scrollbar-gutter: stable; }
					.prw-root .prw-diff-table { min-width: 680px; table-layout: fixed; }
					.prw-root .prw-side-diff { min-width: 860px; }
					.prw-root .prw-inline-diff { min-width: 640px; }
					.prw-root .prw-diff-table td { padding: 3px 6px; }
					.prw-root .prw-code { min-width: 0; overflow: visible; }
					.prw-root .prw-code code { display: block; width: max-content; min-width: 100%; background: transparent; padding: 0; }
					.prw-root .prw-line-comment-button { background: color-mix(in oklch, var(--card) 82%, transparent); }
					.prw-root .prw-line-comment-button:hover, .prw-root .prw-line:focus-within .prw-line-comment-button { background: var(--primary); color: var(--primary-foreground); }
					.prw-root .prw-suggested-comment { position: relative; border-left: 4px solid color-mix(in oklch, var(--warning) 70%, var(--border)); }
					.prw-root .prw-inline-suggested-comment { margin-top: 0; background: color-mix(in oklch, var(--warning) 10%, var(--card)); }
					.prw-root .prw-card-suggestions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 12px; }
					.prw-root .prw-suggestion-chip { display: grid; gap: 4px; text-align: left; white-space: normal; border-radius: 10px; background: color-mix(in oklch, var(--warning) 8%, var(--card)); border-color: color-mix(in oklch, var(--warning) 30%, var(--border)); line-height: 1.35; }
					.prw-root .prw-suggestion-chip span { color: var(--muted-foreground); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
					.prw-root .prw-card-editor, .prw-root .prw-comment-editor textarea { font: inherit; resize: vertical; }
					.prw-root .prw-review-controls { margin-top: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in oklch, var(--card) 96%, var(--background)); box-shadow: 0 10px 28px color-mix(in oklch, var(--foreground) 4%, transparent); }
					.prw-root button { cursor: pointer; font: inherit; }
					.prw-root .prw-pending { display: block; padding: 0; color: var(--foreground); }
					.prw-root .prw-pending-header .prw-pr-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; }
					.prw-root .prw-pending-badge { border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border)); border-radius: 999px; background: color-mix(in oklch, var(--card) 78%, transparent); color: var(--primary); padding: 4px 9px; font-size: 12px; font-weight: 650; white-space: nowrap; }
					.prw-root .prw-pending-nav-line, .prw-root .prw-pending-line, .prw-root .prw-pending-code span { display: block; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 16%, transparent); animation: prw-pulse 1.6s ease-in-out infinite; }
					.prw-root .prw-pending-nav-line { height: 9px; margin: 8px 9px 12px 36px; }
					.prw-root .prw-pending-card .prw-card-story { border-style: dashed; }
					.prw-root .prw-pending-line { height: 10px; width: 70%; margin-top: 10px; }
					.prw-root .prw-pending-line.is-wide { width: 92%; }
					.prw-root .prw-pending-code { display: grid; gap: 8px; padding: 14px; }
					.prw-root .prw-pending-code span { height: 12px; }
					.prw-root .prw-pending-code span:nth-child(2) { width: 74%; background: color-mix(in oklch, var(--positive) 18%, transparent); }
					.prw-root .prw-pending-code span:nth-child(3) { width: 58%; background: color-mix(in oklch, var(--negative) 16%, transparent); }
					@media (max-width: 900px) {
						.prw-root .prw-workspace { min-height: 500px; }
						.prw-root .prw-phase-rail { display: none; }
						.prw-root .prw-phase-rail-collapsed { display: block; }
					}
					@media (max-width: 760px) {
						.prw-root .prw-shell { min-height: 100vh; }
						.prw-root .prw-review-header { padding: 14px; }
						.prw-root .prw-card-story, .prw-root .prw-card-comments, .prw-root .prw-no-diff { border-radius: 14px; padding: 12px; }
						.prw-root .prw-side-diff { min-width: 840px; }
					}

					/* Historical compact shell parity overrides. */
					.prw-root .prw-bundle-marker { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
					.prw-root .shell { --walkthrough-content-x: clamp(12px, 1.6vw, 24px); position: relative; height: calc(100vh - 24px); min-height: 620px; display: grid; grid-template-rows: 58px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--card); color: var(--foreground); font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
					.prw-root .header { height: 58px; display: grid; grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 260px) auto; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid var(--border); background: color-mix(in oklch, var(--card) 94%, var(--background)); }
					.prw-root .title-group { min-width: 0; display: flex; align-items: center; gap: 10px; }
					.prw-root .pr-pill { display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--border); border-radius: 999px; color: var(--primary); font-weight: 750; }
					.prw-root .title-stack { min-width: 0; }
					.prw-root .header h1 { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; line-height: 1.2; letter-spacing: -.01em; }
					.prw-root .header-meta { display: flex; gap: 8px; margin-top: 3px; color: var(--muted-foreground); font-size: 11px; white-space: nowrap; }
					.prw-root .add { color: var(--positive); } .del { color: var(--negative); }
					.prw-root .github-link { display: inline-flex; align-items: center; gap: 5px; color: var(--muted-foreground); text-decoration: none; font-size: 12px; white-space: nowrap; }
					.prw-root .github-link svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
					.prw-root .progress-wrap { display: grid; grid-template-columns: auto minmax(72px, 1fr); align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 12px; }
					.prw-root .progress-track { height: 6px; overflow: hidden; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 14%, transparent); }
					.prw-root .progress-fill { height: 100%; background: var(--primary); border-radius: inherit; }
					.prw-root .submit, .prw-root .primary { border: 1px solid var(--primary); border-radius: 999px; background: var(--primary); color: var(--primary-foreground); padding: 6px 10px; font-weight: 700; }
					.prw-root .secondary { border: 1px solid var(--border); border-radius: 999px; background: color-mix(in oklch, var(--card) 92%, var(--background)); color: var(--foreground); padding: 6px 10px; }
					.prw-root .body { min-height: 0; display: grid; grid-template-columns: var(--walkthrough-rail-width, 248px) minmax(0, 1fr); }
					.prw-root .rail { min-width: 0; border-right: 1px solid var(--border); background: color-mix(in oklch, var(--card) 70%, var(--background)); position: relative; }
					.prw-root .rail .prw-phase-rail { width: auto; flex: none; }
					.prw-root .rail-panel { height: 100%; overflow: auto; padding: 9px 8px 14px; }
					.prw-root .rail-panel.compact { display: none; }
					.prw-root .rail.collapsed .rail-panel.labelled, .prw-root .body.rail-collapsed .rail-panel.labelled { display: none; }
					.prw-root .rail.collapsed .rail-panel.compact, .prw-root .body.rail-collapsed .rail-panel.compact { display: block; }
					.prw-root .body.rail-collapsed { grid-template-columns: 48px minmax(0, 1fr); }
					.prw-root .rail-top { display: flex; align-items: center; justify-content: space-between; min-height: 30px; padding: 0 4px 7px; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
					.prw-root .rail-toggle { width: 25px; height: 25px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--foreground); font-weight: 800; }
					.prw-root .phase { margin: 3px 0 9px; }
					.prw-root .phase-button { width: 100%; display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: 7px; border: 0; border-radius: 8px; background: transparent; color: var(--muted-foreground); padding: 5px; text-align: left; }
					.prw-root .phase.active .phase-button, .prw-root .phase-button:hover { background: color-mix(in oklch, var(--primary) 8%, transparent); color: var(--foreground); }
					.prw-root .phase-pip, .prw-root .step-dot { display: inline-grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); font-size: 10px; font-weight: 800; }
					.prw-root .phase-name, .prw-root .card-label, .prw-root .step-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.prw-root .phase-count { font-size: 11px; }
					.prw-root .phase-cards { display: grid; gap: 2px; }
					.prw-root .card-button { width: 100%; min-height: 27px; display: flex; align-items: center; gap: 7px; border: 0; border-radius: 7px; background: transparent; color: var(--muted-foreground); padding: 5px 7px; text-align: left; }
					.prw-root .card-button:hover, .prw-root .card-button.active { color: var(--foreground); background: color-mix(in oklch, var(--primary) 10%, transparent); }
					.prw-root .card-dot { display: inline-grid; place-items: center; width: 13px; height: 13px; border: 1px solid var(--border); border-radius: 999px; background: var(--card); font-size: 9px; font-weight: 900; }
					.prw-root .card-button.complete .card-dot { border-color: var(--primary); background: var(--primary); color: var(--primary-foreground); }
					.prw-root .card-button.disliked .card-dot { border-color: var(--negative); background: var(--negative); color: var(--negative-foreground, var(--primary-foreground)); }
					.prw-root .card-button.active .card-dot { box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 20%, transparent); }
					.prw-root .orientation-rail { display: grid; gap: 3px; margin: 3px 0 10px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
					.prw-root .orientation-step { display: flex; align-items: center; gap: 7px; border: 0; border-radius: 7px; background: transparent; color: var(--muted-foreground); padding: 5px; text-align: left; }
					.prw-root .orientation-step.current { color: var(--foreground); background: color-mix(in oklch, var(--chart-1) 10%, transparent); }
					.prw-root .orientation-step.visited .step-dot { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
					.prw-root .compact .rail-toggle { margin: 0 auto 8px; display: block; }
					.prw-root .compact .orientation-step, .prw-root .compact .card-button, .prw-root .compact .phase-pip { justify-content: center; width: 32px; margin: 0 auto; padding: 4px; }
					.prw-root .compact .orientation-rail { justify-items: center; }
					.prw-root .legacy-navrail-marker, .prw-root .legacy-nav-card-marker { display: block; width: 1px; height: 1px; margin: 0 auto; overflow: hidden; opacity: .01; }
					.prw-root .walkthrough-rail-resize-handle { position: absolute; right: -4px; top: 0; width: 8px; height: 100%; border: 0; border-radius: 0; background: transparent; cursor: col-resize; }
					.prw-root .walkthrough-rail-resize-handle:hover { background: color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-root .content { min-width: 0; overflow: auto; padding: 14px var(--walkthrough-content-x) 0; background: color-mix(in oklch, var(--background) 92%, var(--card)); }
					.prw-root .card { max-width: 1120px; margin: 0 auto 18px; display: grid; gap: 10px; }
					.prw-root .inner, .prw-root .guide, .prw-root .state-card, .prw-root .audit-draft, .prw-root .prw-card-comments, .prw-root .no-diff { border: 1px solid var(--border); border-radius: 12px; background: color-mix(in oklch, var(--card) 96%, var(--background)); padding: 13px; box-shadow: 0 8px 24px color-mix(in oklch, var(--foreground) 4%, transparent); }
					.prw-root .card-head, .prw-root .guide-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
					.prw-root .phase-label { color: var(--muted-foreground); font-size: 10px; text-transform: uppercase; letter-spacing: .1em; font-weight: 800; }
					.prw-root .card h1, .prw-root .card h2, .prw-root .guide h1, .prw-root .guide h2 { margin: 4px 0 0; font-size: 18px; line-height: 1.2; letter-spacing: -.015em; }
					.prw-root .summary { margin: 8px 0 0; color: var(--muted-foreground); }
					.prw-root .rationale { margin: 10px 0 0; padding: 8px 10px; border-left: 3px solid var(--chart-3); border-radius: 0 8px 8px 0; background: color-mix(in oklch, var(--chart-3) 7%, transparent); color: var(--muted-foreground); }
					.prw-root .checklist { margin: 10px 0 0; color: var(--muted-foreground); }
					.prw-root .nav-label { color: var(--muted-foreground); font-size: 11px; }
					.prw-root .original-description { margin-top: 10px; border: 1px solid var(--border); border-radius: 9px; padding: 8px 10px; color: var(--muted-foreground); }
					.prw-root .original-description summary { color: var(--foreground); cursor: pointer; font-weight: 700; }
					.prw-root .diff-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
					.prw-root .actions { position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: color-mix(in oklch, var(--card) 88%, transparent); backdrop-filter: blur(12px); }
					.prw-root .decision-note { color: var(--muted-foreground); font-size: 12px; }
					.prw-root .decision-buttons { display: flex; gap: 8px; }
					.prw-root .like, .prw-root .dislike { border: 1px solid var(--border); border-radius: 999px; background: var(--card); color: var(--foreground); padding: 6px 10px; font-weight: 750; }
					.prw-root .like { border-color: color-mix(in oklch, var(--positive) 35%, var(--border)); }
					.prw-root .dislike { border-color: color-mix(in oklch, var(--negative) 35%, var(--border)); }
					.prw-root .decision-selected.like { background: color-mix(in oklch, var(--positive) 15%, var(--card)); color: var(--positive); box-shadow: inset 0 0 0 1px var(--positive); }
					.prw-root .decision-selected.dislike { background: color-mix(in oklch, var(--negative) 13%, var(--card)); color: var(--negative); box-shadow: inset 0 0 0 1px var(--negative); }
					.prw-root .guide { padding: 16px; }
					.prw-root .guide-counter { border: 1px solid var(--border); border-radius: 999px; padding: 4px 9px; color: var(--muted-foreground); font-weight: 750; }
					.prw-root .guide-stage { margin-top: 12px; border: 1px solid var(--border); border-radius: 12px; padding: 14px; background: color-mix(in oklch, var(--background) 76%, var(--card)); }
					.prw-root .beat { display: grid; gap: 10px; }
					.prw-root .beat h2 { font-size: 20px; }
					.prw-root .verdict, .prw-root .concern, .prw-root .filerow { border: 1px solid var(--border); border-radius: 10px; background: var(--card); padding: 9px; }
					.prw-root .verdict { border-color: color-mix(in oklch, var(--warning) 38%, var(--border)); background: color-mix(in oklch, var(--warning) 8%, transparent); }
					.prw-root .verdict span, .prw-root .filerow small { display: block; color: var(--muted-foreground); }
					.prw-root .guide-stats { display: flex; flex-wrap: wrap; gap: 8px; color: var(--muted-foreground); }
					.prw-root .concerns, .prw-root .filemap { display: grid; gap: 8px; }
					.prw-root .concern strong, .prw-root .filerow strong { display: block; text-transform: uppercase; letter-spacing: .08em; font-size: 10px; color: var(--muted-foreground); }
					.prw-root .filerow span { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
					.prw-root .guide-nav { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
					.prw-root .export-backdrop { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; padding: 18px; background: color-mix(in oklch, var(--background) 58%, transparent); backdrop-filter: blur(6px); }
					.prw-root .export-dialog { width: min(760px, 100%); max-height: 88%; overflow: auto; border: 1px solid var(--border); border-radius: 14px; background: var(--card); color: var(--foreground); box-shadow: 0 24px 80px color-mix(in oklch, var(--foreground) 18%, transparent); padding: 14px; }
					.prw-root .export-dialog header, .prw-root .export-dialog footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
					.prw-root .export-dialog h2 { margin: 3px 0 0; font-size: 17px; }
					.prw-root .warning { margin: 12px 0; border: 1px solid color-mix(in oklch, var(--warning) 45%, var(--border)); border-radius: 10px; padding: 10px; background: color-mix(in oklch, var(--warning) 9%, transparent); }
					.prw-root .export-rows { display: grid; gap: 8px; margin: 12px 0; }
					.prw-root .export-row, .prw-root .export-empty, .prw-root .export-error, .prw-root .export-result { border: 1px solid var(--border); border-radius: 10px; padding: 9px 10px; background: color-mix(in oklch, var(--background) 72%, var(--card)); }
					.prw-root .export-row { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(120px, 1.2fr) auto; gap: 8px; align-items: start; }
					.prw-root .export-row strong, .prw-root .export-empty strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
					.prw-root .export-row span, .prw-root .export-empty span { color: var(--muted-foreground); }
					.prw-root .export-row p { grid-column: 1 / -1; margin: 0; white-space: pre-wrap; }
					.prw-root .export-row.valid { border-color: color-mix(in oklch, var(--positive) 38%, var(--border)); }
					.prw-root .export-row.unmappable { border-color: color-mix(in oklch, var(--warning) 45%, var(--border)); }
					.prw-root .export-target { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: var(--muted-foreground); }
					.prw-root .export-status { font-weight: 750; color: var(--muted-foreground); }
					.prw-root .export-error { border-color: color-mix(in oklch, var(--negative) 45%, var(--border)); background: color-mix(in oklch, var(--negative) 8%, transparent); }
					.prw-root .export-result { border-color: color-mix(in oklch, var(--positive) 45%, var(--border)); background: color-mix(in oklch, var(--positive) 8%, transparent); }
					.prw-root .export-body { max-height: 320px; overflow: auto; padding: 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--background); color: var(--foreground); white-space: pre-wrap; }
					.prw-root .state-shell .state-content { display: grid; align-content: start; padding-top: 16px; }
					.prw-root .state-shell .state-card h2 { margin: 4px 0 0; font-size: 18px; }
					.prw-root .state-shell .state-card p { margin: 8px 0 0; color: var(--muted-foreground); }
					.prw-root .state-skeleton { display: grid; gap: 8px; margin-top: 14px; }
					.prw-root .state-skeleton span { display: block; height: 10px; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 16%, transparent); animation: prw-pulse 1.6s ease-in-out infinite; }
					.prw-root .state-skeleton span:nth-child(2) { width: 74%; } .prw-root .state-skeleton span:nth-child(3) { width: 56%; }
					.prw-root button:disabled { opacity: .48; cursor: not-allowed; }
					.prw-root .body.narrow { grid-template-columns: 48px minmax(0, 1fr); }
					.prw-root .body.narrow .rail-panel.labelled { display: none !important; }
					.prw-root .body.narrow .rail-panel.compact { display: block !important; }
					.prw-root .body.narrow .walkthrough-rail-resize-handle, .prw-root .rail.narrow .walkthrough-rail-resize-handle { display: none; }
					@media (max-width: 900px) { .prw-root .body { grid-template-columns: 48px minmax(0, 1fr); } .prw-root .rail-panel.labelled { display: none !important; } .prw-root .rail-panel.compact { display: block !important; } .prw-root .walkthrough-rail-resize-handle { display: none; } .prw-root .header { grid-template-columns: minmax(0, 1fr) auto; height: auto; min-height: 58px; padding: 8px 10px; } .prw-root .github-link { display: none; } .prw-root .progress-wrap { grid-column: 1 / -1; } .prw-root .shell { height: 100vh; min-height: 560px; grid-template-rows: auto minmax(0, 1fr); } }

				</style>
				<div class="prw-root" data-testid="prw-panel-root" data-prw-job=${displayJob}>
					${entry.bundle
						? renderBundle(entry, host, paramKey, displayJob)
						: status === "error" && entry.error
							? renderStateShell("error", "prw-error", "PR Walkthrough error", entry.error)
							: isPending
								? renderPendingShell()
								: renderStateShell("neutral", "prw-neutral", "No PR walkthrough is available in this session.", "This pane is not bound to a reviewer child with a submitted walkthrough.")}
				</div>
			`;
		},
	};
}
