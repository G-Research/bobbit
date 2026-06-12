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
// driven; the reviewer child is minted by the `run` route (server-side, role-granted,
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
	{ id: "orientation", label: "Orientation" },
	{ id: "design", label: "Key design choices" },
	{ id: "significant", label: "Significant changes" },
	{ id: "other", label: "Other + omissions" },
	{ id: "audit", label: "Audit" },
];

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

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	// paramKey → { status, bundle?, toolCall?, error?, activeCardId?, jobId?,
	//              polling?, mountKicked?, slow? }.
	// status ∈ idle | running | publishing | rendered | error | empty.
	//   running    → pending: a reviewer child is producing the walkthrough; the pane
	//                self-polls `status` (the spinner + "PR Walkthrough: In Progress").
	//   publishing → transient: the reviewer submitted; running publish → bundle.
	//   empty      → resolved NOT a reviewer child (no binding/<self>) → neutral state.
	// Module-level so it survives panel re-mounts within a page session. Keyed by the
	// BOUND session id (`__sessionId`) so each reviewer child gets its OWN entry.
	const byJob = new Map();

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

	// Orientation "beats" (the six guided sections the production synthesis attaches
	// to the orientation card). Rendered compactly so the viewer reaches parity.
	const renderSection = (section) => html`
		<div class="mt-2" data-testid="prw-section" data-prw-section=${section.id}>
			${section.eyebrow ? html`<div class="text-[10px] uppercase tracking-wide" style="color:var(--chart-2)">${section.eyebrow}</div>` : nothing}
			<div class="text-sm font-semibold text-foreground">${section.heading}</div>
			${section.body ? html`<div class="text-xs text-muted-foreground mt-0.5 leading-relaxed">${section.body}</div>` : nothing}
			${section.verdict ? html`<div class="text-xs text-foreground mt-0.5">Recommendation: ${section.verdict.recommendation} (${section.verdict.confidence})</div>` : nothing}
			${Array.isArray(section.concerns) && section.concerns.length
				? html`<ul class="mt-1 pl-4 text-xs text-muted-foreground list-disc">${section.concerns.map((c) => html`<li>${c.severity}: ${c.text}</li>`)}</ul>`
				: nothing}
			${Array.isArray(section.fileRoles) && section.fileRoles.length
				? html`<ul class="mt-1 pl-4 text-xs text-muted-foreground list-disc">${section.fileRoles.map((r) => html`<li>${r.role}: ${r.file}${r.note ? ` — ${r.note}` : ""}</li>`)}</ul>`
				: nothing}
		</div>
	`;

	const renderCardBody = (card) => html`
		<div data-testid="prw-card" data-prw-card=${card.id}>
			<div class="text-[10px] font-semibold uppercase tracking-wide" style="color:var(--chart-1)">${card.phaseId}</div>
			<div class="text-base font-semibold text-foreground mt-1">${card.title}</div>
			${card.summary ? html`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${card.summary}</div>` : nothing}
			${card.rationale ? html`<div class="text-xs text-muted-foreground mt-1 leading-relaxed">${card.rationale}</div>` : nothing}
			${Array.isArray(card.sections) && card.sections.length
				? html`<div class="mt-1">${card.sections.map(renderSection)}</div>`
				: nothing}
			${Array.isArray(card.checklist) && card.checklist.length
				? html`<ul class="mt-2 pl-4 text-xs text-muted-foreground list-disc">${card.checklist.map((c) => html`<li>${c}</li>`)}</ul>`
				: nothing}
			${(card.diffBlocks ?? []).map(renderDiffBlock)}
			${Array.isArray(card.suggestedComments) && card.suggestedComments.length
				? html`<div class="mt-2"><div class="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested comments</div>${card.suggestedComments.map(renderSuggestedComment)}</div>`
				: nothing}
		</div>
	`;

	const renderNavRail = (entry, host, paramKey) => {
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
									const cur = byJob.get(paramKey) || entry;
									byJob.set(paramKey, { ...cur, activeCardId: card.id });
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

	const renderBundle = (entry, host, paramKey, displayJob) => {
		const b = entry.bundle;
		if (b && b.found === false) {
			return html`<div class="mt-3 text-xs text-muted-foreground" data-testid="prw-empty">
				No walkthrough has been persisted for <span class="font-mono">${displayJob}</span> yet.
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
					${renderNavRail(entry, host, paramKey)}
					<div class="flex-1 min-w-0 overflow-auto">
						${active ? renderCardBody(active) : html`<div class="text-xs text-muted-foreground" data-testid="prw-no-cards">This walkthrough has no cards.</div>`}
					</div>
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
						byJob.set(targetKey, { status: "error", error: `Walkthrough YAML invalid — ${detail}`, jobId });
						return;
					}
				}
				const query = { jobId };
				if (effBaseSha) query.baseSha = effBaseSha;
				if (effHeadSha) query.headSha = effHeadSha;
				const bundle = await host.callRoute("bundle", { query });
				const firstCard = Array.isArray(bundle && bundle.cards) && bundle.cards.length ? bundle.cards[0].id : undefined;
				byJob.set(targetKey, { status: "rendered", bundle, toolCall, activeCardId: firstCard, jobId });
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
						byJob.set(key, { status: "publishing", jobId });
						if (host.requestRender) host.requestRender();
						try {
							await publishAndLoad({ input: { yaml: st.yaml } }, st.baseSha, st.headSha, key);
						} catch (e) {
							byJob.set(key, { status: "error", error: msgOf(e), jobId });
						}
						if (host.requestRender) host.requestRender();
						return;
					}
					if (st && st.phase === "error") {
						byJob.set(key, { status: "error", error: st.error || "The reviewer failed — terminate the session and run again.", jobId });
						if (host.requestRender) host.requestRender();
						return;
					}
					// phase:"running" (or a transient fetch failure) — keep polling. Past
					// SLOW_HINT_MS record a slow flag (no copy change, no error: the child
					// is alive) so we never re-arm a second loop.
					if (Date.now() - startedAt > SLOW_HINT_MS) {
						const c = byJob.get(key);
						if (c && c.status === "running" && !c.slow) byJob.set(key, { ...c, slow: true });
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
					byJob.set(paramKey, { ...cur, status: "empty" });
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
					byJob.set(paramKey, { status: "publishing", jobId });
					if (host.requestRender) host.requestRender();
					try {
						await publishAndLoad({ input: { yaml: recovered.yaml } }, recovered.baseSha, recovered.headSha, paramKey);
					} catch (e) {
						byJob.set(paramKey, { status: "error", error: msgOf(e), jobId });
					}
					if (host.requestRender) host.requestRender();
					return;
				}
				// No submitted YAML yet → pending + self-drive the poll (single-flight).
				const c2 = byJob.get(paramKey) || {};
				if (c2.polling || c2.status === "rendered" || c2.bundle) return;
				byJob.set(paramKey, { ...c2, status: "running", polling: true, jobId });
				if (host.requestRender) host.requestRender();
				queueMicrotask(() => { void pollChild(paramKey, boundSessionId, jobId); });
			};

			// Kick the mount resolver ONCE per pane. The synchronous `mountKicked` flag
			// prevents a same-page re-render from re-entering while the async resolver
			// runs; a rendered/polling entry is never re-kicked.
			if (boundSessionId && !entry.mountKicked && !entry.bundle && status !== "rendered" && !entry.polling && status !== "empty") {
				byJob.set(paramKey, { ...entry, mountKicked: true });
				queueMicrotask(() => { void resolveChildMount(); });
			}

			// Pending = a reviewer child is producing the walkthrough. Shown while we
			// resolve the binding (idle, optimistic for a bound pane) and during the poll.
			const isPending = status === "running" || status === "publishing"
				|| (status === "idle" && Boolean(boundSessionId) && !entry.bundle);

			const spinner = html`<span data-testid="prw-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid var(--muted-foreground);border-top-color:transparent;border-radius:50%;animation:prw-spin 0.8s linear infinite;"></span>`;

			return html`
				<style>@keyframes prw-spin { to { transform: rotate(360deg); } }</style>
				<div class="p-3" data-testid="prw-panel-root" data-prw-job=${displayJob}>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold text-foreground">PR Walkthrough</span>
						<span class="text-xs text-muted-foreground font-mono">${displayJob}</span>
					</div>
					${entry.bundle
						? renderBundle(entry, host, paramKey, displayJob)
						: status === "error" && entry.error
							? html`<div class="mt-2 text-xs" style="color:var(--negative)" data-testid="prw-error">${entry.error}</div>`
							: isPending
								? html`<div class="mt-2 flex items-center gap-2 text-xs text-muted-foreground" data-testid="prw-pending">
										${spinner} PR Walkthrough: In Progress
									</div>`
								: html`<div class="mt-2 text-xs text-muted-foreground" data-testid="prw-neutral">
										No PR walkthrough is available in this session.
									</div>`}
				</div>
			`;
		},
	};
}
