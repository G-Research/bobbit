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
		return globalThis.matchMedia && globalThis.matchMedia("(max-width: 760px)").matches ? "inline" : "side";
	} catch {
		return "side";
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
const storeEntry = (key, entry) => { byJob.set(key, entry); };

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

	const patchEntry = (host, key, patch) => {
		const cur = byJob.get(key) || {};
		replaceEntry(host, key, { ...cur, ...patch });
	};

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

	const renderHeaderBlock = (entry, host, paramKey) => {
		const b = entry.bundle || {};
		const cs = b.changeset || {};
		const cards = cardsOf(entry);
		const stats = statsFor(b, cards);
		const reviewed = cards.filter((card) => (entry.reviewStatus || {})[card.id] === "liked" || (entry.reviewStatus || {})[card.id] === "disliked").length;
		const total = cards.length;
		const progress = total ? Math.round((reviewed / total) * 100) : 0;
		const prLabel = cs.number != null ? `PR #${cs.number}` : "PR";
		const title = cs.prTitle || cs.title || "Walkthrough";
		const url = prUrlFor(cs);
		return html`
			<header class="prw-review-header" data-testid="prw-review-header">
				<div class="prw-review-kicker">
					<span>Review walkthrough</span>
					<span class="prw-header-shas">${compactSha(cs.baseSha)}…${compactSha(cs.headSha)}</span>
				</div>
				<div class="prw-header-main">
					<div class="prw-title-wrap">
						<div class="prw-pr-pill">${prLabel}</div>
						<h1 data-testid="prw-title">${title}</h1>
					</div>
					${url ? html`<a class="prw-gh-link" href=${url} target="_blank" rel="noreferrer">Open on GitHub</a>` : nothing}
				</div>
				<div class="prw-header-meta">
					<span class="prw-stat">${stats.files} ${stats.files === 1 ? "file" : "files"}</span>
					<span class="prw-stat prw-add">+${stats.additions}</span>
					<span class="prw-stat prw-del">-${stats.deletions}</span>
					<span class="prw-stat">${cs.provider || "changeset"}</span>
				</div>
				<div class="prw-progress-row">
					<div class="prw-progress-copy" data-testid="prw-review-progress">${reviewed} / ${total} reviewed</div>
					<div class="prw-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax=${total || 1} aria-valuenow=${reviewed}>
						<div class="prw-progress-fill" style=${`width:${progress}%`}></div>
					</div>
					<button class="prw-submit-button" @click=${() => patchEntry(host, paramKey, { submitHint: true })}>Submit review</button>
				</div>
			</header>
		`;
	};

	const renderNavRail = (entry, host, paramKey) => {
		const cards = cardsOf(entry);
		const active = activeCard(entry);
		return html`
			<nav class="prw-phase-rail" data-testid="prw-phase-rail" aria-label="PR walkthrough phase rail">
				${PHASES.map((phase, phaseIndex) => {
					const phaseCards = cards.filter((c) => cardPhase(c) === phase.id);
					if (phaseCards.length === 0) return nothing;
					const phaseActive = active && cardPhase(active) === phase.id;
					return html`
						<section class="prw-phase ${phaseActive ? "is-active" : ""}">
							<div class="prw-phase-heading">
								<span class="prw-phase-index">${phaseIndex + 1}</span>
								<span>${phase.label}</span>
							</div>
							${phaseCards.map((card) => {
								const isActive = active && active.id === card.id;
								const status = (entry.reviewStatus || {})[card.id] || "pending";
								return html`<button
									class="prw-nav-card ${isActive ? "is-active" : ""} ${status !== "pending" ? "is-reviewed" : ""}"
									data-testid="prw-nav-card" data-prw-nav=${card.id}
									@click=${() => setActiveCard(entry, host, paramKey, card.id)}
									title=${asText(card.title, deriveNavLabel(card))}
								>
									<span class="prw-nav-dot"></span>
									<span>${deriveNavLabel(card)}</span>
								</button>`;
							})}
						</section>
					`;
				})}
			</nav>
			<nav class="prw-phase-rail-collapsed" data-testid="prw-phase-rail-collapsed" aria-label="Collapsed PR walkthrough phase rail">
				${PHASES.map((phase, phaseIndex) => {
					const phaseCards = cards.filter((c) => cardPhase(c) === phase.id);
					if (phaseCards.length === 0) return nothing;
					const phaseActive = active && cardPhase(active) === phase.id;
					return html`<div class="prw-rail-pip-group">
						<button class="prw-rail-pip ${phaseActive ? "is-active" : ""}" title=${phase.label} aria-label=${phase.label}>${phase.short || phaseIndex + 1}</button>
						${phaseCards.map((card) => html`<button
							class="prw-rail-dot ${active && active.id === card.id ? "is-active" : ""}"
							title=${asText(card.title, deriveNavLabel(card))}
							aria-label=${asText(card.title, deriveNavLabel(card))}
							@click=${() => setActiveCard(entry, host, paramKey, card.id)}
						></button>`)}
					</div>`;
				})}
			</nav>
		`;
	};

	const renderSection = (section) => html`
		<div class="prw-section" data-testid="prw-section" data-prw-section=${asText(section.id, "section")}>
			${section.eyebrow ? html`<div class="prw-section-eyebrow">${section.eyebrow}</div>` : nothing}
			<h3>${section.heading || section.navLabel || "Orientation beat"}</h3>
			${section.body ? html`<p>${section.body}</p>` : nothing}
			${section.verdict ? html`<div class="prw-verdict"><strong>Recommendation:</strong> ${section.verdict.recommendation || "unclear"}${section.verdict.confidence ? ` · ${section.verdict.confidence} confidence` : ""}${section.verdict.summary ? html`<p>${section.verdict.summary}</p>` : nothing}</div>` : nothing}
			${Array.isArray(section.concerns) && section.concerns.length
				? html`<ul class="prw-concern-list">${section.concerns.map((c) => html`<li><strong>${c.severity || "Concern"}</strong> ${c.text || c.summary || c}</li>`)}</ul>`
				: nothing}
			${Array.isArray(section.fileRoles) && section.fileRoles.length
				? html`<div class="prw-file-roles">${section.fileRoles.map((r) => html`<div><strong>${r.role || "File"}</strong><span>${r.file || r.path || "unknown"}</span>${r.note ? html`<small>${r.note}</small>` : nothing}</div>`)}</div>`
				: nothing}
		</div>
	`;

	const renderOrientationStepper = (entry, host, paramKey, card) => {
		const sections = arrayOf(card.sections);
		if (!sections.length) return nothing;
		const sectionIndex = Math.max(0, Math.min(sections.length - 1, ((entry.sectionIndex || {})[card.id] || 0)));
		const setStep = (next) => {
			const cur = byJob.get(paramKey) || entry;
			patchEntry(host, paramKey, { sectionIndex: { ...(cur.sectionIndex || {}), [card.id]: Math.max(0, Math.min(sections.length - 1, next)) } });
		};
		return html`
			<div class="prw-orientation-stepper" data-testid="prw-orientation-stepper" aria-label="Guided orientation beats">
				<div class="prw-stepper-rail">
					${sections.map((section, index) => html`<button
						class="prw-step ${index < sectionIndex ? "is-visited" : ""} ${index === sectionIndex ? "is-current" : ""}"
						@click=${() => setStep(index)}
						title=${section.heading || section.navLabel || `Step ${index + 1}`}
						aria-label=${section.heading || section.navLabel || `Step ${index + 1}`}
					>
						<span>${index < sectionIndex ? "✓" : index + 1}</span>
						<small>${section.navLabel || section.eyebrow || `Beat ${index + 1}`}</small>
					</button>`)}
				</div>
				<div class="prw-stepper-card">
					<div class="prw-step-count">Step ${sectionIndex + 1} of ${sections.length}</div>
					${renderSection(sections[sectionIndex])}
					<div class="prw-stepper-actions">
						<button class="prw-ghost-button" ?disabled=${sectionIndex === 0} @click=${() => setStep(sectionIndex - 1)}>Back</button>
						<button class="prw-ghost-button" ?disabled=${sectionIndex >= sections.length - 1} @click=${() => setStep(sectionIndex + 1)}>Next</button>
					</div>
				</div>
			</div>
		`;
	};

	const renderDiffModeControls = (entry, host, paramKey) => {
		const mode = entry.diffMode || defaultDiffMode();
		return html`
			<div class="prw-diff-mode" aria-label="Diff display mode">
				<button class=${`prw-segment ${mode === "side" ? "is-active" : ""}`} @click=${() => patchEntry(host, paramKey, { diffMode: "side", userSetMode: true })}>Side-by-side</button>
				<button class=${`prw-segment ${mode === "inline" ? "is-active" : ""}`} @click=${() => patchEntry(host, paramKey, { diffMode: "inline", userSetMode: true })}>Inline</button>
			</div>
		`;
	};

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

	const lineCommentButton = (entry, host, paramKey, key) => html`<button
		class="prw-line-comment-button"
		title="Add line comment"
		aria-label="Add line comment"
		aria-controls=${lineDomId(key)}
		@click=${() => openLineComment(entry, host, paramKey, key)}
	>Add line comment</button>`;

	const useSuggestedLineComment = (entry, host, paramKey, key, suggestion) => openLineComment(entry, host, paramKey, key, suggestionBody(suggestion));

	const renderSuggestedLineCommentContent = (entry, host, paramKey, key, suggestions) => {
		const usable = arrayOf(suggestions).filter((suggestion) => suggestionBody(suggestion).trim());
		if (!usable.length) return nothing;
		return html`<div class="prw-inline-suggestions">
			${usable.map((suggestion) => html`<div
				class="prw-suggested-comment prw-inline-suggested-comment"
				data-testid="prw-inline-suggested-comment"
				data-prw-comment=${asText(suggestion && suggestion.id, "comment")}
				data-prw-line=${asText(suggestion && (suggestion.lineId || suggestion.line_id || suggestion.line), "line")}
			>
				<div class="prw-suggestion-anchor">Suggested line comment</div>
				<div>${suggestionBody(suggestion)}</div>
				<button class="prw-ghost-button" @click=${() => useSuggestedLineComment(entry, host, paramKey, key, suggestion)}>Use suggestion</button>
			</div>`)}
		</div>`;
	};

	const renderLineCommentContent = (entry, host, paramKey, key) => {
		const saved = arrayOf((entry.lineComments || {})[key]).filter((comment) => asText(comment).trim());
		const open = Boolean((entry.lineCommentOpen || {})[key]);
		if (!saved.length && !open) return nothing;
		return html`
			${saved.length ? html`<div class="prw-user-comments">${saved.map((comment) => html`<div class="prw-user-comment" data-testid="prw-line-user-comment"><strong>Your line comment</strong><p>${comment}</p></div>`)}</div>` : nothing}
			${open ? html`<div class="prw-comment-editor" data-testid="prw-line-comment-editor">
				<textarea
					.value=${asText((entry.lineCommentDraft || {})[key])}
					placeholder="Write a line-level review comment"
					@input=${(ev) => updateNestedMap(entry, host, paramKey, "lineCommentDraft", key, ev.currentTarget.value)}
				></textarea>
				<div class="prw-comment-actions">
					<button class="prw-ghost-button" @click=${() => saveLineComment(entry, host, paramKey, key)}>Save comment</button>
					<button class="prw-ghost-button" @click=${() => cancelLineComment(entry, host, paramKey, key)}>Cancel</button>
				</div>
			</div>` : nothing}
		`;
	};

	const renderLineCommentState = (entry, host, paramKey, key, colspan) => {
		const content = renderLineCommentContent(entry, host, paramKey, key);
		if (content === nothing) return nothing;
		return html`<tr class="prw-line-comment-row" id=${lineDomId(key)}><td colspan=${colspan}>${content}</td></tr>`;
	};

	const renderInlineDiff = (entry, host, paramKey, card, block) => html`
		<div class="prw-diff-scroll">
			<table class="prw-diff-table prw-inline-diff">
				<tbody>
					${arrayOf(block.hunks).map((hunk) => html`
						<tr class="prw-hunk-row"><td colspan="4">${asText(hunk && hunk.header, "@@")}</td></tr>
						${arrayOf(hunk && hunk.lines).map((ln) => {
							const key = lineKey(card, block, ln);
							const suggestions = lineSuggestions(card, block, ln);
							return html`
								<tr class=${`prw-line is-${lineTone(ln && ln.kind)}`} data-prw-line-id=${lineIdentifier(ln)}>
									<td class="prw-line-number">${asText(ln && (ln.oldLine || ln.line || ln.id), "")}</td>
									<td class="prw-prefix">${linePrefix(ln && ln.kind)}</td>
									<td class="prw-code"><code>${asText(ln && ln.text)}</code></td>
									<td class="prw-comment-cell">${lineCommentButton(entry, host, paramKey, key)}</td>
								</tr>
								${suggestions.length ? html`<tr class="prw-line-suggestion-row"><td colspan="4">${renderSuggestedLineCommentContent(entry, host, paramKey, key, suggestions)}</td></tr>` : nothing}
								${renderLineCommentState(entry, host, paramKey, key, 4)}
							`;
						})}
					`)}
				</tbody>
			</table>
		</div>
	`;

	const pairedSideRows = (lines) => {
		const rows = [];
		const source = arrayOf(lines);
		for (let i = 0; i < source.length;) {
			const line = source[i];
			const kind = line && line.kind;
			if (kind === "del") {
				const dels = [];
				const adds = [];
				while (source[i] && source[i].kind === "del") dels.push(source[i++]);
				while (source[i] && source[i].kind === "add") adds.push(source[i++]);
				const count = Math.max(dels.length, adds.length);
				for (let index = 0; index < count; index += 1) rows.push({ oldLine: dels[index], newLine: adds[index] });
				continue;
			}
			if (kind === "add") {
				rows.push({ oldLine: undefined, newLine: line });
				i += 1;
				continue;
			}
			rows.push({ oldLine: line, newLine: line, shared: true });
			i += 1;
		}
		return rows;
	};

	const sideLineNumber = (line, side) => side === "old"
		? asText(line && (line.oldLine || line.line || line.id), "")
		: asText(line && (line.newLine || line.line || line.id), "");

	const renderSideAuxRows = (entry, host, paramKey, oldKey, oldSuggestions, newKey, newSuggestions) => {
		const sharedKey = oldKey && oldKey === newKey;
		const oldSuggestionContent = oldKey ? renderSuggestedLineCommentContent(entry, host, paramKey, oldKey, oldSuggestions) : nothing;
		const newSuggestionContent = newKey && !sharedKey ? renderSuggestedLineCommentContent(entry, host, paramKey, newKey, newSuggestions) : nothing;
		const oldCommentContent = oldKey ? renderLineCommentContent(entry, host, paramKey, oldKey) : nothing;
		const newCommentContent = newKey && !sharedKey ? renderLineCommentContent(entry, host, paramKey, newKey) : nothing;
		return html`
			${oldSuggestionContent !== nothing && sharedKey ? html`<tr class="prw-line-suggestion-row"><td colspan="6">${oldSuggestionContent}</td></tr>` : nothing}
			${oldSuggestionContent !== nothing && !sharedKey ? html`<tr class="prw-line-suggestion-row prw-side-suggestion-row"><td colspan="3">${oldSuggestionContent}</td><td colspan="3"></td></tr>` : nothing}
			${newSuggestionContent !== nothing ? html`<tr class="prw-line-suggestion-row prw-side-suggestion-row"><td colspan="3"></td><td colspan="3">${newSuggestionContent}</td></tr>` : nothing}
			${oldCommentContent !== nothing && sharedKey ? html`<tr class="prw-line-comment-row" id=${lineDomId(oldKey)}><td colspan="6">${oldCommentContent}</td></tr>` : nothing}
			${oldCommentContent !== nothing && !sharedKey ? html`<tr class="prw-line-comment-row prw-side-comment-row" id=${lineDomId(oldKey)}><td colspan="3">${oldCommentContent}</td><td colspan="3"></td></tr>` : nothing}
			${newCommentContent !== nothing ? html`<tr class="prw-line-comment-row prw-side-comment-row" id=${lineDomId(newKey)}><td colspan="3"></td><td colspan="3">${newCommentContent}</td></tr>` : nothing}
		`;
	};

	const renderSideDiff = (entry, host, paramKey, card, block) => html`
		<div class="prw-diff-scroll">
			<table class="prw-diff-table prw-side-diff">
				<tbody>
					${arrayOf(block.hunks).map((hunk) => html`
						<tr class="prw-hunk-row"><td colspan="6">${asText(hunk && hunk.header, "@@")}</td></tr>
						${pairedSideRows(hunk && hunk.lines).map((row) => {
							const oldLine = row.oldLine;
							const newLine = row.newLine;
							const oldKey = oldLine ? lineKey(card, block, oldLine) : undefined;
							const newKey = newLine ? lineKey(card, block, newLine) : undefined;
							const oldSuggestions = oldLine ? lineSuggestions(card, block, oldLine) : [];
							const newSuggestions = newLine && newLine !== oldLine ? lineSuggestions(card, block, newLine) : oldSuggestions;
							const tone = row.shared ? lineTone(oldLine && oldLine.kind) : oldLine && newLine ? "change" : oldLine ? "del" : "add";
							return html`
								<tr
									class=${`prw-line prw-side-row is-${tone}`}
									data-testid="prw-side-diff-row"
									data-prw-old-line-id=${oldLine ? lineIdentifier(oldLine) : ""}
									data-prw-new-line-id=${newLine ? lineIdentifier(newLine) : ""}
								>
									<td class="prw-line-number prw-old-number">${oldLine ? sideLineNumber(oldLine, "old") : ""}</td>
									<td class="prw-code prw-old ${oldLine ? `is-${lineTone(oldLine.kind)}` : "is-empty"}"><code>${oldLine ? asText(oldLine.text) : ""}</code></td>
									<td class="prw-comment-cell prw-old-comment">${oldKey ? lineCommentButton(entry, host, paramKey, oldKey) : nothing}</td>
									<td class="prw-line-number prw-new-number">${newLine ? sideLineNumber(newLine, "new") : ""}</td>
									<td class="prw-code prw-new ${newLine ? `is-${lineTone(newLine.kind)}` : "is-empty"}"><code>${newLine ? asText(newLine.text) : ""}</code></td>
									<td class="prw-comment-cell prw-new-comment">${newKey ? lineCommentButton(entry, host, paramKey, newKey) : nothing}</td>
								</tr>
								${renderSideAuxRows(entry, host, paramKey, oldKey, oldSuggestions, newKey, newSuggestions)}
							`;
						})}
					`)}
				</tbody>
			</table>
		</div>
	`;

	const renderDiffBlock = (entry, host, paramKey, card, block) => {
		const mode = entry.diffMode || defaultDiffMode();
		const label = block && (block.label || block.filePath || block.path) || "Diff block";
		const key = blockKey(card, block);
		const collapsed = Boolean((entry.collapsedDiffBlocks || {})[key]);
		return html`
			<section class="prw-diff-block ${collapsed ? "is-collapsed" : ""}" data-testid="prw-diffblock" data-prw-file=${asText(block && (block.filePath || block.path), "unknown")}>
				<header class="prw-diff-header">
					<div>
						<strong>${asText(block && block.status, "modified")}</strong>
						<span>${label}</span>
					</div>
					<div class="prw-diff-header-actions">
						${block && block.oldPath && block.oldPath !== block.filePath ? html`<small>was ${block.oldPath}</small>` : nothing}
						<button
							class="prw-ghost-button prw-diff-toggle"
							type="button"
							data-testid="prw-diff-toggle"
							aria-expanded=${String(!collapsed)}
							@click=${() => updateNestedMap(entry, host, paramKey, "collapsedDiffBlocks", key, !collapsed)}
						>${collapsed ? "Expand" : "Collapse"}</button>
					</div>
				</header>
				${collapsed ? nothing : mode === "inline" ? renderInlineDiff(entry, host, paramKey, card, block || {}) : renderSideDiff(entry, host, paramKey, card, block || {})}
			</section>
		`;
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
		const openEditor = () => {
			const cur = byJob.get(paramKey) || entry;
			patchEntry(host, paramKey, {
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: true },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: asText((cur.cardCommentDraft || {})[card.id]) },
			});
		};
		const cancel = () => {
			const cur = byJob.get(paramKey) || entry;
			patchEntry(host, paramKey, {
				cardCommentOpen: { ...(cur.cardCommentOpen || {}), [card.id]: false },
				cardCommentDraft: { ...(cur.cardCommentDraft || {}), [card.id]: "" },
			});
		};
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
		return html`
			<section class="prw-card-comments" data-testid="prw-card-comments">
				<div class="prw-card-comments-head">
					<div>
						<div class="prw-section-eyebrow">Card-level comments</div>
						<strong>Suggested concerns and reviewer notes</strong>
					</div>
					<button class="prw-ghost-button" @click=${openEditor}>Add card comment</button>
				</div>
				${suggestions.length ? html`<div class="prw-card-suggestions">${suggestions.map((s) => html`<button class="prw-suggestion-chip"><span>Suggested concern</span>${asText(s.body || s.text || s.summary || s)}</button>`)}</div>` : nothing}
				${saved.length ? html`<div class="prw-user-comments">${saved.map((comment) => html`<div class="prw-user-comment" data-testid="prw-card-user-comment"><strong>Your card comment</strong><p>${comment}</p></div>`)}</div>` : nothing}
				${open ? html`<div class="prw-comment-editor" data-testid="prw-card-comment-editor">
					<textarea
						class="prw-card-editor"
						.value=${asText((entry.cardCommentDraft || {})[card.id])}
						placeholder="Write your own card-level review note"
						@input=${(ev) => updateNestedMap(entry, host, paramKey, "cardCommentDraft", card.id, ev.currentTarget.value)}
					></textarea>
					<div class="prw-comment-actions">
						<button class="prw-ghost-button" @click=${save}>Save comment</button>
						<button class="prw-ghost-button" @click=${cancel}>Cancel</button>
					</div>
				</div>` : nothing}
			</section>
		`;
	};

	const renderReviewControls = (entry, host, paramKey, card) => {
		const cards = cardsOf(entry);
		const idx = Math.max(0, cards.findIndex((c) => c.id === card.id));
		const hasComments = hasSavedUserComments(entry, card);
		return html`
			<footer class="prw-review-controls" data-testid="prw-review-controls">
				<button class="prw-ghost-button" ?disabled=${idx <= 0} @click=${() => moveCard(entry, host, paramKey, -1)}>Prev</button>
				<div class="prw-decision-buttons">
					<button class="prw-dislike-button" ?disabled=${!hasComments} @click=${() => markCard(entry, host, paramKey, card, "disliked")}>Dislike</button>
					<button class="prw-like-button" @click=${() => markCard(entry, host, paramKey, card, "liked")}>Like</button>
				</div>
			</footer>
		`;
	};

	const renderCardBody = (entry, host, paramKey, card) => {
		const anchoredIds = anchoredSuggestionIds(card);
		const suggestedComments = arrayOf(card.suggestedComments).filter((suggestion) => !anchoredIds.has(asText(suggestion && suggestion.id, suggestionBody(suggestion))));
		return html`
			<article class="prw-card" data-testid="prw-card" data-prw-card=${card.id}>
				<section class="prw-card-story">
					<div class="prw-card-topline">
						<span>${PHASES.find((phase) => phase.id === cardPhase(card))?.label || cardPhase(card)}</span>
						<span>${deriveNavLabel(card)}</span>
					</div>
					<h2>${card.title || "Review card"}</h2>
					${card.summary ? html`<p class="prw-summary">${card.summary}</p>` : nothing}
					${card.rationale ? html`<p class="prw-rationale">${card.rationale}</p>` : nothing}
					${renderOrientationStepper(entry, host, paramKey, card)}
					${Array.isArray(card.checklist) && card.checklist.length
						? html`<ul class="prw-checklist">${card.checklist.map((item) => html`<li>${item}</li>`)}</ul>`
						: nothing}
				</section>
				<div class="prw-diff-toolbar">
					<div>
						<div class="prw-section-eyebrow">Diff review</div>
						<small>Review each grouped file hunk and leave anchored feedback.</small>
					</div>
					${renderDiffModeControls(entry, host, paramKey)}
				</div>
				<div class="prw-diff-list">
					${arrayOf(card.diffBlocks).length
						? arrayOf(card.diffBlocks).map((block) => renderDiffBlock(entry, host, paramKey, card, block))
						: html`<div class="prw-no-diff"><span>No diff block on this card.</span><button class="prw-line-comment-button" disabled>Line comments appear on diff lines</button></div>`}
				</div>
				${suggestedComments.length
					? html`<section class="prw-line-suggestions"><div class="prw-section-eyebrow">Other line-level suggested comments</div>${suggestedComments.map(renderSuggestedComment(entry, host, paramKey, card))}</section>`
					: nothing}
				${renderCardComments(entry, host, paramKey, card)}
				${renderReviewControls(entry, host, paramKey, card)}
			</article>
		`;
	};

	const renderBundle = (entry, host, paramKey, displayJob) => {
		const b = entry.bundle;
		if (b && b.found === false) {
			return html`<div class="prw-empty" data-testid="prw-empty">
				No walkthrough has been persisted for <span>${displayJob}</span> yet.
			</div>`;
		}
		const active = activeCard(entry);
		const yaml = entry.toolCall && entry.toolCall.input && typeof entry.toolCall.input.yaml === "string"
			? entry.toolCall.input.yaml
			: undefined;
		return html`
			<div class="prw-bundle" data-testid="prw-bundle">
				${renderHeaderBlock(entry, host, paramKey)}
				<div class="prw-debug-meta" aria-hidden="true">
					<span data-testid="prw-persisted-at">${String(b.persistedAt ?? "")}</span>
					<span data-testid="prw-toolcall">${yaml ? yaml.slice(0, 80) : "(none)"}</span>
				</div>
				<div class="prw-workspace">
					${renderNavRail(entry, host, paramKey)}
					<main class="prw-card-pane">
						${active ? renderCardBody(entry, host, paramKey, active) : html`<div class="prw-no-cards" data-testid="prw-no-cards">This walkthrough has no cards.</div>`}
					</main>
				</div>
			</div>
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
				const diffMode = cur.userSetMode && cur.diffMode ? cur.diffMode : defaultDiffMode();
				storeEntry(targetKey, { ...cur, status: "rendered", bundle, toolCall, activeCardId: firstCard, jobId, diffMode, mountKicked: true });
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
			const renderPendingShell = () => html`<div class="prw-pending" data-testid="prw-pending">
				<header class="prw-review-header prw-pending-header">
					<div class="prw-review-kicker">
						<span>Reviewer child session</span>
						<span class="prw-header-shas">${displayJob}</span>
					</div>
					<div class="prw-header-main">
						<div class="prw-title-wrap">
							<div class="prw-pr-pill">${spinner}</div>
							<h1>PR Walkthrough: In Progress</h1>
						</div>
						<span class="prw-pending-badge">Generating review cards</span>
					</div>
					<div class="prw-header-meta">
						<span class="prw-stat">changeset scan</span>
						<span class="prw-stat">phase outline</span>
						<span class="prw-stat">diff grouping</span>
					</div>
					<div class="prw-progress-row">
						<div class="prw-progress-copy">Waiting for submitted walkthrough YAML</div>
						<div class="prw-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="35">
							<div class="prw-progress-fill prw-progress-indeterminate"></div>
						</div>
					</div>
				</header>
				<div class="prw-workspace prw-pending-workspace">
					<nav class="prw-phase-rail" aria-label="Pending PR walkthrough phase rail">
						${PHASES.map((phase, index) => html`<section class="prw-phase ${index === 0 ? "is-active" : ""}">
							<div class="prw-phase-heading"><span class="prw-phase-index">${index + 1}</span><span>${phase.label}</span></div>
							<div class="prw-pending-nav-line"></div>
						</section>`)}
					</nav>
					<nav class="prw-phase-rail-collapsed" aria-label="Pending collapsed PR walkthrough phase rail">
						${PHASES.map((phase, index) => html`<div class="prw-rail-pip-group"><span class="prw-rail-pip ${index === 0 ? "is-active" : ""}">${phase.short || index + 1}</span><span class="prw-rail-dot"></span></div>`)}
					</nav>
					<main class="prw-card-pane">
						<article class="prw-card prw-pending-card">
							<section class="prw-card-story">
								<div class="prw-card-topline"><span>Orientation</span><span>assembling</span></div>
								<h2>Building the guided review shell</h2>
								<p class="prw-summary">The reviewer is grouping the PR into phases, diff-backed cards, suggested comments, and review decisions. This pane will hydrate in place when the child submits.</p>
								<div class="prw-orientation-stepper">
									<div class="prw-stepper-rail">
										${["At a glance", "Why it exists", "Where to look"].map((label, index) => html`<div class="prw-step ${index === 0 ? "is-current" : ""}"><span>${index + 1}</span><small>${label}</small></div>`)}
									</div>
									<div class="prw-stepper-card">
										<div class="prw-step-count">Preparing orientation beats</div>
										<div class="prw-pending-line is-wide"></div>
										<div class="prw-pending-line"></div>
									</div>
								</div>
							</section>
							<section class="prw-diff-block prw-pending-diff">
								<header class="prw-diff-header"><div><strong>pending</strong><span>diff widgets will appear here</span></div></header>
								<div class="prw-pending-code"><span></span><span></span><span></span></div>
							</section>
						</article>
					</main>
				</div>
			</div>`;

			return html`
				<style>
					@keyframes prw-spin { to { transform: rotate(360deg); } }
					.prw-root { color: var(--foreground); background: var(--background); padding: 12px; min-height: 100%; box-sizing: border-box; }
					.prw-shell { border: 1px solid var(--border); border-radius: 18px; background: var(--card); overflow: hidden; box-shadow: 0 20px 60px color-mix(in oklch, var(--foreground) 8%, transparent); }
					.prw-review-header { padding: 18px; border-bottom: 1px solid var(--border); background: linear-gradient(135deg, color-mix(in oklch, var(--chart-1) 12%, transparent), color-mix(in oklch, var(--chart-2) 8%, transparent)); }
					.prw-review-kicker, .prw-header-main, .prw-header-meta, .prw-progress-row, .prw-title-wrap, .prw-workspace, .prw-card-topline, .prw-diff-header, .prw-card-comments-head, .prw-review-controls, .prw-decision-buttons { display: flex; align-items: center; gap: 10px; }
					.prw-review-kicker { justify-content: space-between; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
					.prw-header-shas, .prw-debug-meta { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
					.prw-header-main { justify-content: space-between; align-items: flex-start; margin-top: 10px; gap: 16px; }
					.prw-title-wrap { align-items: flex-start; gap: 12px; }
					.prw-pr-pill, .prw-stat { border: 1px solid var(--border); border-radius: 999px; background: color-mix(in oklch, var(--card) 76%, transparent); padding: 4px 9px; font-size: 12px; font-weight: 650; white-space: nowrap; }
					.prw-review-header h1 { margin: 0; font-size: clamp(20px, 3vw, 30px); line-height: 1.08; letter-spacing: -.03em; }
					.prw-gh-link, .prw-submit-button, .prw-like-button { border-radius: 999px; border: 1px solid var(--primary); background: var(--primary); color: var(--primary-foreground); padding: 7px 11px; font-weight: 650; text-decoration: none; white-space: nowrap; }
					.prw-header-meta { flex-wrap: wrap; margin-top: 14px; }
					.prw-add { color: var(--positive); border-color: color-mix(in oklch, var(--positive) 32%, var(--border)); }
					.prw-del { color: var(--negative); border-color: color-mix(in oklch, var(--negative) 32%, var(--border)); }
					.prw-progress-row { margin-top: 14px; }
					.prw-progress-copy { min-width: max-content; color: var(--muted-foreground); font-size: 12px; }
					.prw-progress-track { height: 8px; min-width: 90px; flex: 1; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 14%, transparent); overflow: hidden; }
					.prw-progress-fill { height: 100%; border-radius: inherit; background: var(--primary); }
					.prw-debug-meta { display: none; }
					.prw-workspace { align-items: stretch; min-height: 520px; }
					.prw-phase-rail { width: 230px; flex: 0 0 230px; padding: 14px 10px; border-right: 1px solid var(--border); background: color-mix(in oklch, var(--background) 72%, var(--card)); overflow: auto; }
					.prw-phase-rail-collapsed { display: none; width: 42px; flex: 0 0 42px; padding: 12px 5px; border-right: 1px solid var(--border); background: color-mix(in oklch, var(--background) 72%, var(--card)); }
					.prw-phase { margin-bottom: 14px; }
					.prw-phase-heading { display: flex; align-items: center; gap: 8px; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin-bottom: 6px; }
					.prw-phase-index, .prw-rail-pip { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--border); color: var(--foreground); background: var(--card); font-size: 11px; }
					.prw-nav-card { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; border-radius: 10px; padding: 7px 8px; background: transparent; color: var(--muted-foreground); text-align: left; cursor: pointer; }
					.prw-nav-card:hover, .prw-nav-card.is-active { color: var(--foreground); background: color-mix(in oklch, var(--primary) 12%, transparent); }
					.prw-nav-dot, .prw-rail-dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--card); flex: 0 0 auto; }
					.prw-nav-card.is-reviewed .prw-nav-dot, .prw-rail-dot.is-active, .prw-rail-pip.is-active { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
					.prw-rail-pip-group { display: grid; justify-items: center; gap: 6px; margin-bottom: 14px; }
					.prw-rail-dot { padding: 0; }
					.prw-card-pane { flex: 1; min-width: 0; overflow: auto; padding: 18px; }
					.prw-card { max-width: 1120px; margin: 0 auto; }
					.prw-card-topline { justify-content: space-between; color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
					.prw-card h2 { margin: 8px 0 0; font-size: clamp(20px, 2.5vw, 28px); line-height: 1.12; }
					.prw-summary, .prw-rationale { color: var(--muted-foreground); line-height: 1.55; }
					.prw-rationale { border-left: 3px solid var(--chart-3); padding-left: 10px; }
					.prw-orientation-stepper, .prw-card-comments, .prw-no-diff { border: 1px solid var(--border); border-radius: 16px; background: color-mix(in oklch, var(--card) 84%, transparent); padding: 12px; margin-top: 14px; }
					.prw-stepper-rail { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
					.prw-step { min-width: 86px; border: 1px solid var(--border); border-radius: 14px; background: var(--background); color: var(--muted-foreground); padding: 8px; text-align: left; }
					.prw-step span { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 999px; border: 1px solid var(--border); margin-bottom: 6px; }
					.prw-step.is-current { color: var(--foreground); border-color: var(--primary); box-shadow: inset 0 0 0 1px var(--primary); }
					.prw-step.is-visited span { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
					.prw-step small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.prw-stepper-card { margin-top: 8px; }
					.prw-step-count, .prw-section-eyebrow, .prw-suggestion-anchor { color: var(--muted-foreground); font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
					.prw-section h3 { margin: 6px 0; font-size: 18px; }
					.prw-section p { color: var(--muted-foreground); line-height: 1.55; }
					.prw-verdict, .prw-suggested-comment { border: 1px solid color-mix(in oklch, var(--warning) 34%, var(--border)); background: color-mix(in oklch, var(--warning) 8%, transparent); border-radius: 12px; padding: 10px; margin-top: 10px; }
					.prw-concern-list, .prw-checklist { color: var(--muted-foreground); line-height: 1.5; }
					.prw-file-roles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; margin-top: 10px; }
					.prw-file-roles > div { border: 1px solid var(--border); border-radius: 12px; padding: 8px; }
					.prw-file-roles span, .prw-file-roles small { display: block; color: var(--muted-foreground); }
					.prw-stepper-actions, .prw-diff-mode, .prw-comment-actions, .prw-diff-header-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; }
					.prw-diff-mode { justify-content: flex-end; }
					.prw-comment-actions { justify-content: flex-end; }
					.prw-segment, .prw-ghost-button, .prw-dislike-button, .prw-line-comment-button, .prw-suggestion-chip { border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--foreground); padding: 6px 9px; }
					.prw-segment.is-active { border-color: var(--primary); background: color-mix(in oklch, var(--primary) 14%, transparent); }
					.prw-diff-block { margin-top: 12px; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: var(--background); }
					.prw-diff-header { justify-content: space-between; padding: 9px 10px; border-bottom: 1px solid var(--border); background: color-mix(in oklch, var(--muted-foreground) 8%, transparent); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
					.prw-diff-header div { display: flex; gap: 8px; align-items: center; min-width: 0; }
					.prw-diff-header-actions { margin-top: 0; flex: 0 0 auto; }
					.prw-diff-toggle { font-family: inherit; font-size: 11px; padding: 3px 7px; }
					.prw-diff-header span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
					.prw-diff-scroll { overflow-x: auto; max-width: 100%; }
					.prw-diff-table { width: 100%; min-width: 760px; border-collapse: collapse; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 12px; }
					.prw-diff-table td { border-bottom: 1px solid color-mix(in oklch, var(--border) 56%, transparent); padding: 2px 6px; vertical-align: top; }
					.prw-hunk-row td { color: var(--info); background: color-mix(in oklch, var(--info) 9%, transparent); }
					.prw-line-number { width: 42px; color: var(--muted-foreground); text-align: right; user-select: none; }
					.prw-prefix { width: 20px; text-align: center; color: var(--muted-foreground); }
					.prw-code { white-space: pre; min-width: 260px; }
					.prw-code code { white-space: pre; }
					.prw-line.is-add { background: color-mix(in oklch, var(--positive) 13%, transparent); }
					.prw-line.is-del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
					.prw-side-row.is-change .prw-old.is-del, .prw-side-row.is-del .prw-old.is-del { background: color-mix(in oklch, var(--negative) 13%, transparent); }
					.prw-side-row.is-change .prw-new.is-add, .prw-side-row.is-add .prw-new.is-add { background: color-mix(in oklch, var(--positive) 13%, transparent); }
					.prw-side-row .prw-code.is-empty { background: color-mix(in oklch, var(--muted-foreground) 5%, transparent); }
					.prw-comment-cell { width: 118px; text-align: right; }
					.prw-line-comment-button { opacity: .72; font-size: 11px; padding: 3px 7px; }
					.prw-line-comment-button:hover, .prw-line:focus-within .prw-line-comment-button { opacity: 1; border-color: var(--primary); }
					.prw-line-suggestions, .prw-card-comments { margin-top: 14px; }
					.prw-line-suggestion-row td { background: color-mix(in oklch, var(--warning) 5%, transparent); padding: 8px 10px; }
					.prw-inline-suggestions { display: grid; gap: 8px; }
					.prw-inline-suggested-comment { margin-top: 0; }
					.prw-suggested-comment { display: grid; gap: 6px; }
					.prw-card-comments-head { justify-content: space-between; }
					.prw-card-suggestions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
					.prw-suggestion-chip { background: color-mix(in oklch, var(--chart-2) 10%, transparent); }
					.prw-card-editor, .prw-comment-editor textarea { width: 100%; min-height: 72px; margin-top: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--background); color: var(--foreground); padding: 8px; box-sizing: border-box; }
					.prw-line-comment-row td { background: color-mix(in oklch, var(--chart-1) 6%, transparent); padding: 8px 10px; }
					.prw-user-comments { display: grid; gap: 8px; margin-top: 10px; }
					.prw-user-comment { border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border)); border-radius: 12px; background: color-mix(in oklch, var(--primary) 7%, transparent); padding: 8px 10px; }
					.prw-user-comment strong { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted-foreground); }
					.prw-user-comment p { margin: 4px 0 0; white-space: pre-wrap; color: var(--foreground); }
					.prw-review-controls { justify-content: space-between; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border); }
					.prw-dislike-button { color: var(--foreground); }
					.prw-dislike-button:hover:not(:disabled), .prw-dislike-button:focus-visible:not(:disabled) { border-color: var(--negative); color: var(--negative); background: color-mix(in oklch, var(--negative) 10%, transparent); }
					button:disabled { opacity: .48; cursor: not-allowed; }
					.prw-spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--muted-foreground); border-top-color: transparent; border-radius: 50%; animation: prw-spin .8s linear infinite; }
					.prw-pending, .prw-empty, .prw-neutral, .prw-error { display: flex; align-items: center; gap: 8px; padding: 18px; color: var(--muted-foreground); }
					.prw-error { color: var(--negative); }
					@media (max-width: 760px) {
						.prw-root { padding: 0; }
						.prw-shell { border-radius: 0; border-left: 0; border-right: 0; }
						.prw-header-main, .prw-progress-row, .prw-review-controls { flex-wrap: wrap; }
						.prw-phase-rail { display: none; }
						.prw-phase-rail-collapsed { display: block; }
						.prw-card-pane { padding: 12px; }
						.prw-diff-mode { justify-content: flex-start; }
						.prw-side-diff { min-width: 860px; }
					}
					@keyframes prw-pulse { 0%, 100% { opacity: .38; } 50% { opacity: .9; } }
					* { box-sizing: border-box; }
					.prw-shell { min-height: calc(100vh - 24px); background: color-mix(in oklch, var(--card) 92%, var(--background)); box-shadow: 0 22px 70px color-mix(in oklch, var(--foreground) 10%, transparent); }
					.prw-review-header { padding: 16px 18px 14px; background: linear-gradient(135deg, color-mix(in oklch, var(--card) 88%, var(--background)), color-mix(in oklch, var(--chart-1) 10%, transparent)); }
					.prw-review-header h1 { overflow-wrap: anywhere; }
					.prw-pr-pill { color: var(--chart-1); border-color: color-mix(in oklch, var(--chart-1) 28%, var(--border)); }
					.prw-gh-link, .prw-submit-button, .prw-like-button { box-shadow: 0 8px 20px color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-progress-fill { background: linear-gradient(90deg, var(--primary), color-mix(in oklch, var(--chart-2) 65%, var(--primary))); }
					.prw-progress-indeterminate { width: 42%; animation: prw-pulse 1.45s ease-in-out infinite; }
					.prw-workspace { min-height: 540px; overflow: hidden; }
					.prw-phase-rail { width: 248px; flex-basis: 248px; padding: 12px; background: color-mix(in oklch, var(--card) 62%, var(--background)); }
					.prw-phase-rail-collapsed { background: color-mix(in oklch, var(--card) 62%, var(--background)); overflow-y: auto; overflow-x: hidden; }
					.prw-phase { margin: 3px 0 10px; border-radius: 10px; padding: 2px; }
					.prw-phase.is-active { background: color-mix(in oklch, var(--primary) 8%, transparent); }
					.prw-phase-heading { margin: 0 0 5px; padding: 5px 6px; }
					.prw-phase-index, .prw-rail-pip { font-weight: 750; }
					.prw-nav-card { border-radius: 7px; padding: 6px 7px 6px 28px; font-size: 12px; position: relative; }
					.prw-nav-card .prw-nav-dot { position: absolute; left: 11px; }
					.prw-nav-card.is-reviewed .prw-nav-dot, .prw-rail-dot.is-active, .prw-rail-pip.is-active { box-shadow: 0 0 0 3px color-mix(in oklch, var(--primary) 18%, transparent); }
					.prw-card-pane { padding: 24px clamp(14px, 3vw, 46px) 34px; background: color-mix(in oklch, var(--background) 92%, var(--card)); }
					.prw-card { display: grid; gap: 14px; }
					.prw-card-story, .prw-card-comments, .prw-no-diff { border: 1px solid var(--border); border-radius: 18px; background: color-mix(in oklch, var(--card) 96%, var(--background)); padding: 16px; box-shadow: 0 10px 30px color-mix(in oklch, var(--foreground) 5%, transparent); }
					.prw-card h2 { letter-spacing: -.02em; }
					.prw-summary, .prw-rationale { max-width: 860px; line-height: 1.62; }
					.prw-rationale { background: color-mix(in oklch, var(--chart-3) 7%, transparent); border-radius: 0 10px 10px 0; padding-top: 8px; padding-bottom: 8px; }
					.prw-orientation-stepper { background: color-mix(in oklch, var(--background) 76%, var(--card)); }
					.prw-stepper-card { border: 1px solid color-mix(in oklch, var(--border) 70%, transparent); border-radius: 14px; background: color-mix(in oklch, var(--card) 98%, var(--background)); padding: 12px; }
					.prw-file-roles > div { background: color-mix(in oklch, var(--card) 88%, var(--background)); }
					.prw-diff-toolbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 10px; margin: 3px 0 -2px; }
					.prw-diff-toolbar small { color: var(--muted-foreground); }
					.prw-diff-mode { margin-top: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--card); }
					.prw-segment { border: 0; border-radius: 0; color: var(--muted-foreground); }
					.prw-segment.is-active { background: var(--primary); color: var(--primary-foreground); }
					.prw-diff-list { display: grid; gap: 12px; }
					.prw-diff-block { margin-top: 0; border-radius: 12px; background: color-mix(in oklch, var(--card) 98%, var(--background)); box-shadow: 0 8px 24px color-mix(in oklch, var(--foreground) 4%, transparent); }
					.prw-diff-header { padding: 9px 12px; }
					.prw-diff-header strong { color: var(--chart-1); text-transform: uppercase; font-size: 10px; letter-spacing: .06em; border: 1px solid color-mix(in oklch, var(--chart-1) 24%, var(--border)); border-radius: 5px; padding: 2px 6px; }
					.prw-diff-scroll { overflow-x: auto; overflow-y: hidden; max-width: 100%; overscroll-behavior-x: contain; scrollbar-gutter: stable; }
					.prw-diff-table { min-width: 680px; table-layout: fixed; }
					.prw-side-diff { min-width: 860px; }
					.prw-inline-diff { min-width: 640px; }
					.prw-diff-table td { padding: 3px 6px; }
					.prw-code { min-width: 0; overflow: visible; }
					.prw-code code { display: block; width: max-content; min-width: 100%; background: transparent; padding: 0; }
					.prw-line-comment-button { background: color-mix(in oklch, var(--card) 82%, transparent); }
					.prw-line-comment-button:hover, .prw-line:focus-within .prw-line-comment-button { background: var(--primary); color: var(--primary-foreground); }
					.prw-suggested-comment { position: relative; border-left: 4px solid color-mix(in oklch, var(--warning) 70%, var(--border)); }
					.prw-inline-suggested-comment { margin-top: 0; background: color-mix(in oklch, var(--warning) 10%, var(--card)); }
					.prw-card-suggestions { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 8px; margin-top: 12px; }
					.prw-suggestion-chip { display: grid; gap: 4px; text-align: left; white-space: normal; border-radius: 10px; background: color-mix(in oklch, var(--warning) 8%, var(--card)); border-color: color-mix(in oklch, var(--warning) 30%, var(--border)); line-height: 1.35; }
					.prw-suggestion-chip span { color: var(--muted-foreground); font-size: 10px; text-transform: uppercase; letter-spacing: .08em; }
					.prw-card-editor, .prw-comment-editor textarea { font: inherit; resize: vertical; }
					.prw-review-controls { margin-top: 4px; padding: 12px 14px; border: 1px solid var(--border); border-radius: 16px; background: color-mix(in oklch, var(--card) 96%, var(--background)); box-shadow: 0 10px 28px color-mix(in oklch, var(--foreground) 4%, transparent); }
					button { cursor: pointer; font: inherit; }
					.prw-pending { display: block; padding: 0; color: var(--foreground); }
					.prw-pending-header .prw-pr-pill { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; }
					.prw-pending-badge { border: 1px solid color-mix(in oklch, var(--primary) 28%, var(--border)); border-radius: 999px; background: color-mix(in oklch, var(--card) 78%, transparent); color: var(--primary); padding: 4px 9px; font-size: 12px; font-weight: 650; white-space: nowrap; }
					.prw-pending-nav-line, .prw-pending-line, .prw-pending-code span { display: block; border-radius: 999px; background: color-mix(in oklch, var(--muted-foreground) 16%, transparent); animation: prw-pulse 1.6s ease-in-out infinite; }
					.prw-pending-nav-line { height: 9px; margin: 8px 9px 12px 36px; }
					.prw-pending-card .prw-card-story { border-style: dashed; }
					.prw-pending-line { height: 10px; width: 70%; margin-top: 10px; }
					.prw-pending-line.is-wide { width: 92%; }
					.prw-pending-code { display: grid; gap: 8px; padding: 14px; }
					.prw-pending-code span { height: 12px; }
					.prw-pending-code span:nth-child(2) { width: 74%; background: color-mix(in oklch, var(--positive) 18%, transparent); }
					.prw-pending-code span:nth-child(3) { width: 58%; background: color-mix(in oklch, var(--negative) 16%, transparent); }
					@media (max-width: 900px) {
						.prw-workspace { min-height: 500px; }
						.prw-phase-rail { display: none; }
						.prw-phase-rail-collapsed { display: block; }
					}
					@media (max-width: 760px) {
						.prw-shell { min-height: 100vh; }
						.prw-review-header { padding: 14px; }
						.prw-card-story, .prw-card-comments, .prw-no-diff { border-radius: 14px; padding: 12px; }
						.prw-side-diff { min-width: 840px; }
					}
				</style>
				<div class="prw-root" data-testid="prw-panel-root" data-prw-job=${displayJob}>
					<div class="prw-shell">
						${entry.bundle
							? renderBundle(entry, host, paramKey, displayJob)
							: status === "error" && entry.error
								? html`<div class="prw-error" data-testid="prw-error">${entry.error}</div>`
								: isPending
									? renderPendingShell()
									: html`<div class="prw-neutral" data-testid="prw-neutral">
										No PR walkthrough is available in this session.
									</div>`}
					</div>
				</div>
			`;
		},
	};
}
