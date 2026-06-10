// Pack CLIENT panel module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// Pre-built ESM module served by the bearer-only panel endpoint and lazy-imported
// (Blob URL) by the client pack-panels registry. The default factory is handed the
// host's OWN lit toolkit (so the pack shares the app's single lit instance + the
// standard header shape) and each render() is handed the per-session Host API
// (getHostApi(sessionId, undefined, packTool); design extension-host-phase2 §2a.2).
//
// Re-expresses src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts as a pack
// viewer with PARITY on the load-bearing surfaces — the changeset header (PR
// title, sha range, files/+/- stats), the phase NAV RAIL (orientation → design →
// significant → other → audit, cards grouped under each phase), the active card
// (summary, rationale, diff blocks with hunks/lines, suggested comments). ALL
// dynamic data flows through the Host API — NEVER a raw fetch:
//   - host.callRoute("bundle", { query:{ jobId, baseSha, headSha } })
//     → the pack's OWN route module (re-expressing handlePrWalkthroughApiRoute),
//     which RECOMPUTES the REAL changeset LIVE via git in the confined worker
//     (design §D2.3 — declared git/fs) and READS any LLM-enhanced cards persisted
//     at submit time — never a synthetic fixture.
//   - host.session.readToolCall(toolUseId)            → reads the
//     submit_pr_walkthrough_yaml tool call (own-session) instead of bespoke
//     transcript access.
//
// SECURITY: NO auto-invoke on mount (v1 §5 v). The bundle/tool-call reads fire ONLY
// from the user's "Load walkthrough" click (the gesture). Theme tokens only; the
// content is structured data rendered via the escaping lit toolkit (no raw-HTML /
// unsafeHTML injection surface — the iframe-sandbox convention is preserved).
//
// LLM-CARD PARITY — the read→publish seam (design built-in-first-party-packs §8.4):
// On Load the panel reads the submit_pr_walkthrough_yaml tool call, PARSES the cards
// out of the submitted YAML, and PERSISTS them to the pack-scoped host.store via
// host.callRoute("publish", …) — all inside the user's Load gesture (no auto-invoke
// on mount, no test helper). The subsequent host.callRoute("bundle") then prefers the
// just-persisted LLM cards over the deterministic in-worker structural fallback, so
// the pack viewer reaches parity with the deleted built-in viewer using only the
// caller-pack-scoped Host API. The agent's submit tool stays unchanged.

import { parse as parseYaml } from "yaml";

// Extract the LLM-enhanced cards from the submitted YAML tool call. The agent's
// submit_pr_walkthrough_yaml emits a YAML document; the migration-friendly shape
// carries the rendered cards under a top-level `cards:` (or `walkthrough.cards:`)
// array, which the panel publishes verbatim to the pack store. Returns [] when the
// tool call is absent/unparseable or carries no cards (→ structural fallback).
function cardsFromSubmittedYaml(toolCall) {
	const yamlText = toolCall && toolCall.input && typeof toolCall.input.yaml === "string" ? toolCall.input.yaml : undefined;
	if (!yamlText) return [];
	let doc;
	try { doc = parseYaml(yamlText); } catch { return []; }
	if (!doc || typeof doc !== "object") return [];
	if (Array.isArray(doc.cards)) return doc.cards;
	if (doc.walkthrough && Array.isArray(doc.walkthrough.cards)) return doc.walkthrough.cards;
	return [];
}

// Phase ordering + labels mirror PrWalkthroughPanel.ts PHASES so the nav rail
// groups the cards exactly as the bespoke walkthrough does.
const PHASES = [
	{ id: "orientation", label: "Orientation" },
	{ id: "design", label: "Key design choices" },
	{ id: "significant", label: "Significant changes" },
	{ id: "other", label: "Other + omissions" },
	{ id: "audit", label: "Audit" },
];

export default function createPanel({ html, nothing, renderHeader }) {
	// Keep the toolkit's header helper referenced (contract clarity) even though
	// this panel draws a compact header of its own.
	void renderHeader;

	// jobId → { bundle?, toolCall?, error?, activeCardId? }. Module-level so it
	// survives panel re-mounts within a page session (a deep-link re-open paints
	// instantly); a full reload clears it, so the next Load re-reads the SAME
	// persisted store record.
	const byJob = new Map();
	const loadingJobs = new Set();

	const lineClass = (kind) =>
		kind === "add"
			? "background:color-mix(in oklch, var(--positive) 16%, transparent);color:var(--foreground);"
			: kind === "del"
				? "background:color-mix(in oklch, var(--negative) 16%, transparent);color:var(--foreground);"
				: "color:var(--muted-foreground);";
	const linePrefix = (kind) => (kind === "add" ? "+" : kind === "del" ? "-" : " ");

	const cardsOf = (entry) => (entry && entry.bundle && Array.isArray(entry.bundle.cards)) ? entry.bundle.cards : [];

	const activeCard = (entry) => {
		const cards = cardsOf(entry);
		if (cards.length === 0) return undefined;
		const found = cards.find((c) => c.id === entry.activeCardId);
		return found || cards[0];
	};

	const renderDiffBlock = (block) => html`
		<div class="mt-3 rounded border border-border overflow-hidden" data-testid="prw-diffblock" data-prw-file=${block.filePath}>
			<div class="px-2 py-1 text-xs font-mono bg-muted/40 text-foreground border-b border-border flex items-center justify-between gap-2">
				<span>${block.status ?? "modified"} ${block.filePath}</span>
				${block.oldPath && block.oldPath !== block.filePath
					? html`<span class="text-muted-foreground">(was ${block.oldPath})</span>`
					: nothing}
			</div>
			${(block.hunks ?? []).map(
				(hunk) => html`
					<div class="px-2 py-0.5 text-xs font-mono" style="color:var(--muted-foreground);background:color-mix(in oklch, var(--info) 10%, transparent);">${hunk.header}</div>
					${(hunk.lines ?? []).map(
						(ln) => html`<div class="px-2 font-mono text-xs whitespace-pre" style=${lineClass(ln.kind)}>${linePrefix(ln.kind)}${ln.text}</div>`,
					)}
				`,
			)}
		</div>
	`;

	const renderSuggestedComment = (sc) => html`
		<div class="mt-2 rounded border-l-2 p-2 text-xs"
			style="border-color:var(--warning);background:color-mix(in oklch, var(--warning) 7%, transparent);"
			data-testid="prw-suggested-comment" data-prw-comment=${sc.id}>
			<div class="font-mono text-[10px] text-muted-foreground">${sc.diffBlockId}${sc.lineId ? ` · ${sc.lineId}` : ""}</div>
			<div class="text-foreground mt-0.5">${sc.body}</div>
		</div>
	`;

	const renderCardBody = (card) => html`
		<div data-testid="prw-card" data-prw-card=${card.id}>
			<div class="text-[10px] font-semibold uppercase tracking-wide" style="color:var(--chart-1)">${card.phaseId}</div>
			<div class="text-base font-semibold text-foreground mt-1">${card.title}</div>
			${card.summary ? html`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${card.summary}</div>` : nothing}
			${card.rationale ? html`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${card.rationale}</div>` : nothing}
			${Array.isArray(card.checklist) && card.checklist.length
				? html`<ul class="mt-2 pl-4 text-xs text-muted-foreground list-disc">${card.checklist.map((c) => html`<li>${c}</li>`)}</ul>`
				: nothing}
			${(card.diffBlocks ?? []).map(renderDiffBlock)}
			${Array.isArray(card.suggestedComments) && card.suggestedComments.length
				? html`<div class="mt-2"><div class="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested comments</div>${card.suggestedComments.map(renderSuggestedComment)}</div>`
				: nothing}
		</div>
	`;

	const renderNavRail = (entry, host, jobId) => {
		const cards = cardsOf(entry);
		const active = activeCard(entry);
		return html`
			<div class="w-44 flex-none border-r border-border pr-2 overflow-auto" data-testid="prw-navrail">
				${PHASES.map((phase) => {
					const phaseCards = cards.filter((c) => c.phaseId === phase.id);
					if (phaseCards.length === 0) return nothing;
					return html`
						<div class="mt-2 first:mt-0">
							<div class="text-[10px] uppercase tracking-wide text-muted-foreground px-1">${phase.label}</div>
							${phaseCards.map((card) => {
								const isActive = active && active.id === card.id;
								const onSelect = () => {
									const cur = byJob.get(jobId) || entry;
									byJob.set(jobId, { ...cur, activeCardId: card.id });
									if (host && host.requestRender) host.requestRender();
								};
								return html`<button
									class="block w-full text-left text-xs px-2 py-1 mt-0.5 rounded ${isActive ? "text-foreground" : "text-muted-foreground"} hover:bg-muted/50"
									style=${isActive ? "background:color-mix(in oklch, var(--primary) 12%, transparent);" : ""}
									data-testid="prw-nav-card" data-prw-nav=${card.id}
									@click=${onSelect}
								>${card.navLabel ?? card.title}</button>`;
							})}
						</div>
					`;
				})}
			</div>
		`;
	};

	const renderBundle = (entry, host, jobId) => {
		const b = entry.bundle;
		if (b && b.found === false) {
			return html`<div class="mt-3 text-xs text-muted-foreground" data-testid="prw-empty">
				No walkthrough has been submitted for <span class="font-mono">${jobId}</span> yet. Run a PR walkthrough so the agent submits and persists one.
			</div>`;
		}
		const cs = (b && b.changeset) || {};
		const active = activeCard(entry);
		const yaml = entry.toolCall && entry.toolCall.input && typeof entry.toolCall.input.yaml === "string"
			? entry.toolCall.input.yaml
			: undefined;
		return html`
			<div class="mt-2" data-testid="prw-bundle">
				<div class="text-sm font-semibold text-foreground" data-testid="prw-title">${cs.prTitle ?? cs.title ?? "Walkthrough"}</div>
				<div class="text-xs text-muted-foreground mt-0.5">
					<span class="font-mono">${(cs.baseSha ?? "").slice(0, 7)}…${(cs.headSha ?? "").slice(0, 7)}</span>
					· ${cs.filesChanged ?? 0} file(s)
					· <span style="color:var(--positive)">+${cs.additions ?? 0}</span>
					· <span style="color:var(--negative)">-${cs.deletions ?? 0}</span>
					${cs.provider ? html`· <span class="font-mono">${cs.provider}</span>` : nothing}
				</div>
				<div class="text-[10px] text-muted-foreground mt-1">
					persisted: <span data-testid="prw-persisted-at">${String(b.persistedAt ?? "")}</span>
				</div>
				<div class="text-[10px] text-muted-foreground" data-testid="prw-toolcall">
					submit yaml: ${yaml ? yaml.slice(0, 80) : "(none)"}
				</div>
				<div class="flex gap-3 mt-3">
					${renderNavRail(entry, host, jobId)}
					<div class="flex-1 min-w-0 overflow-auto">
						${active ? renderCardBody(active) : html`<div class="text-xs text-muted-foreground" data-testid="prw-no-cards">This walkthrough has no cards.</div>`}
					</div>
				</div>
			</div>
		`;
	};

	return {
		// PURE projection of the typed params onto a lit value. NO host call here —
		// the load is the user's gesture (the Load button below), never mount.
		render(params, host) {
			const jobId = (params && params.jobId) || "job-litmus-1";
			// Live-recompute coordinates (design §D2.3): a deep-link / launcher may
			// carry the PR's base/head so the route recomputes a freshly-opened PR's
			// changeset live. Absent, the route rehydrates them from the persisted job
			// pointer. The git repo root is ALWAYS the session worktree (server-derived
			// in the route) — a caller can NOT supply it, so no `repoDir` is sent.
			const baseSha = params && params.baseSha;
			const headSha = params && params.headSha;
			const entry = byJob.get(jobId);
			const loading = loadingJobs.has(jobId);

			const onLoad = async () => {
				if (!host) return;
				loadingJobs.add(jobId);
				if (host.requestRender) host.requestRender();
				try {
					// Read the submit_pr_walkthrough_yaml tool call (own-session) — best-
					// effort enrichment. Discover its id via an own-session transcript read,
					// then readToolCall(id). authorizeScopedRequest needs no owned toolUseId.
					let toolCall = null;
					if (host.capabilities && host.capabilities.session) {
						try {
							const env = await host.session.readTranscript({ pattern: "submit_pr_walkthrough_yaml", limit: 100 });
							let submitId;
							for (const m of (env.messages || [])) {
								for (const blk of (m.content || [])) {
									if (blk.type === "tool_use" && blk.tool === "submit_pr_walkthrough_yaml") submitId = blk.toolUseId;
								}
							}
							if (submitId) toolCall = await host.session.readToolCall(submitId);
						} catch { /* enrichment is non-fatal */ }
					}
					// LLM-card parity (design §8.4): persist the agent's submitted cards to
					// the pack-scoped store via the pack's OWN `publish` route BEFORE reading
					// `bundle`, so the bundle serves the LLM cards over the structural
					// fallback. Keyed by base/head so the live recompute finds them. This is
					// the read→publish seam — it runs inside the Load gesture, never on mount.
					const llmCards = cardsFromSubmittedYaml(toolCall);
					if (llmCards.length > 0 && host.callRoute) {
						try {
							const publishBody = { jobId, cards: llmCards };
							if (baseSha) publishBody.baseSha = baseSha;
							if (headSha) publishBody.headSha = headSha;
							await host.callRoute("publish", { method: "POST", body: publishBody });
						} catch { /* publish is best-effort; bundle falls back to structural cards */ }
					}
					// Dynamic data via the pack's OWN route — NEVER a raw fetch. The route
					// RECOMPUTES the changeset live via git (design §D2.3) when base/head are
					// supplied, else rehydrates them from the persisted job pointer.
					const query = { jobId };
					if (baseSha) query.baseSha = baseSha;
					if (headSha) query.headSha = headSha;
					const bundle = await host.callRoute("bundle", { query });
					const firstCard = Array.isArray(bundle && bundle.cards) && bundle.cards.length ? bundle.cards[0].id : undefined;
					byJob.set(jobId, { bundle, toolCall, activeCardId: firstCard });
				} catch (e) {
					byJob.set(jobId, { error: e && e.message ? e.message : String(e) });
				} finally {
					loadingJobs.delete(jobId);
					if (host.requestRender) host.requestRender();
				}
			};

			return html`
				<div class="p-3" data-testid="prw-panel-root" data-prw-job=${jobId}>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold text-foreground">PR Walkthrough</span>
						<span class="text-xs text-muted-foreground font-mono">${jobId}</span>
					</div>
					${!entry && !loading
						? html`<button
								class="mt-2 text-xs px-2 py-1 rounded border border-border bg-transparent text-foreground hover:bg-muted/50"
								data-testid="prw-load"
								@click=${onLoad}
							>
								Load walkthrough
							</button>`
						: nothing}
					${loading ? html`<div class="mt-2 text-xs text-muted-foreground" data-testid="prw-loading">Loading…</div>` : nothing}
					${entry && entry.error
						? html`<div class="mt-2 text-xs" style="color:var(--negative)" data-testid="prw-error">${entry.error}</div>`
						: nothing}
					${entry && entry.bundle ? renderBundle(entry, host, jobId) : nothing}
				</div>
			`;
		},
	};
}
