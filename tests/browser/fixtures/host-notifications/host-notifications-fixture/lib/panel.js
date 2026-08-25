// Marketplace panel fixture for the canonical scoped notification Host APIs.
// It refreshes from authoritative Host API projections on initial mount,
// reconnect/gap invalidation, and reload; notifications are never treated as a
// historical state store.
export default function createPanel({ html }) {
	const bySession = new Map();

	function repaint(host) {
		try { host?.requestRender?.(); } catch { /* fixture remains usable while detached */ }
	}

	function stateFor(sessionId) {
		let state = bySession.get(sessionId);
		if (!state) {
			state = {
				mounted: false,
				suspended: false,
				generation: 0,
				refreshScheduled: false,
				refreshCount: 0,
				refreshError: "",
				transcriptTotal: 0,
				snapshotSessionId: "",
				snapshotWorkingDir: "",
				sessionEvents: [],
				projectEvents: [],
				unsubscribers: [],
			};
			bySession.set(sessionId, state);
		}
		return state;
	}

	function queueSnapshot(state, host, generation) {
		if (state.refreshScheduled || !state.mounted || generation !== state.generation) return;
		state.refreshScheduled = true;
		queueMicrotask(async () => {
			state.refreshScheduled = false;
			if (!state.mounted || generation !== state.generation) return;
			try {
				const [transcript, projection] = await Promise.all([
					host.session.readTranscript({ offset: 0, limit: 100 }),
					host.callRoute("snapshot"),
				]);
				if (!state.mounted || generation !== state.generation) return;
				state.transcriptTotal = Number(transcript?.total ?? 0);
				state.snapshotSessionId = String(projection?.sessionId ?? "");
				state.snapshotWorkingDir = String(projection?.workingDir ?? "");
				state.refreshCount += 1;
				state.refreshError = "";
			} catch (error) {
				if (!state.mounted || generation !== state.generation) return;
				state.refreshError = error instanceof Error ? error.message : String(error);
			}
			repaint(host);
		});
	}

	function mount(state, host) {
		if (state.mounted) return;
		state.mounted = true;
		state.suspended = false;
		const generation = ++state.generation;
		const sessionEvent = host.session.notifications.subscribe("messageAppended", (event) => {
			if (!state.mounted || generation !== state.generation) return;
			state.sessionEvents.push({ id: event.id, messageId: event.payload.messageId });
			repaint(host);
		});
		const projectEvent = host.project.notifications.subscribe("goalCreated", (event) => {
			if (!state.mounted || generation !== state.generation) return;
			state.projectEvents.push({ id: event.id, goalId: event.payload.goalId });
			repaint(host);
		});
		const sessionRefresh = host.session.notifications.onRefreshRequired(() => queueSnapshot(state, host, generation));
		const projectRefresh = host.project.notifications.onRefreshRequired(() => queueSnapshot(state, host, generation));
		state.unsubscribers = [sessionEvent, projectEvent, sessionRefresh, projectRefresh];
	}

	function unsubscribe(state, host) {
		if (!state.mounted) return;
		state.mounted = false;
		state.suspended = true;
		state.generation += 1;
		const unsubscribers = state.unsubscribers.splice(0);
		for (const stop of unsubscribers) {
			stop();
			stop(); // contract: unsubscribe is idempotent
		}
		repaint(host);
	}

	return {
		render(params, host) {
			const sessionId = String(params?.__sessionId ?? "unbound");
			const state = stateFor(sessionId);
			if (host && !state.mounted && !state.suspended) mount(state, host);
			return html`
				<section data-testid="host-notifications-fixture-panel" style="padding:1rem;display:grid;gap:.75rem;color:var(--foreground);background:var(--background)">
					<header><strong>Host Notifications Fixture</strong></header>
					<div data-testid="fixture-subscription-state">${state.mounted ? "mounted" : "unsubscribed"}</div>
					<div>Snapshots: <span data-testid="fixture-snapshot-count">${state.refreshCount}</span></div>
					<div>Transcript total: <span data-testid="fixture-transcript-total">${state.transcriptTotal}</span></div>
					<div>Snapshot session: <span data-testid="fixture-snapshot-session">${state.snapshotSessionId}</span></div>
					<div data-testid="fixture-snapshot-working-dir">${state.snapshotWorkingDir}</div>
					<div data-testid="fixture-refresh-error">${state.refreshError}</div>
					<button data-testid="fixture-unsubscribe" type="button" @click=${() => unsubscribe(state, host)}>Unsubscribe twice</button>
					<button data-testid="fixture-remount" type="button" @click=${() => { mount(state, host); repaint(host); }}>Remount</button>
					<h3>Session notifications</h3>
					<ul data-testid="fixture-session-events">
						${state.sessionEvents.map((event) => html`<li data-notification-id=${event.id} data-message-id=${event.messageId}>messageAppended ${event.messageId}</li>`)}
					</ul>
					<h3>Project notifications</h3>
					<ul data-testid="fixture-project-events">
						${state.projectEvents.map((event) => html`<li data-notification-id=${event.id} data-goal-id=${event.goalId}>goalCreated ${event.goalId}</li>`)}
					</ul>
				</section>
			`;
		},
	};
}
