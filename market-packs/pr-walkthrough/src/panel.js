// Pack CLIENT panel module — the first-party pr-walkthrough viewer (design
// built-in-first-party-packs.md §8.4). Re-expresses the deleted built-in
// PrWalkthroughPanel as a pack viewer with PARITY on the load-bearing surfaces:
// the changeset header, the phase NAV RAIL (orientation → design → significant →
// other → audit), and the active card (summary, rationale, diff blocks, suggested
// comments, orientation beats). ALL dynamic data flows through the Host API — NEVER
// a raw fetch:
//   - host.callRoute("bundle", …)  → the pack's OWN route, which RECOMPUTES the REAL
//     changeset LIVE via git in the confined worker and READS any persisted cards.
//   - host.callRoute("publish", { yaml, jobId, baseSha, headSha }) → the pack route
//     runs the SAME production YAML→cards synthesis as the deleted built-in and
//     persists the result (the read→publish parity seam).
//   - host.session.readTranscript / readToolCall → reads the unchanged
//     submit_pr_walkthrough_yaml tool call (own-session).
//   - host.session.postMessage → the "Run PR walkthrough" launch gesture drives the
//     CURRENT agent to run the walkthrough tools (re-expresses the deleted git-widget
//     "launch a child agent" privilege without minting a new principal).
//
// PRODUCTION-FAITHFUL: the panel hands the RAW submitted YAML (the rich production
// `pr` + `walkthrough.{…}` document) to `publish`; the route validates + maps it via
// the bundled shared synthesis. The panel derives the REAL jobId/changeset from the
// doc's `pr` (changesetIdForGithub) — no `job-litmus-1` literal.
//
// SECURITY: NO auto-invoke on mount (v1 §5 v). Reads/publish fire ONLY from the
// user's "Load" click; postMessage fires ONLY from the "Run" click (gesture-gated).
// Theme tokens only; structured data rendered via the escaping lit toolkit.

import { parse as parseYaml } from "yaml";

import { changesetIdForGithub } from "../../../src/shared/pr-walkthrough/ids.ts";

const SUBMIT_TOOL = "submit_pr_walkthrough_yaml";
const RUN_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_500;

// The text the "Run PR walkthrough" gesture posts to the CURRENT agent. The agent
// already has readonly_bash / read_pr_walkthrough_bundle / submit_pr_walkthrough_yaml
// (the kept agent toolchain) and emits the production YAML, which the panel then
// reads → publishes → renders.
const RUN_PROMPT = [
	"Please run a PR walkthrough for the current branch.",
	"Use readonly_bash to inspect the diff, read_pr_walkthrough_bundle to assemble the changeset,",
	"then call submit_pr_walkthrough_yaml with the production walkthrough YAML.",
].join(" ");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Phase ordering + labels mirror the deleted PrWalkthroughPanel PHASES so the nav
// rail groups the synthesized cards exactly as the built-in walkthrough did.
const PHASES = [
	{ id: "orientation", label: "Orientation" },
	{ id: "design", label: "Key design choices" },
	{ id: "significant", label: "Significant changes" },
	{ id: "other", label: "Other + omissions" },
	{ id: "audit", label: "Audit" },
];

// Raw YAML text from the submit_pr_walkthrough_yaml tool call (the rich production
// document). Returns undefined when the call is absent/unparseable.
function rawYamlOf(toolCall) {
	return toolCall && toolCall.input && typeof toolCall.input.yaml === "string" ? toolCall.input.yaml : undefined;
}

// Derive the REAL job REFERENCE from the submitted production doc's `pr` (no
// litmus literal): the jobId AND the base/head SHAs the LIVE recompute needs.
// The shipped launchers navigate to a BARE `#/ext/pr-walkthrough` (no SHA URL
// params, by design), so the SHAs MUST come from the submitted YAML's `pr` block
// (`pr.base_sha`/`pr.head_sha`) — without them `publish` stores a pointer with
// undefined SHAs and `bundle` returns `{ found: false }` (the empty state). The
// jobId falls back to the panel param's jobId, else a neutral label.
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

// Map a postMessage failure onto a clear, user-facing message (the §8.4 failure
// model): a missing user gesture, a session that lacks the submit tool in
// allowedTools (server allowedTools gate), or no pack-served session surface.
function postErrorMessage(e) {
	const msg = (e && e.message) ? String(e.message) : String(e);
	if (/gesture/i.test(msg)) return "Please click Run again (a user gesture is required).";
	if (/allowed|not permitted|forbidden|tool/i.test(msg)) return "This session can't run a walkthrough (the agent lacks the walkthrough tools).";
	if (/pack-served|session/i.test(msg)) return "No active session — open this from a session to run a walkthrough.";
	return `Could not ask the agent: ${msg}`;
}

export default function createPanel({ html, nothing, renderHeader }) {
	void renderHeader;

	// paramKey → { status, bundle?, toolCall?, error?, activeCardId?, jobId? }.
	// status ∈ idle | loading | posting | waiting | publishing | rendered | error.
	// Module-level so it survives panel re-mounts within a page session.
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
				No walkthrough has been submitted for <span class="font-mono">${displayJob}</span> yet. Use “Run PR walkthrough” so the agent submits and persists one.
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
			// PER-SESSION state key. The module-level `byJob` map outlives a single
			// session (panels are a single page-lived instance), so keying by a shared
			// constant leaks session A's rendered bundle into session B (and suppresses
			// B's Load/Run). The render layer injects the BOUND session id (`__sessionId`)
			// so each session gets its OWN entry; a bare launcher (no jobId) in a
			// different session never sees another session's cache and always offers
			// Load/Run for its own submission. Falls back to the deep-link jobId, then a
			// neutral constant (non-DOM/unit fixtures with no bound session).
			const boundSessionId = params && params.__sessionId;
			const paramKey = boundSessionId || paramJobId || "__session__";
			const baseSha = params && params.baseSha;
			const headSha = params && params.headSha;
			const entry = byJob.get(paramKey) || { status: "idle" };
			const status = entry.status || "idle";
			const busy = status === "loading" || status === "posting" || status === "waiting" || status === "publishing";
			const hasSession = Boolean(host && host.capabilities && host.capabilities.session);
			const displayJob = entry.jobId || paramJobId || "current session";

			// ── read→publish→render seam (the user's Load gesture). Reads the unchanged
			// submit_pr_walkthrough_yaml tool call, hands the RAW yaml to `publish` (which
			// runs the production synthesis + persists), then reads the live `bundle`. ──
			const readSubmittedToolCall = async () => {
				if (!hasSession) return null;
				try {
					const env = await host.session.readTranscript({ pattern: SUBMIT_TOOL, limit: 100 });
					let submitId;
					for (const m of (env.messages || [])) {
						for (const blk of (m.content || [])) {
							if (blk.type === "tool_use" && blk.tool === SUBMIT_TOOL) submitId = blk.toolUseId;
						}
					}
					if (submitId) return await host.session.readToolCall(submitId);
				} catch { /* enrichment is non-fatal */ }
				return null;
			};

			const publishAndLoad = async (toolCall) => {
				const yamlText = rawYamlOf(toolCall);
				const ref = deriveJobRef(yamlText, paramJobId);
				const jobId = ref.jobId;
				// SHAs for the LIVE recompute: PREFER the submitted YAML's pr.base_sha/
				// head_sha (the bare-launcher path carries NO URL params); fall back to the
				// deep-link params only when the YAML lacks them. Without these, `publish`
				// stores a pointer with undefined SHAs and `bundle` returns the empty state.
				const effBaseSha = ref.baseSha || baseSha;
				const effHeadSha = ref.headSha || headSha;
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
						byJob.set(paramKey, { status: "error", error: `Walkthrough YAML invalid — ${detail}`, jobId });
						return;
					}
				}
				const query = { jobId };
				if (effBaseSha) query.baseSha = effBaseSha;
				if (effHeadSha) query.headSha = effHeadSha;
				const bundle = await host.callRoute("bundle", { query });
				const firstCard = Array.isArray(bundle && bundle.cards) && bundle.cards.length ? bundle.cards[0].id : undefined;
				byJob.set(paramKey, { status: "rendered", bundle, toolCall, activeCardId: firstCard, jobId });
			};

			const onLoad = async () => {
				if (!host || busy) return;
				byJob.set(paramKey, { status: "loading" });
				if (host.requestRender) host.requestRender();
				try {
					const toolCall = await readSubmittedToolCall();
					await publishAndLoad(toolCall);
				} catch (e) {
					byJob.set(paramKey, { status: "error", error: e && e.message ? e.message : String(e) });
				} finally {
					if (host.requestRender) host.requestRender();
				}
			};

			// ── "Run PR walkthrough" launch gesture (§8.4 step 5). postMessage MUST be the
			// first await-free call so the synchronous user-activation check passes. ──
			const onRun = () => {
				if (!host || !hasSession || busy) return; // duplicate-click guard
				let postPromise;
				try {
					byJob.set(paramKey, { status: "posting" });
					postPromise = host.session.postMessage({ role: "user", text: RUN_PROMPT, resumeTurn: true });
				} catch (e) {
					byJob.set(paramKey, { status: "error", error: postErrorMessage(e) });
					if (host.requestRender) host.requestRender();
					return;
				}
				if (host.requestRender) host.requestRender();
				(async () => {
					try {
						await postPromise;
					} catch (e) {
						byJob.set(paramKey, { status: "error", error: postErrorMessage(e) });
						if (host.requestRender) host.requestRender();
						return;
					}
					// Snapshot the submit tool calls present at post time so we only react to
					// a NEW one the agent produces (not a stale prior submission).
					const beforeIds = new Set();
					try {
						const env = await host.session.readTranscript({ pattern: SUBMIT_TOOL, limit: 100 });
						for (const m of (env.messages || [])) {
							for (const blk of (m.content || [])) {
								if (blk.type === "tool_use" && blk.tool === SUBMIT_TOOL) beforeIds.add(blk.toolUseId);
							}
						}
					} catch { /* best-effort */ }
					byJob.set(paramKey, { status: "waiting" });
					if (host.requestRender) host.requestRender();

					const deadline = Date.now() + RUN_TIMEOUT_MS;
					let newCall = null;
					while (Date.now() < deadline) {
						const st = byJob.get(paramKey);
						if (!st || st.status !== "waiting") return; // user took another action
						try {
							const env = await host.session.readTranscript({ pattern: SUBMIT_TOOL, limit: 100 });
							let submitId;
							for (const m of (env.messages || [])) {
								for (const blk of (m.content || [])) {
									if (blk.type === "tool_use" && blk.tool === SUBMIT_TOOL && !beforeIds.has(blk.toolUseId)) submitId = blk.toolUseId;
								}
							}
							if (submitId) { newCall = await host.session.readToolCall(submitId); break; }
						} catch { /* keep polling */ }
						await sleep(POLL_INTERVAL_MS);
					}
					if (!newCall) {
						byJob.set(paramKey, { status: "error", error: "The agent didn't produce a walkthrough — try again." });
						if (host.requestRender) host.requestRender();
						return;
					}
					byJob.set(paramKey, { status: "publishing" });
					if (host.requestRender) host.requestRender();
					try {
						await publishAndLoad(newCall);
					} catch (e) {
						byJob.set(paramKey, { status: "error", error: e && e.message ? e.message : String(e) });
					}
					if (host.requestRender) host.requestRender();
				})();
			};

			const statusText = status === "loading" ? "Loading…"
				: status === "posting" ? "Asking the agent…"
					: status === "waiting" ? "Waiting for the agent to submit a walkthrough…"
						: status === "publishing" ? "Publishing the walkthrough…"
							: undefined;

			const showActions = !entry.bundle && !busy;

			return html`
				<div class="p-3" data-testid="prw-panel-root" data-prw-job=${displayJob}>
					<div class="flex items-center justify-between gap-2">
						<span class="text-sm font-semibold text-foreground">PR Walkthrough</span>
						<span class="text-xs text-muted-foreground font-mono">${displayJob}</span>
					</div>
					${showActions
						? html`<div class="mt-2 flex gap-2">
								<button
									class="text-xs px-2 py-1 rounded border border-border bg-transparent text-foreground hover:bg-muted/50"
									data-testid="prw-load"
									@click=${onLoad}
								>Load walkthrough</button>
								${hasSession
									? html`<button
											class="text-xs px-2 py-1 rounded border border-border text-foreground hover:bg-muted/50"
											style="background:color-mix(in oklch, var(--primary) 12%, transparent);"
											data-testid="prw-run"
											@click=${onRun}
										>Run PR walkthrough</button>`
									: nothing}
							</div>`
						: nothing}
					${statusText ? html`<div class="mt-2 text-xs text-muted-foreground" data-testid="prw-run-status">${statusText}</div>` : nothing}
					${status === "error" && entry.error
						? html`<div class="mt-2 text-xs" style="color:var(--negative)" data-testid="prw-error">${entry.error}</div>`
						: nothing}
					${entry.bundle ? renderBundle(entry, host, paramKey, displayJob) : nothing}
				</div>
			`;
		},
	};
}
