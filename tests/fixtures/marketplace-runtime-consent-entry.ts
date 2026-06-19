// Test entry — P3 managed-runtime consent enable-card (design §8). Renders the
// PURE consent-card view + exercises the master-toggle counting helpers in
// isolation (no server, no Docker, no module state), proving:
//   - managed mode discloses services / loopback ports / data volume / trust copy;
//   - external mode shows the no-Docker setup guidance instead of a Docker card;
//   - the activation total/enabled counts include the schema-v2 arrays so the
//     master toggle accounts for a managed runtime.
//
// Pattern mirrors tests/fixtures/marketplace-active-project-entry.ts: a file://
// fixture loads this bundle and drives it via window globals.
import { render } from "lit";
import {
	renderRuntimeConsentCardView,
	renderRuntimeConsentCard,
	ensureRuntimeCapabilities,
	invalidateRuntimeCapabilities,
	activationEntityTotal,
	activationEntityEnabledCount,
	runtimeRestPackId,
	runtimeCapabilityCacheKey,
} from "../../src/app/marketplace-page.js";
import { setRenderSuppressed } from "../../src/app/state.js";
import type { PackRuntimeCapabilitySummary, PackActivationResponse } from "../../src/app/api.js";

const container = document.getElementById("container") as HTMLElement;

// Suppress the real app render: ensureRuntimeCapabilities() schedules renderApp()
// after caching, and the bare fixture has no app shell/state to render. We only
// care about the capability cache + the consent card, so collapse renders to a
// no-op (the request is buffered and never flushed in this isolated harness).
setRenderSuppressed(true);

// ── Staleness regression (finding #1) ────────────────────────────────────────
// The consent disclosure is a function of the SERVER's current deployment mode,
// which the user changes elsewhere (the Hindsight panel). Stub window.fetch with
// a MUTABLE mode so a test can: cache the `external` disclosure, flip the server
// to `managed`, invalidate (as a marketplace (re)load does), and prove the card
// refetches the fresh `managed` disclosure before enable.
let serverMode: "external" | "managed" = "external";
let capabilityFetches = 0;
const origFetch = window.fetch?.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
	if (url.includes("/capabilities")) {
		capabilityFetches++;
		const body = serverMode === "external"
			? { packId: "hindsight", runtimeId: "hindsight", mode: "external", dockerRequired: false, services: [], ports: [] }
			// Distinct services/volume so the FETCHED managed disclosure is
			// distinguishable from the static fallback card (which uses "api, db" +
			// "~/.hindsight") — the test must prove the refetch, not a cache-miss fallback.
			: { packId: "hindsight", runtimeId: "hindsight", mode: "managed-postgres", dockerRequired: true, services: ["api", "web", "db"], ports: [], volumePath: "/managed/data/path" };
		return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	}
	if (origFetch) return origFetch(input as any, init);
	return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
};

const CONSENT_PACK = { scope: "server", packName: "hindsight", packId: "hindsight" } as never;

(window as any).__setServerMode = (mode: "external" | "managed"): void => { serverMode = mode; };
(window as any).__capabilityFetches = (): number => capabilityFetches;
(window as any).__ensureCaps = (): void => ensureRuntimeCapabilities(CONSENT_PACK, "hindsight");
(window as any).__invalidateCaps = (): void => invalidateRuntimeCapabilities();
(window as any).__consentHtml = (): string => {
	render(renderRuntimeConsentCard(CONSENT_PACK, "hindsight"), container);
	return container.innerHTML;
};

(window as any).__renderCard = (runtimeId: string, cap: PackRuntimeCapabilitySummary | null | undefined): string => {
	render(renderRuntimeConsentCardView(runtimeId, cap), container);
	return container.innerHTML;
};

(window as any).__total = (activation: PackActivationResponse): number => activationEntityTotal(activation);
(window as any).__enabled = (activation: PackActivationResponse): number => activationEntityEnabledCount(activation);

// Runtime REST identity + capability cache-key helpers (findings #2/#3): the
// capability fetch must address the STRUCTURAL pack id (not the manifest name)
// and the cache key must include the scoped projectId so a project-focus switch
// refetches rather than reusing a stale disclosure.
(window as any).__restPackId = (pack: { packId?: string; packName: string }): string => runtimeRestPackId(pack);
(window as any).__capKey = (
	scope: "server" | "global-user" | "project",
	packId: string,
	runtimeId: string,
	projectId: string | undefined,
): string => runtimeCapabilityCacheKey(scope, packId, runtimeId, projectId);

(window as any).__ready = true;
