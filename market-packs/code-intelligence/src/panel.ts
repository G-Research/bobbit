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

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error || "Unable to load graph status.");
}

function records(value: unknown): Record<string, any>[] {
	if (Array.isArray(value)) return value.filter((item): item is Record<string, any> => !!item && typeof item === "object");
	if (!value || typeof value !== "object") return [];
	const body = value as Record<string, any>;
	// Route responses are envelopes: their state describes the fan-out, not a
	// component. Always unwrap a declared collection before considering a record.
	for (const collection of [body.components, body.items, body.graphs]) {
		if (Array.isArray(collection)) return records(collection);
	}
	return body.component ? [body] : [];
}

function stateOf(status: any): string {
	return String(status?.state ?? status?.freshness ?? "UNAVAILABLE").replace(/-/g, " ").toUpperCase();
}

function warningOf(status: any): string | undefined {
	const warnings = Array.isArray(status?.warnings) ? status.warnings : [];
	const first = warnings.find((item: unknown) => typeof item === "string" && item.trim());
	return typeof first === "string" ? first : undefined;
}

function componentLabel(status: any): string {
	const component = status?.component;
	const name = String(component?.name ?? component ?? "Component");
	const repo = typeof component?.repo === "string" && component.repo.trim() ? component.repo : undefined;
	return repo ? `${name} · ${repo}` : name;
}

function revision(status: any): string {
	const revisions = status?.revisions ?? {};
	return String(revisions.headRev ?? revisions.baseRev ?? status?.revision ?? "unknown").slice(0, 12);
}

function staleReason(status: any): string | undefined {
	return typeof status?.staleReason === "string" && status.staleReason.trim()
		? status.staleReason.replace(/-/g, " ")
		: undefined;
}

/** Status panel is deliberately pull-only: mounting never starts an index build.
 * `Load status` and `Refresh` use the declared read route; manual rebuild is a
 * direct bounded route call and explicitly reports its EP-8 availability. */
export default function createCodeIntelligencePanel({ html, nothing }: any) {
	void nothing;
	const bySession = new Map<string, PanelState>();
	const repaint = (host: Host) => { try { host.requestRender?.(); } catch { /* no host during isolated rendering */ } };

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
					const failure = response && typeof response === "object" && (response as Record<string, unknown>).ok === false;
					if (failure) {
						const error = (response as Record<string, unknown>).error;
						throw new Error(typeof error === "string" && error ? error : "Code Intelligence route request failed.");
					}
					if (route === "status") state.status = response;
					if (route === "config") state.config = response;
					if (route === "rebuild") {
						const rebuild = response && typeof response === "object" ? response as Record<string, unknown> : {};
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
			const statuses = records(state.status);
			const globalWarning = "v1 has no cross-repo edges.";
			const freshness = statuses.length > 0 ? stateOf(statuses[0]) : "STALE — no current graph is published.";
			return html`
				<section class="h-full overflow-auto p-4 space-y-4 text-sm" data-testid="code-intelligence-status-panel">
					<header class="flex items-start justify-between gap-3">
						<div>
							<h2 class="text-base font-semibold text-foreground">Code Intelligence</h2>
							<p class="text-muted-foreground">Host-side, component-scoped Graphify indexes.</p>
						</div>
						<div class="flex gap-2">
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid=${state.loaded ? "graph-status-refresh" : "graph-status-load"} ?disabled=${state.loading} @click=${() => void invoke("status")}>${state.loading ? "Loading…" : state.loaded ? "Refresh" : "Load status"}</button>
							<button class="rounded border border-border px-2 py-1 text-foreground hover:bg-muted disabled:opacity-50" data-testid="graph-status-config" ?disabled=${state.loading} @click=${() => void invoke("config")}>Configuration</button>
							<button class="rounded bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" data-testid="code-intelligence-rebuild" ?disabled=${state.rebuilding} @click=${() => void invoke("rebuild")}>${state.rebuilding ? "Checking…" : "Rebuild"}</button>
						</div>
					</header>
					<p class="rounded border border-border p-2 text-muted-foreground" data-testid="code-intelligence-no-cross-repo-warning">${globalWarning}</p>
					<p class="rounded border border-border p-2 font-medium text-foreground" data-testid="code-intelligence-freshness">${freshness}</p>
					<p class="text-muted-foreground" data-testid="code-intelligence-rebuild-status">${state.rebuilding ? "Checking manual rebuild availability…" : "Automatic lifecycle processing is unavailable pending EP-8. Manual rebuild is route-only."}</p>
					${state.error ? html`<p class="rounded border border-destructive p-2 text-destructive" role="alert">${state.error}</p>` : nothing}
					${!state.loaded ? html`<p class="text-muted-foreground">Load status to inspect freshness, lifecycle availability, and version drift.</p>` : nothing}
					${statuses.map((status) => html`
						<article class="rounded border border-border p-3 space-y-2" data-testid="graph-status-component">
							<strong class="text-foreground" data-testid="graph-status-component-label">${componentLabel(status)}</strong>
							<p class="font-mono text-xs text-muted-foreground" data-testid="graph-status-component-revision">Revision: ${revision(status)}</p>
							<p class="font-medium text-foreground" data-testid="graph-status-state">${stateOf(status)}</p>
							${staleReason(status) ? html`<p class="text-muted-foreground" data-testid="graph-status-stale-reason">Stale reason: ${staleReason(status)}</p>` : nothing}
							${warningOf(status) ? html`<p class="text-warning" data-testid="graph-status-component-warning">${warningOf(status)}</p>` : nothing}
						</article>
					`)}
					${state.loaded && statuses.length === 0 ? html`<p class="text-muted-foreground" data-testid="graph-status-empty">No component graph status is available yet.</p>` : nothing}
					${state.config ? html`<pre class="overflow-auto rounded border border-border p-3 text-xs text-muted-foreground" data-testid="graph-status-config-value">${JSON.stringify(state.config, null, 2)}</pre>` : nothing}
				</section>
			`;
		},
	};
}
