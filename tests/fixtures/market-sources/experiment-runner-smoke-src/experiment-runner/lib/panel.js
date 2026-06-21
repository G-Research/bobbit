export default function createPanel({ html, nothing, renderHeader }) {
	const state = {
		experimentId: `e2e-smoke-${Date.now().toString(36)}`,
		parentGoalId: "",
		teamLeadSecret: "",
		title: "E2E Experiment Runner smoke",
		spec: "Minimal safe smoke-test arm. Do not edit files. Finish quickly with one sentence: Smoke arm complete.",
		metricsText: JSON.stringify([
			{ metricId: "command.metric", aggregation: "median" },
			{ metricId: "cost.totalUsd", aggregation: "median", directionOverride: "min" },
		], null, 2),
		dashboardText: JSON.stringify({ widgets: [{ id: "smoke-summary", type: "summary-cards", title: "Smoke summary", bind: { metricIds: ["command.metric", "cost.totalUsd"] } }] }, null, 2),
		status: "Ready to define a bounded A/B experiment.",
		defined: false,
		launched: [],
		report: null,
		loadedFor: "",
		loadingFor: "",
	};

	const rerender = (host) => { try { host?.requestRender?.(); } catch {} };
	const setStatus = (host, status) => { state.status = status; rerender(host); };
	const parseJson = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };
	const variants = () => [
		{
			armId: "baseline",
			label: "baseline",
			metadata: {
				experiment: { userMetrics: { metric: 1, smokeBaselineMarker: 101 } },
				smokeTreatment: { arm: "baseline", marker: "smoke-baseline-101" },
			},
		},
		{
			armId: "variant-b",
			label: "variant-b",
			metadata: {
				experiment: { userMetrics: { metric: 2, smokeVariantMarker: 202 } },
				smokeTreatment: { arm: "variant-b", marker: "smoke-variant-b-202" },
			},
		},
	];
	const definition = () => ({
		experimentId: state.experimentId,
		title: state.title,
		mode: "ab",
		parentGoalId: state.parentGoalId,
		teamLeadSecret: state.teamLeadSecret,
		runnable: { kind: "spec", spec: state.spec },
		variants: variants(),
		repeats: 1,
		maxConcurrency: 1,
		perRunBudget: 0.05,
		metrics: parseJson(state.metricsText, []),
		dashboard: parseJson(state.dashboardText, { widgets: [] }),
	});
	async function call(host, name, body = {}) {
		if (!host?.callRoute) throw new Error("host.callRoute unavailable");
		const result = await host.callRoute(name, { method: "POST", body });
		if (result?.error) throw new Error(`${name}: ${result.error}`);
		return result;
	}
	async function define(host) {
		setStatus(host, "Defining experiment…");
		try {
			const res = await call(host, "defineexperiment", definition());
			state.defined = true;
			state.status = `Definition ready: ${res.projection?.arms ?? 0} arms`;
		} catch (e) { state.status = e instanceof Error ? e.message : String(e); }
		rerender(host);
	}
	async function launch(host) {
		setStatus(host, "Launching child goals…");
		try {
			const res = await call(host, "launch", { experimentId: state.experimentId });
			state.launched = res.launched || [];
			state.status = `Launch complete: ${state.launched.length} child goals`;
		} catch (e) { state.status = e instanceof Error ? e.message : String(e); }
		rerender(host);
	}
	async function lifecycle(host, name) {
		setStatus(host, `${name}…`);
		try {
			const res = await call(host, name, { experimentId: state.experimentId });
			if (name === "report") state.report = res;
			state.status = `${name} complete`;
		} catch (e) { state.status = e instanceof Error ? e.message : String(e); }
		rerender(host);
	}
	async function saveMetrics(host) {
		setStatus(host, "Saving metric spec…");
		try { await call(host, "savemetrics", { experimentId: state.experimentId, metrics: parseJson(state.metricsText, []) }); state.status = "Metric spec saved"; }
		catch (e) { state.status = e instanceof Error ? e.message : String(e); }
		rerender(host);
	}
	async function saveDashboard(host) {
		setStatus(host, "Saving dashboard spec…");
		try { await call(host, "savedashboard", { experimentId: state.experimentId, dashboard: parseJson(state.dashboardText, { widgets: [] }) }); state.status = "Dashboard spec saved"; }
		catch (e) { state.status = e instanceof Error ? e.message : String(e); }
		rerender(host);
	}
	function loadIfNeeded(params, host) {
		const id = typeof params?.experimentId === "string" ? params.experimentId : "";
		if (!id || state.loadedFor === id || state.loadingFor === id || !host?.callRoute) return;
		state.loadingFor = id;
		host.callRoute("getexperiment", { method: "POST", body: { experimentId: id } })
			.then((exp) => {
				state.loadingFor = "";
				if (!exp || exp.error) return;
				state.loadedFor = id;
				state.experimentId = exp.experimentId || id;
				state.parentGoalId = exp.parentGoalId || state.parentGoalId;
				state.title = exp.title || state.title;
				state.spec = exp.runnable?.spec || state.spec;
				state.metricsText = JSON.stringify(exp.metrics || [], null, 2);
				state.dashboardText = JSON.stringify(exp.dashboard || { widgets: [] }, null, 2);
				state.launched = exp.runs || [];
				state.report = exp.report || state.report;
				state.status = `Loaded experiment ${state.experimentId}`;
				rerender(host);
			})
			.catch((e) => { state.loadingFor = ""; state.status = e instanceof Error ? e.message : String(e); rerender(host); });
	}
	const input = (testId, label, value, onInput, type = "text") => html`<label><span>${label}</span><input data-testid=${testId} type=${type} .value=${value} @input=${(e) => onInput(e.currentTarget.value)} /></label>`;
	return {
		render(params, host) {
			loadIfNeeded(params, host);
			const metricIds = parseJson(state.metricsText, []).map?.((m) => m.metricId).join(", ") || "";
			const widgetTitles = (parseJson(state.dashboardText, { widgets: [] }).widgets || []).map((w) => w.title || w.id).join(", ");
			return html`
				<style>
					.exp-root{display:flex;flex-direction:column;gap:12px;padding:12px;color:var(--foreground);background:var(--background)}
					.exp-card{border:1px solid var(--border);border-radius:12px;background:var(--card);padding:12px;display:flex;flex-direction:column;gap:10px}
					label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--muted-foreground)}
					input,textarea{border:1px solid var(--border);border-radius:8px;background:var(--background);color:var(--foreground);padding:8px;font:inherit}
					textarea{min-height:90px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
					.row{display:flex;gap:8px;flex-wrap:wrap}.primary{background:var(--primary);color:var(--primary-foreground);border:0}.secondary{background:transparent;color:var(--foreground);border:1px solid var(--border)}
					button{border-radius:8px;padding:8px 10px;cursor:pointer}.status{color:var(--muted-foreground)}.report{border-left:3px solid var(--primary);padding-left:10px}
				</style>
				<section class="exp-root" data-testid="experiment-runner-panel">
					${renderHeader ? renderHeader({ title: "Experiments" }) : html`<h2>Experiments</h2>`}
					<div class="exp-card">
						<strong>A/B comparison</strong>
						<p class="status">Autoresearch is opt-in and requires explicit hard caps before launch.</p>
						${input("exp-experiment-id", "Experiment ID", state.experimentId, (v) => state.experimentId = v)}
						${input("exp-parent-goal-id", "Parent goal ID", state.parentGoalId, (v) => state.parentGoalId = v)}
						${input("exp-session-secret", "Team-lead session secret", state.teamLeadSecret, (v) => state.teamLeadSecret = v, "password")}
						${input("exp-title", "Title", state.title, (v) => state.title = v)}
						<label><span>Task/spec</span><textarea data-testid="exp-task-spec" .value=${state.spec} @input=${(e) => state.spec = e.currentTarget.value}></textarea></label>
						<div data-testid="exp-variants">Variants: baseline marker smoke-baseline-101; variant-b marker smoke-variant-b-202</div>
						<div class="row"><button class="primary" data-testid="exp-define-button" type="button" @click=${() => define(host)}>Define experiment</button><button class="primary" data-testid="exp-launch-button" type="button" ?disabled=${!state.defined} @click=${() => launch(host)}>Confirm and launch</button></div>
					</div>
					<div class="exp-card">
						<strong>Metric/dashboard specs</strong>
						<label><span>Metrics JSON</span><textarea data-testid="exp-metrics-json" .value=${state.metricsText} @input=${(e) => state.metricsText = e.currentTarget.value}></textarea></label>
						<label><span>Dashboard JSON</span><textarea data-testid="exp-dashboard-json" .value=${state.dashboardText} @input=${(e) => state.dashboardText = e.currentTarget.value}></textarea></label>
						<div class="row"><button class="secondary" data-testid="exp-save-metrics" type="button" @click=${() => saveMetrics(host)}>Save metrics</button><button class="secondary" data-testid="exp-save-dashboard" type="button" @click=${() => saveDashboard(host)}>Save dashboard</button></div>
						<div data-testid="exp-saved-summary">Metrics: ${metricIds}; Widgets: ${widgetTitles}</div>
					</div>
					<div class="exp-card">
						<strong>Lifecycle</strong>
						<div class="row">${["poll", "collect", "aggregate", "report"].map((name) => html`<button class="secondary" data-testid=${name === "report" ? "exp-report-button" : `exp-${name}`} type="button" @click=${() => lifecycle(host, name)}>${name}</button>`)}</div>
						<div data-testid="exp-status" class="status">${state.status}</div>
						${state.launched.length ? html`<ul data-testid="exp-launched-goals">${state.launched.map((r) => html`<li>${r.armId}: ${r.goalId}</li>`)}</ul>` : nothing}
						${state.report ? html`<div class="report" data-testid="exp-report"><h3>Experiment Runner Smoke Report</h3><p>${state.report.model?.runs?.length || 0} runs</p><p>${widgetTitles}</p><p>${metricIds}</p><pre>${state.report.html}</pre></div>` : nothing}
					</div>
				</section>`;
		},
	};
}
