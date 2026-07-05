// Entry that bundles <custom-provider-dialog> for a file:// fixture so we can
// pin the API-key redaction contract on the client side: the dialog never
// receives the stored key (server redacts reads to `hasApiKey`), so it must
// (a) show a blank field with a "leave blank to keep" affordance when a key
// is stored, (b) OMIT `apiKey` from the save payload when the field is left
// untouched, (c) send the typed value when the user enters a new key, and
// (d) send `apiKey: null` when the user explicitly clears the stored key.
import { CustomProviderDialog } from "../../src/ui/dialogs/CustomProviderDialog.js";

(window as any).CustomProviderDialog = CustomProviderDialog;

// Capture every gatewayFetch (it delegates to window.fetch) so tests can
// assert on the exact wire payload without a real gateway.
(window as any).__fetchCalls = [];
window.fetch = ((input: unknown, init?: RequestInit) => {
	const url = String(input);
	(window as any).__fetchCalls.push({ url, method: init?.method || "GET", body: init?.body });
	if (url.includes("/api/custom-providers/test")) {
		return Promise.resolve(
			new Response(JSON.stringify({ models: [] }), { status: 200, headers: { "content-type": "application/json" } }),
		);
	}
	return Promise.resolve(
		new Response(JSON.stringify({ ok: true, config: {} }), { status: 200, headers: { "content-type": "application/json" } }),
	);
}) as typeof window.fetch;

(window as any).__ready = true;
