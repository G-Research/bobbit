// Test entry — exercises the Phase-1 CLIENT Host API `getHostApi`
// (src/app/host-api.ts), the durable v1 contract (design extension-host.md §3).
//
// Pins:
//   1. `host.capabilities` is the single source of truth: invokeAction +
//      requestRender are true; the Phase-2 caps (callRoute/session/ui/store) are
//      false; `has(name)` mirrors the flags.
//   2. `version`/`contractVersion` are the frozen consts.
//   3. There is NO `gateway` member (escape hatch removed).
//   4. Every Phase-2 stub throws "reserved for Phase 2".
//
// Loaded under a file:// fixture so the real `getHostApi` (which transitively
// imports lit/renderer-registry/state) runs in a browser context.
import { getHostApi } from "../../src/app/host-api.js";

(window as any).__getHostApi = () => getHostApi("sess-1", "tu-1");

// Capture a snapshot of the capability flags + meta for assertions.
(window as any).__caps = () => {
	const h = getHostApi("sess-1", "tu-1");
	return {
		version: h.version,
		contractVersion: h.contractVersion,
		invokeAction: h.capabilities.invokeAction,
		requestRender: h.capabilities.requestRender,
		callRoute: h.capabilities.callRoute,
		session: h.capabilities.session,
		ui: h.capabilities.ui,
		store: h.capabilities.store,
		hasInvokeAction: h.capabilities.has("invokeAction"),
		hasCallRoute: h.capabilities.has("callRoute"),
		hasUnknown: h.capabilities.has("nope"),
		hasGatewayMember: (h as Record<string, unknown>).gateway !== undefined,
	};
};

// Returns the thrown message (or null) for a given Phase-2 stub invocation.
(window as any).__callStub = (which: string): string | null => {
	const h: any = getHostApi("sess-1", "tu-1");
	try {
		switch (which) {
			case "callRoute": h.callRoute("x"); break;
			case "session.readTranscript": h.session.readTranscript(); break;
			case "session.readToolCall": h.session.readToolCall("tu"); break;
			case "session.postMessage": h.session.postMessage({ role: "user", text: "x" }); break;
			case "session.subscribe": h.session.subscribe("status", () => {}); break;
			case "ui.openPanel": h.ui.openPanel({ panelId: "p" }); break;
			case "ui.navigate": h.ui.navigate({ route: "r" }); break;
			case "store.get": h.store.get("k"); break;
			case "store.put": h.store.put("k", 1); break;
			case "store.list": h.store.list(); break;
			default: return "unknown-stub";
		}
		return null; // did not throw → failure
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
};

(window as any).__ready = true;
