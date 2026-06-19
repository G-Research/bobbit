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
} from "../../src/app/marketplace-page.js";
import type { PackRuntimeCapabilitySummary, PackActivationResponse } from "../../src/app/api.js";

const container = document.getElementById("container") as HTMLElement;

(window as any).__renderCard = (runtimeId: string, cap: PackRuntimeCapabilitySummary | null | undefined): string => {
	render(renderRuntimeConsentCardView(runtimeId, cap), container);
	return container.innerHTML;
};

(window as any).__total = (activation: PackActivationResponse): number => activationEntityTotal(activation);
(window as any).__enabled = (activation: PackActivationResponse): number => activationEntityEnabledCount(activation);

(window as any).__ready = true;
