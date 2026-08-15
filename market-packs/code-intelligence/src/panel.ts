type Host = {
	callRoute?: (name: string, init?: { method?: string; query?: Record<string, string>; body?: unknown }) => Promise<unknown>;
	requestRender?: () => void;
};

type PanelState = {
	loaded: boolean;
	loading: boolean;
	rebuilding: boolean;
	status?: any;
	config?: any;
	error?: string;
};

type RecordValue = Record<string, any>;

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error || "Unable to load Code Intelligence status.");
}

function asRecord(value: unknown): RecordValue | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function recordList(value: unknown): RecordValue[] {
	return Array.isArray(value) ? value.filter((item): item is RecordValue => !!asRecord(item)) : [];
}

function components(value: unknown): RecordValue[] {
	const body = asRecord(value);
	if (!body) return [];
	for (const collection of [body.components, body.items, body.graphs]) {
		if (Array.isArray(collection)) return recordList(collection);
	}
	return body.component ? [body] : [];
}

function stateOf(status: RecordValue | undefined): string {
	return String(status?.state ?? status?.freshness ?? "unavailable").trim().toLowerCase();
}

function stateLabel(state: string): string {
	return state.replace(/-/g, " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

function componentLabel(status: RecordValue): string {
	const component = status.component;
	const componentRecord = asRecord(component);
	const name = String(componentRecord?.name ?? component ?? "Component");
	const repo = typeof componentRecord?.repo === "string" && componentRecord.repo.trim() ? componentRecord.repo : undefined;
	return repo ? `${name} · ${repo}` : name;
}

function revision(status: RecordValue, kind: "head" | "base" = "head"): string {
	const revisions = asRecord(status.revisions);
	const value = kind === "base"
		? revisions?.baseRev ?? status.baseRevision ?? status.baseRev ?? status.revision
		: revisions?.headRev ?? status.headRev ?? status.revision;
	return typeof value === "string" && value.trim() ? value.slice(0, 12) : "unknown";
}

function staleReason(status: RecordValue): string | undefined {
	return typeof status.staleReason === "string" && status.staleReason.trim()
		? status.staleReason.replace(/-/g, " ")
		: undefined;
}

function aggregateState(statuses: readonly RecordValue[]): string {
	if (statuses.length === 0) return "No graph published";
	const states = statuses.map(stateOf);
	if (states.some(state => state === "failed" || state === "stale")) return "Not current";
	if (states.includes("base-fallback")) return "Limited";
	if (states.includes("building")) return "Updating";
	if (states.every(state => state === "fresh")) return "Current";
	return "Not current";
}

function graphConsequence(status: RecordValue): string | undefined {
	const state = stateOf(status);
	if (state === "base-fallback") {
		return `Base fallback — this branch has no current graph. Queries use the accepted base graph at ${revision(status, "base")} and may omit branch-only changes.`;
	}
	if (state === "stale") {
		return staleReason(status) === "parent advanced"
			? `Stale — the parent changed. Showing the last accepted graph at ${revision(status)} until this branch is rebuilt.`
			: `Stale — showing the last accepted graph at ${revision(status)} until this branch is rebuilt.`;
	}
	return undefined;
}

function capabilityRows(status: unknown): RecordValue[] {
	const body = asRecord(status);
	if (!body) return [];
	for (const collection of [body.capabilities, body.languageCapabilities, body.languages]) {
		if (Array.isArray(collection)) return recordList(collection);
	}
	return components(body).flatMap(component => {
		for (const collection of [component.capabilities, component.languageCapabilities, component.languages]) {
			if (Array.isArray(collection)) return recordList(collection).map(row => ({ ...row, component: row.component ?? component.component ?? component.name }));
		}
		return [];
	});
}

function languageLabel(capability: RecordValue): string {
	const language = asRecord(capability.language);
	const label = capability.label ?? capability.languageLabel ?? language?.label ?? capability.languageId ?? language?.id;
	return typeof label === "string" && label.trim() ? label : "Declared language";
}

function evidenceText(capability: RecordValue): string | undefined {
	const evidence = asRecord(capability.evidence ?? capability.detection?.evidence);
	if (!evidence) return undefined;
	const details: string[] = [];
	if (typeof evidence.fileCount === "number") details.push(`${evidence.fileCount} ${evidence.fileCount === 1 ? "file" : "files"}`);
	const namedMarkers = Array.isArray(evidence.rootMarkers) ? evidence.rootMarkers.filter((item): item is string => typeof item === "string" && item.trim()) : [];
	if (namedMarkers.length) details.push(namedMarkers.join(", "));
	return details.length ? `Detected from ${details.join(" · ")}` : undefined;
}

function structuralText(capability: RecordValue): string {
	const structural = capability.structuralSearch;
	const state = typeof structural === "string" ? structural : asRecord(structural)?.state;
	if (state === "available" || state === "supported") return "Supported — syntax-aware, not type-aware";
	return "Unavailable";
}

function lspDetails(capability: RecordValue): { label: string; reason?: string; actions?: string } {
	const lsp = asRecord(capability.lsp) ?? {};
	const state = String(lsp.state ?? capability.lspState ?? "unavailable").toLowerCase();
	const labels: Record<string, string> = {
		disabled: "Disabled",
		"requires-toolchain": "Needs runtime",
		ready: "Ready",
		unavailable: "Unavailable",
		unsupported: "Structural search only",
	};
	const reason = typeof lsp.reason === "string" && lsp.reason.trim() ? lsp.reason : requirementText(lsp);
	const actions = Array.isArray(lsp.actions) ? lsp.actions.filter((item): item is string => typeof item === "string" && item.trim()).join(", ") : undefined;
	return { label: labels[state] ?? "Unavailable", reason, actions };
}

function requirementText(lsp: RecordValue): string | undefined {
	const requirements = Array.isArray(lsp.missing) && lsp.missing.length ? lsp.missing : lsp.requirements;
	if (!Array.isArray(requirements) || requirements.length === 0) return undefined;
	const names = requirements.map(item => {
		const record = asRecord(item);
		return typeof record?.label === "string" ? record.label : typeof record?.id === "string" ? record.id : undefined;
	}).filter((item): item is string => !!item);
	return names.length ? `Requires ${names.join(", ")}.` : undefined;
}

function manualRebuild(status: unknown, config: unknown): RecordValue | undefined {
	const source = asRecord(status);
	const statusConfig = asRecord(source?.config);
	return asRecord(source?.manualRebuild) ?? asRecord(statusConfig?.manualRebuild) ?? asRecord(asRecord(config)?.manualRebuild);
}

function rebuildAvailability(rebuild: RecordValue | undefined): { available: boolean; reason: string } {
	if (rebuild?.available === true) return { available: true, reason: "" };
	const reason = typeof rebuild?.reason === "string" && rebuild.reason.trim()
		? rebuild.reason
		: "Manual rebuild availability is not declared.";
	return { available: false, reason };
}

/** This pull-only panel renders only route-declared status/configuration data.
 * Mounting and reload never start Graphify or an LSP service. */
export default function createCodeIntelligencePanel({ html, nothing }: any) {
	void nothing;
	const bySession = new Map<string, PanelState>();
	const repaint = (host: Host) => { try { host.requestRender?.(); } catch { /* isolated rendering */ } };

	return {
		render(params: Record<string, unknown> | undefined, host: Host | undefined) {
			const key = typeof params?.__sessionId === "string" ? params.__sessionId : "default";
			const state = bySession.get(key) ?? { loaded: false, loading: false, rebuilding: false };
			bySession.set(key, state);
			const invoke = async (route: "status" | "config" | "rebuild") => {
				if (!host?.callRoute) {
					state.error = "Code Intelligence routes are unavailable.";
					repaint(host ?? {});
					return;
				}
				try {
					if (route === "rebuild") state.rebuilding = true;
					else state.loading = true;
					state.error = undefined;
					repaint(host);
					const response = await host.callRoute(route, route === "rebuild" ? { method: "POST", body: { scope: "eligible" } } : { method: "GET" });
					const failure = asRecord(response)?.ok === false;
					if (failure) throw new Error(typeof asRecord(response)?.error === "string" ? asRecord(response)?.error : "Code Intelligence route request failed.");
					if (route === "status") state.status = response;
					if (route === "config") state.config = response;
					if (route === "rebuild") {
						const rebuild = asRecord(response) ?? {};
						state.status = rebuild.status ?? response;
					}
					state.loaded = true;
				} catch (error) {
					state.error = message(error);
				} finally {
					state.loading = false;
					state.rebuilding = false;
					repaint(host);
				}
			};
			const statuses = components(state.status);
			const capabilities = capabilityRows(state.status);
			const availability = rebuildAvailability(manualRebuild(state.status, state.config));
			const busy = state.loading || state.rebuilding;
			const summary = state.loading ? "Checking language support…" : state.rebuilding ? "Checking manual rebuild availability…" : aggregateState(statuses);
			return html`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel" aria-busy=${busy ? "true" : "false"}>
					<header>
						<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
						<p class="text-muted-foreground">Declared, component-scoped capabilities. Loading status does not start indexing or an LSP.</p>
					</header>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness" role="status" aria-live="polite" aria-atomic="true">${summary}</p>
					<div class="flex flex-wrap gap-2" aria-label="Code Intelligence panel actions">
						<button type="button" class="min-h-6 min-w-6 rounded border border-border px-2 py-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" data-testid=${state.loaded ? "graph-status-refresh" : "graph-status-load"} ?disabled=${busy} aria-busy=${state.loading ? "true" : "false"} @click=${() => void invoke("status")}>${state.loading ? "Checking language support…" : state.loaded ? "Refresh" : "Load status"}</button>
						<button type="button" class="min-h-6 min-w-6 rounded border border-border px-2 py-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" data-testid="graph-status-config" ?disabled=${busy} aria-busy=${state.loading ? "true" : "false"} @click=${() => void invoke("config")}>Configuration</button>
						<button type="button" class="min-h-6 min-w-6 rounded px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${availability.available ? "bg-primary text-primary-foreground" : "border border-border text-foreground"}" data-testid="code-intelligence-rebuild" ?disabled=${busy || !availability.available} aria-busy=${state.rebuilding ? "true" : "false"} @click=${() => void invoke("rebuild")}>${state.rebuilding ? "Checking…" : availability.available ? "Rebuild index" : "Rebuild unavailable"}</button>
					</div>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${state.rebuilding ? "Checking manual rebuild availability…" : availability.available ? "Manual rebuild is available through this route." : availability.reason}</p>
					${state.error ? html`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${state.error}</p>` : nothing}
					${!state.loaded ? html`<p class="text-muted-foreground">Load status to inspect declared language support, graph freshness, and rebuild availability.</p>` : nothing}

					<section class="space-y-2" aria-labelledby="code-intelligence-capabilities">
						<h3 id="code-intelligence-capabilities" class="font-semibold text-foreground">Capabilities</h3>
						${capabilities.map(capability => {
							const lsp = lspDetails(capability);
							const evidence = evidenceText(capability);
							const truncated = asRecord(capability.evidence ?? capability.detection?.evidence)?.truncated === true;
							return html`<article class="rounded border border-border p-3 space-y-1" data-testid="code-intelligence-language-row">
								<h4 class="font-medium text-foreground" data-testid="code-intelligence-language-label">${languageLabel(capability)}</h4>
								${evidence ? html`<p class="text-muted-foreground" data-testid="code-intelligence-language-evidence">${evidence}</p>` : nothing}
								${truncated ? html`<p class="text-warning" data-testid="code-intelligence-detection-truncated">Scan incomplete — the 10,000-entry limit was reached; some languages may be missing.</p>` : nothing}
								<p><strong>Structural search</strong> <span data-testid="code-intelligence-structural-state">${structuralText(capability)}</span></p>
								<p><strong>LSP</strong> <span data-testid="code-intelligence-lsp-state">${lsp.label}</span></p>
								${lsp.reason ? html`<p class="text-muted-foreground" data-testid="code-intelligence-lsp-reason">${lsp.reason}</p>` : nothing}
								${lsp.label === "Ready" && lsp.actions ? html`<p class="text-muted-foreground">Actions: ${lsp.actions}</p>` : nothing}
							</article>`;
						})}
						${state.loaded && capabilities.length === 0 ? html`<p class="text-muted-foreground" data-testid="code-intelligence-capabilities-empty">No declared language capabilities are available for this session.</p>` : nothing}
					</section>

					<section class="space-y-2" aria-labelledby="code-intelligence-graph-index">
						<h3 id="code-intelligence-graph-index" class="font-semibold text-foreground">Graph index</h3>
						${statuses.map(status => html`
							<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
								<strong class="text-foreground" data-testid="graph-status-component-label">${componentLabel(status)}</strong>
								<p class="font-mono text-xs text-muted-foreground" data-testid="graph-status-component-revision">Revision: ${revision(status)}</p>
								<p class="font-medium text-foreground" data-testid="graph-status-state">${stateLabel(stateOf(status))}</p>
								${staleReason(status) ? html`<p class="text-muted-foreground" data-testid="graph-status-stale-reason">Reason: ${staleReason(status)}</p>` : nothing}
								${graphConsequence(status) ? html`<p class="text-muted-foreground" data-testid="graph-status-consequence">${graphConsequence(status)}</p>` : nothing}
							</article>
						`)}
						${state.loaded && statuses.length === 0 ? html`<p class="text-muted-foreground" data-testid="graph-status-empty">No component graph status is available yet.</p>` : nothing}
					</section>

					<section class="space-y-2" aria-labelledby="code-intelligence-boundaries">
						<h3 id="code-intelligence-boundaries" class="font-semibold text-foreground">Boundaries and review guidance</h3>
						<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning" role="note" aria-label="Repository boundary"><strong>Repository boundary:</strong> v1 has no cross-repo edges. A result in web cannot prove a call into api.</p>
						<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-review-guidance">Graph relationships are breadth-first leads; LSP locations are precise within the active worktree. Open and read every cited source before changing or approving code.</p>
					</section>
					${state.config ? html`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(state.config, null, 2)}</pre>` : nothing}
				</section>
			`;
		},
	};
}
