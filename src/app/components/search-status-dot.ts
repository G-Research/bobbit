// ============================================================================
// <search-status-dot> — small pill showing search-index state.
// Renders nothing when idle (green). Yellow pill while indexing or when backlog
// exceeds 50. Red pill with Retry link when the last event was index:error.
// Subscribes to a shared viewer WebSocket (`/ws/viewer`) lazily; re-dispatches
// `index:progress`, `index:complete`, `index:error` as DOM CustomEvents on
// `window` so multiple dots stay in sync without re-opening sockets.
// ============================================================================

import { LitElement, html, nothing } from "lit";
import { customElement, state as stateDecorator } from "lit/decorators.js";
import { GW_TOKEN_KEY } from "../state.js";
import { searchRebuild } from "../api.js";
import {
	INDEX_EVENT_NAME,
	nextDotState,
	type DotState,
	type IndexEvent,
} from "./search-status-dot-state.js";

export type {
	DotState,
	IndexEvent,
	IndexPhase,
	IndexProgressEvent,
	IndexCompleteEvent,
	IndexErrorEvent,
} from "./search-status-dot-state.js";
export { nextDotState, INDEX_EVENT_NAME } from "./search-status-dot-state.js";

// ---------------------------------------------------------------------------
// Shared viewer WS connection + event bus
// ---------------------------------------------------------------------------

const EVENT_NAME = INDEX_EVENT_NAME;
let _viewerWs: WebSocket | null = null;
let _viewerReconnect: ReturnType<typeof setTimeout> | null = null;
let _subscribers = 0;

function _connectViewerWs(): void {
	if (_viewerWs && (_viewerWs.readyState === WebSocket.OPEN || _viewerWs.readyState === WebSocket.CONNECTING)) return;
	const protocol = location.protocol === "https:" ? "wss:" : "ws:";
	const ws = new WebSocket(`${protocol}//${location.host}/ws/viewer`);
	_viewerWs = ws;
	ws.addEventListener("open", () => {
		const token = localStorage.getItem(GW_TOKEN_KEY);
		if (token) ws.send(JSON.stringify({ type: "auth", token }));
	});
	ws.addEventListener("message", (event) => {
		try {
			const msg = JSON.parse(event.data as string);
			if (typeof msg?.type === "string" && msg.type.startsWith("index:")) {
				window.dispatchEvent(new CustomEvent<IndexEvent>(EVENT_NAME, { detail: msg as IndexEvent }));
			}
		} catch { /* ignore unparseable */ }
	});
	ws.addEventListener("close", () => {
		_viewerWs = null;
		if (_subscribers > 0) {
			if (_viewerReconnect) clearTimeout(_viewerReconnect);
			_viewerReconnect = setTimeout(() => { if (_subscribers > 0) _connectViewerWs(); }, 3000);
		}
	});
	ws.addEventListener("error", () => { /* close handler triggers reconnect */ });
}

function _releaseViewerWs(): void {
	if (_subscribers > 0) return;
	if (_viewerReconnect) { clearTimeout(_viewerReconnect); _viewerReconnect = null; }
	if (_viewerWs && (_viewerWs.readyState === WebSocket.OPEN || _viewerWs.readyState === WebSocket.CONNECTING)) {
		_viewerWs.close();
	}
	_viewerWs = null;
}

/**
 * Inject a synthetic index event into the bus.  Used by tests and by the
 * Settings panel (which already has access to fresh REST snapshots after
 * triggering a rebuild) to surface state changes without waiting for a WS
 * round-trip.
 */
export function dispatchIndexEvent(event: IndexEvent): void {
	window.dispatchEvent(new CustomEvent<IndexEvent>(EVENT_NAME, { detail: event }));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

@customElement("search-status-dot")
export class SearchStatusDot extends LitElement {
	// Render into light DOM so app-level Tailwind classes apply.
	createRenderRoot() { return this; }

	@stateDecorator() private _dot: DotState = { kind: "idle" };
	@stateDecorator() private _retrying = false;

	private _onEvent = (e: Event) => {
		const evt = (e as CustomEvent<IndexEvent>).detail;
		if (!evt) return;
		this._dot = nextDotState(this._dot, evt);
	};

	connectedCallback(): void {
		super.connectedCallback();
		_subscribers++;
		_connectViewerWs();
		window.addEventListener(EVENT_NAME, this._onEvent);
	}

	disconnectedCallback(): void {
		super.disconnectedCallback();
		_subscribers = Math.max(0, _subscribers - 1);
		window.removeEventListener(EVENT_NAME, this._onEvent);
		if (_subscribers === 0) _releaseViewerWs();
	}

	private async _retry() {
		if (this._retrying) return;
		this._retrying = true;
		try {
			const res = await searchRebuild();
			if (res.ok) {
				this._dot = { kind: "indexing", completed: 0, total: 0, backlog: 0, phase: "rebuild" };
			}
		} finally {
			this._retrying = false;
		}
	}

	render() {
		const d = this._dot;
		if (d.kind === "idle") return nothing;
		if (d.kind === "indexing") {
			const n = d.backlog > 0 ? d.backlog : Math.max(0, d.total - d.completed);
			const label = d.phase === "rebuild"
				? (d.total > 0 ? `Indexing ${d.completed}/${d.total}…` : "Indexing…")
				: `Indexing ${n} item${n === 1 ? "" : "s"}…`;
			return html`
				<span
					class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30"
					title="Search index update in progress"
					data-status-dot="yellow"
				>
					<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse"></span>
					${label}
				</span>
			`;
		}
		// Error
		return html`
			<span
				class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-destructive/15 text-destructive border border-destructive/40"
				title="${d.message || "Search unavailable"}"
				data-status-dot="red"
			>
				<span class="inline-block w-1.5 h-1.5 rounded-full bg-destructive"></span>
				Search unavailable
				${d.recoverable ? html`
					<button
						class="ml-1 underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
						?disabled=${this._retrying}
						@click=${() => this._retry()}
						data-status-dot-retry
					>${this._retrying ? "Retrying…" : "Retry"}</button>
				` : nothing}
			</span>
		`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"search-status-dot": SearchStatusDot;
	}
}
