// Test entry — bundles the New Goal dialog so we can drive it from a
// file:// fixture. We expose `showNewGoalDialog` plus a tiny shim around
// `localStorage` so the test can assert dismiss persistence.
//
// We also override `window.fetch` BEFORE importing dialogs.js so that
// `fetchWorkflows()` (called inside `showNewGoalDialog`) sees the
// per-test workflow list set by `window.__nextWorkflowsResponse`. This
// lets us pin the workflow-id coercion behaviour (post commit
// `058c17ea` — brand-new projects with no `general` workflow used to
// yield a 400 "Workflow not found: general" on Accept) end-to-end
// through the dialog.
(window as any).__nextWorkflowsResponse = null;
const _origFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : (input instanceof URL ? input.toString() : input.url);
	if (url.includes("/api/workflows")) {
		const override = (window as any).__nextWorkflowsResponse;
		if (override !== null && override !== undefined) {
			return new Response(JSON.stringify({ workflows: override }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
	}
	return _origFetch(input, init);
};

import { showNewGoalDialog } from "../../src/app/dialogs.js";

(window as any).__showNewGoalDialog = showNewGoalDialog;
(window as any).__readLocalStorage = (key: string) => {
	try { return localStorage.getItem(key); } catch { return null; }
};
(window as any).__clearLocalStorage = (key: string) => {
	try { localStorage.removeItem(key); } catch { /* ignore */ }
};
(window as any).__ready = true;
