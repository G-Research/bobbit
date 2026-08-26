// Extension-neutral fixture for the granular v7 Host project-read contract.
// The panel first loads its own pack route, then asks the Host only for the
// referenced records. Project notifications are invalidations, never data.
export default function createPanel({ html }) {
	const states = new Map();

	function repaint(host) {
		try { host?.requestRender?.(); } catch { /* detached fixture */ }
	}

	function freshState() {
		return {
			mounted: false,
			suspended: false,
			generation: 0,
			initialLoading: false,
			initialComplete: false,
			refreshScheduled: false,
			refreshCount: 0,
			capability: false,
			contractVersion: 0,
			routeLoaded: false,
			routeData: null,
			loadOrder: [],
			calls: {
				readStaff: 0,
				readSessions: 0,
				readGoals: 0,
				readGoalTasks: 0,
				readGoalGates: 0,
				readGoalPullRequest: 0,
			},
			staffPage: null,
			sessionLookup: null,
			goalLookup: null,
			goalPages: [],
			taskRead: null,
			gateRead: null,
			pullRequest: null,
			targeted: [],
			error: "",
			unsubscribers: [],
		};
	}

	function stateFor(sessionId) {
		let state = states.get(sessionId);
		if (!state) {
			state = freshState();
			states.set(sessionId, state);
		}
		return state;
	}

	async function projectCall(state, name, operation) {
		state.calls[name] += 1;
		state.loadOrder.push(name);
		return operation();
	}

	function routeQuery(params) {
		return {
			goalId: String(params?.goalId ?? ""),
			foreignGoalId: String(params?.foreignGoalId ?? ""),
			foreignSessionId: String(params?.foreignSessionId ?? ""),
			missingGoalId: String(params?.missingGoalId ?? "missing-goal-browser-fixture"),
			missingSessionId: String(params?.missingSessionId ?? "missing-session-browser-fixture"),
		};
	}

	async function readVisibleRecords(state, host) {
		const data = state.routeData;
		if (!data) return;
		const sessionIds = [data.sessionId, data.foreignSessionId, data.missingSessionId].filter(Boolean);
		const goalIds = [data.goalId, data.foreignGoalId, data.missingGoalId].filter(Boolean);
		const staffPage = await projectCall(state, "readStaff", () => host.project.readStaff({ mode: "page", cursor: 0, limit: 1 }));
		const sessionLookup = await projectCall(state, "readSessions", () => host.project.readSessions({ mode: "ids", ids: sessionIds }));
		const goalLookup = await projectCall(state, "readGoals", () => host.project.readGoals({ mode: "ids", ids: goalIds }));
		const firstGoals = await projectCall(state, "readGoals", () => host.project.readGoals({ mode: "page", cursor: 0, limit: 1 }));
		const goalPages = [firstGoals];
		if (firstGoals?.mode === "page" && firstGoals.page?.hasMore && firstGoals.page.nextCursor !== undefined) {
			goalPages.push(await projectCall(state, "readGoals", () => host.project.readGoals({
				mode: "page",
				cursor: firstGoals.page.nextCursor,
				limit: 1,
			})));
		}
		const taskRead = await projectCall(state, "readGoalTasks", () => host.project.readGoalTasks(data.goalId, { mode: "page", cursor: 0, limit: 1 }));
		const gateRead = await projectCall(state, "readGoalGates", () => host.project.readGoalGates(data.goalId, { mode: "page", cursor: 0, limit: 1 }));
		const pullRequest = await projectCall(state, "readGoalPullRequest", () => host.project.readGoalPullRequest(data.goalId));
		Object.assign(state, { staffPage, sessionLookup, goalLookup, goalPages, taskRead, gateRead, pullRequest });
	}

	async function initialLoad(state, params, host, generation) {
		if (state.initialLoading || state.initialComplete) return;
		state.initialLoading = true;
		state.capability = host?.capabilities?.projectReads === true && host?.capabilities?.has?.("projectReads") === true;
		state.contractVersion = Number(host?.contractVersion ?? 0);
		try {
			state.loadOrder.push("route");
			state.routeData = await host.callRoute("panelData", { query: routeQuery(params) });
			if (!state.mounted || generation !== state.generation) return;
			state.routeLoaded = true;
			await readVisibleRecords(state, host);
			if (!state.mounted || generation !== state.generation) return;
			state.initialComplete = true;
			state.error = "";
		} catch (error) {
			if (state.mounted && generation === state.generation) {
				state.error = error instanceof Error ? error.message : String(error);
			}
		} finally {
			state.initialLoading = false;
			repaint(host);
		}
	}

	function queueRefresh(state, host, generation) {
		if (!state.initialComplete || state.refreshScheduled || !state.mounted || generation !== state.generation) return;
		state.refreshScheduled = true;
		queueMicrotask(async () => {
			state.refreshScheduled = false;
			if (!state.mounted || generation !== state.generation) return;
			try {
				await readVisibleRecords(state, host);
				if (!state.mounted || generation !== state.generation) return;
				state.refreshCount += 1;
				state.error = "";
			} catch (error) {
				if (state.mounted && generation === state.generation) state.error = error instanceof Error ? error.message : String(error);
			}
			repaint(host);
		});
	}

	function targeted(state, host, generation, label, operation) {
		void (async () => {
			try {
				await operation();
				if (!state.mounted || generation !== state.generation) return;
				state.targeted.push(label);
				state.error = "";
			} catch (error) {
				if (state.mounted && generation === state.generation) state.error = error instanceof Error ? error.message : String(error);
			}
			repaint(host);
		})();
	}

	function mount(state, params, host) {
		if (state.mounted) return;
		state.mounted = true;
		state.suspended = false;
		const generation = ++state.generation;
		const subscribe = (name, callback) => host.project.notifications.subscribe(name, callback);
		const goalEvent = (event) => {
			const goalId = event?.payload?.goalId;
			if (!goalId) return;
			targeted(state, host, generation, `goals:${goalId}`, async () => {
				state.goalLookup = await projectCall(state, "readGoals", () => host.project.readGoals({ mode: "ids", ids: [goalId] }));
			});
		};
		const taskEvent = (event) => {
			const goalId = event?.payload?.goalId;
			const taskId = event?.payload?.taskId;
			if (!goalId || !taskId || goalId !== state.routeData?.goalId) return;
			targeted(state, host, generation, `tasks:${taskId}`, async () => {
				state.taskRead = await projectCall(state, "readGoalTasks", () => host.project.readGoalTasks(goalId, { mode: "ids", ids: [taskId] }));
			});
		};
		const sessionEvent = (event) => {
			const sessionId = event?.payload?.sessionId;
			if (!sessionId) return;
			targeted(state, host, generation, `sessions:${sessionId}`, async () => {
				state.sessionLookup = await projectCall(state, "readSessions", () => host.project.readSessions({ mode: "ids", ids: [sessionId] }));
			});
		};
		state.unsubscribers = [
			subscribe("goalCreated", goalEvent),
			subscribe("goalUpdated", goalEvent),
			subscribe("goalArchived", goalEvent),
			subscribe("taskCreated", taskEvent),
			subscribe("taskUpdated", taskEvent),
			subscribe("taskStateChanged", taskEvent),
			subscribe("sessionCreated", sessionEvent),
			subscribe("sessionArchived", sessionEvent),
			host.project.notifications.onRefreshRequired(() => queueRefresh(state, host, generation)),
		];
		if (state.initialComplete) queueRefresh(state, host, generation);
		else void initialLoad(state, params, host, generation);
	}

	function unsubscribe(state, host) {
		if (!state.mounted) return;
		state.mounted = false;
		state.suspended = true;
		state.generation += 1;
		for (const stop of state.unsubscribers.splice(0)) {
			stop();
			stop();
		}
		repaint(host);
	}

	function json(value) {
		return value == null ? "" : JSON.stringify(value);
	}

	return {
		render(params, host) {
			const sessionId = String(params?.__sessionId ?? "unbound");
			const state = stateFor(sessionId);
			if (host && !state.mounted && !state.suspended) mount(state, params, host);
			return html`
				<section data-testid="host-project-read-fixture-panel" style="padding:1rem;display:grid;gap:.6rem;color:var(--foreground);background:var(--background)">
					<header><strong>Host Project Read Fixture</strong></header>
					<div data-testid="project-read-capability">${String(state.capability)}</div>
					<div data-testid="project-read-contract-version">${String(state.contractVersion)}</div>
					<div data-testid="project-read-route-loaded">${String(state.routeLoaded)}</div>
					<div data-testid="project-read-load-order">${state.loadOrder.join(",")}</div>
					<div data-testid="project-read-state">${state.mounted ? "mounted" : "unsubscribed"}</div>
					<div data-testid="project-read-refresh-count">${String(state.refreshCount)}</div>
					<div data-testid="project-read-error">${state.error}</div>
					<pre data-testid="project-read-calls">${json(state.calls)}</pre>
					<pre data-testid="project-read-staff-page">${json(state.staffPage)}</pre>
					<pre data-testid="project-read-session-lookup">${json(state.sessionLookup)}</pre>
					<pre data-testid="project-read-goal-lookup">${json(state.goalLookup)}</pre>
					<pre data-testid="project-read-goal-pages">${json(state.goalPages)}</pre>
					<pre data-testid="project-read-task-read">${json(state.taskRead)}</pre>
					<pre data-testid="project-read-gate-read">${json(state.gateRead)}</pre>
					<pre data-testid="project-read-pr-read">${json(state.pullRequest)}</pre>
					<ul data-testid="project-read-targeted">
						${state.targeted.map(label => html`<li data-target=${label}>${label}</li>`)}
					</ul>
					<button data-testid="project-read-unsubscribe" type="button" @click=${() => unsubscribe(state, host)}>Unsubscribe twice</button>
					<button data-testid="project-read-remount" type="button" @click=${() => { mount(state, params, host); repaint(host); }}>Remount</button>
				</section>
			`;
		},
	};
}
