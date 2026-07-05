// Migrated from tests/api-error-forwarding.spec.ts (v2-dom tier).
// Drives the REAL createGoal (src/app/api.ts) → connection-error dialog
// (src/app/dialogs.ts) → <error-details> (src/ui/components/ErrorDetails.ts)
// path under happy-dom (was an esbuild file:// bundle). fetch is stubbed to
// return a structured 400 body; the dialog must forward the server's
// error/code/stack into <error-details> and never show the fallback string.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGoal } from "../../src/app/api.js";
import "../../src/ui/components/ErrorDetails.js";
// createGoal fire-and-forget imports dialogs.js (showConnectionError) which in
// turn can pull the safe-markdown chunk. Pre-import both statically so their
// @customElement side effects run DURING the test rather than resolving after
// env teardown (a post-teardown "customElements is not defined" unhandled
// rejection corrupts the shared fork under isolate:false).
import "../../src/app/dialogs.js";
import "../../src/ui/lazy/safe-markdown-block.js";

const STACK = "Error: Missing title\n    at handler (server.ts:3137:9)\n    at handleApiRoute (server.ts:42:5)";

let responder: ((url: string, init: any) => { status: number; body: any }) | undefined;

function setFetchResponder(fn: (url: string, init: any) => { status: number; body: any }) {
	responder = fn;
}

async function waitFor(fn: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (fn()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("waitFor timed out");
}

beforeEach(() => {
	responder = undefined;
	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const r = responder ? responder(String(url), init) : { status: 200, body: {} };
		return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json" } });
	});
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("createGoal — descriptive error forwarding", () => {
	it("forwards server error/code/stack into connection-error modal", async () => {
		setFetchResponder(() => ({ status: 400, body: { error: "Missing title", code: "bad_request", stack: STACK } }));

		const result = await createGoal("", "/tmp", { projectId: "p1" });
		expect(result).toBeNull();

		// Dialog renders asynchronously (dynamic import of dialogs.js).
		await waitFor(() => !!document.querySelector('[data-testid="error-details-message"]'));

		const message = document.querySelector('[data-testid="error-details-message"]');
		expect(message?.textContent).toBe("Missing title");

		const code = document.querySelector('[data-testid="error-details-code"]');
		expect(code?.textContent).toBe("bad_request");

		const stackBlocks = document.querySelectorAll('[data-testid="error-details-stack"]');
		expect(stackBlocks.length).toBe(1);
		const pre = stackBlocks[0].querySelector("pre");
		expect(pre?.textContent).toContain("Error: Missing title");
		expect(pre?.textContent).toContain("handler (server.ts:3137:9)");
		expect(pre?.textContent).toContain("handleApiRoute (server.ts:42:5)");

		// The fallback status-code strings must NOT appear anywhere.
		const bodyText = document.body.textContent || "";
		expect(bodyText).not.toContain("Failed to create goal: 400");
		expect(bodyText).not.toContain("Failed: 400");
	});

	it("falls back to status-code message ONLY when server returns no error body", async () => {
		// A 400 with empty body — the fallback path should kick in. Guards against
		// a regression where errorFromResponse() throws on JSON parse instead of
		// using the fallback string.
		setFetchResponder(() => ({ status: 400, body: {} }));

		const result = await createGoal("x", "/tmp", { projectId: "p1" });
		expect(result).toBeNull();

		await waitFor(() => !!document.querySelector('[data-testid="error-details-message"]'));
		expect(document.querySelector('[data-testid="error-details-message"]')?.textContent)
			.toBe("Failed to create goal: 400");
	});
});
