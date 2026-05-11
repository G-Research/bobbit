// Test entry — bundles `updateLocalSessionStatus`, `state`, and
// `hasUnseenActivity` so a file:// fixture can drive the
// "spurious idle/unread" bug repro without a running gateway.

import { updateLocalSessionStatus } from "../../src/app/api.js";
import { state, type GatewaySession } from "../../src/app/state.js";
import { hasUnseenActivity } from "../../src/app/render-helpers.js";

(window as any).__state = state;
(window as any).__updateLocalSessionStatus = updateLocalSessionStatus;
(window as any).__hasUnseenActivity = hasUnseenActivity;

// Helper: seed a single GatewaySession into state with the given lastActivity.
(window as any).__seedSession = (id: string, lastActivity: number, lastReadAt?: number): void => {
	const sess: GatewaySession = {
		id,
		title: "test session",
		cwd: "/tmp",
		status: "idle",
		createdAt: lastActivity,
		lastActivity,
		lastReadAt,
		clientCount: 1,
	};
	state.gatewaySessions.length = 0;
	state.gatewaySessions.push(sess);
};

(window as any).__ready = true;
