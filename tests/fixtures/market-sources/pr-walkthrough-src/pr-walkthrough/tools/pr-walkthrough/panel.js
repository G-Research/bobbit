// Pack CLIENT panel module — Extension Host Phase-2 D2 litmus (the maximal pack).
//
// Pre-built ESM module served by the bearer-only panel endpoint and lazy-imported
// (Blob URL) by the client pack-panels registry. The default factory is handed the
// host's OWN lit toolkit (so the pack shares the app's single lit instance + the
// standard header shape) and each render() is handed the per-session Host API
// (getHostApi(sessionId, undefined, packTool); design extension-host-phase2 §2a.2).
//
// Re-expresses src/ui/components/pr-walkthrough/PrWalkthroughPanel.ts as a pack
// viewer. ALL dynamic data flows through the Host API — NEVER a raw fetch:
//   - host.callRoute("bundle", { query:{ jobId } })  → the pack's OWN route module
//     (re-expressing the bespoke changeset/diff bundle endpoint, store-backed).
//   - host.session.readToolCall(toolUseId)            → reads the
//     submit_pr_walkthrough_yaml tool call (own-session) instead of bespoke
//     transcript access.
//
// SECURITY: NO auto-invoke on mount (v1 §5 v). The bundle/tool-call reads fire ONLY
// from the user's "Load walkthrough" click (the gesture). Theme tokens only; the
// content is structured data rendered via the escaping lit toolkit (no raw-HTML /
// unsafeHTML injection surface — the iframe-sandbox convention is preserved).

export default function createPanel({ html, nothing, renderHeader }) {
	// Keep the toolkit's header helper referenced (contract clarity) even though
	// this panel draws a compact header of its own.
	void renderHeader;

	// jobId → { bundle?, toolCall?, error? }. Module-level so it survives panel
	// re-mounts within a page session (a deep-link re-open paints instantly); a full
	// reload clears it, so the next Load re-reads the SAME persisted store record.
	const byJob = new Map();
	const loadingJobs = new Set();

	const lineStyle = (kind) =>
		kind === "add"
			? "background:color-mix(in oklch, var(--positive) 16%, transparent);color:var(--foreground);"
			: kind === "del"
				? "background:color-mix(in oklch, var(--negative) 16%, transparent);color:var(--foreground);"
				: "color:var(--muted-foreground);";
	const linePrefix = (kind) => (kind === "add" ? "+" : kind === "del" ? "-" : " ");

	const renderDiffBlock = (block) => html`
		<div class="mt-2 rounded border border-border overflow-hidden" data-testid="prw-diffblock" data-prw-file=${block.filePath}>
			<div class="px-2 py-1 text-xs font-mono bg-muted/40 text-foreground border-b border-border">
				${block.status ?? "modified"} ${block.filePath}
			</div>
			${(block.hunks ?? []).map(
				(hunk) => html`
					<div class="px-2 py-0.5 text-xs font-mono text-muted-foreground">${hunk.header}</div>
					${(hunk.lines ?? []).map(
						(ln) => html`<div class="px-2 font-mono text-xs whitespace-pre" style=${lineStyle(ln.kind)}>${linePrefix(ln.kind)}${ln.text}</div>`,
					)}
				`,
			)}
		</div>
	`;

	const renderCard = (card) => html`
		<div class="mt-3 rounded border border-border bg-card p-2" data-testid="prw-card" data-prw-card=${card.id}>
			<div class="text-sm font-medium text-foreground">${card.title}</div>
			<div class="text-xs text-muted-foreground mt-0.5">${card.summary}</div>
			${(card.diffBlocks ?? []).map(renderDiffBlock)}
		</div>
	`;

	const renderBundle = (entry) => {
		const b = entry.bundle;
		const cs = b.changeset ?? {};
		const yaml = entry.toolCall && entry.toolCall.input && typeof entry.toolCall.input.yaml === "string"
			? entry.toolCall.input.yaml
			: undefined;
		return html`
			<div data-testid="prw-bundle">
				<div class="text-sm font-semibold text-foreground" data-testid="prw-title">${cs.title ?? "Walkthrough"}</div>
				<div class="text-xs text-muted-foreground">
					${cs.baseSha}…${cs.headSha}
					· ${cs.filesChanged ?? 0} file(s)
					· <span style="color:var(--positive)">+${cs.additions ?? 0}</span>
					· <span style="color:var(--negative)">-${cs.deletions ?? 0}</span>
				</div>
				<div class="text-[10px] text-muted-foreground mt-1">
					persisted: <span data-testid="prw-persisted-at">${String(b.persistedAt ?? "")}</span>
				</div>
				<div class="text-[10px] text-muted-foreground" data-testid="prw-toolcall">
					submit yaml: ${yaml ? yaml.slice(0, 80) : "(none)"}
				</div>
				${(b.cards ?? []).map(renderCard)}
			</div>
		`;
	};

	return {
		// PURE projection of the typed params onto a lit value. NO host call here —
		// the load is the user's gesture (the Load button below), never mount.
		render(params, host) {
			const jobId = (params && params.jobId) || "job-litmus-1";
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
					// Dynamic data via the pack's OWN route — NEVER a raw fetch.
					const bundle = await host.callRoute("bundle", { query: { jobId } });
					byJob.set(jobId, { bundle, toolCall });
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
					${entry && entry.bundle ? renderBundle(entry) : nothing}
				</div>
			`;
		},
	};
}
