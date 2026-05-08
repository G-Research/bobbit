// Test entry — bundles `createGoal` from src/app/api.ts plus the
// `<error-details>` element so a file:// fixture can stub `fetch` to
// return a structured 400 body and observe the connection-error modal.

import { createGoal } from "../../src/app/api.js";
import "../../src/ui/components/ErrorDetails.js";

(window as any).__createGoal = createGoal;

// Capture every fetch call. The fixture can override the response per call.
(window as any).__fetchCalls = [];
type Responder = (url: string, init: RequestInit) => { status: number; body: unknown };
const origFetch = window.fetch;
window.fetch = async (url: any, init: RequestInit = {}) => {
	const u = String(url);
	(window as any).__fetchCalls.push({ url: u, method: init?.method || "GET", body: init?.body });
	const responder = (window as any).__fetchResponder as undefined | Responder;
	if (responder) {
		const r = responder(u, init);
		return new Response(JSON.stringify(r.body), {
			status: r.status,
			headers: { "Content-Type": "application/json" },
		});
	}
	return origFetch.call(window, url, init);
};

(window as any).__setFetchResponder = (fn: Responder) => {
	(window as any).__fetchResponder = fn;
};

(window as any).__ready = true;
