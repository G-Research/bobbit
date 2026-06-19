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
	activationEntityTotal,
	activationEntityEnabledCount,
	runtimeRestPackId,
	runtimeCapabilityCacheKey,
} from "../../src/app/marketplace-page.js";
import type { PackRuntimeCapabilitySummary, PackActivationResponse } from "../../src/app/api.js";

const container = document.getElementById("container") as HTMLElement;

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
