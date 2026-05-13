/**
 * Reproducing unit tests for the shared error-modal helpers.
 *
 * The "Consistent Error Modals" goal promotes the (currently file-private)
 * helpers `errorFromResponse` and `errorDetails` from `src/app/api.ts` into
 * a dependency-free shared module `src/app/error-helpers.ts`, so call sites
 * in `dialogs.ts`, `render.ts`, `session-manager.ts`,
 * `role-manager-page.ts`, and `tool-manager-page.ts` can use them without
 * pulling in the entire app graph.
 *
 * Before the fix:
 *   - `src/app/error-helpers.ts` does not exist; this file fails to load
 *     with a `Cannot find module` error.
 * After the fix:
 *   - The module exports both helpers and these assertions pass.
 *
 * Contract being pinned (acceptance criterion #3 of the goal spec):
 *   - `errorFromResponse(res, fallback)` parses `{ error, code, stack }`
 *     from a JSON body, falls back to `fallback` (or `Failed: <status>`)
 *     when the body lacks an error field, and never throws on non-JSON
 *     bodies.
 *   - `errorDetails(err)` extracts `{ message, code, stack }` from an
 *     Error, a custom Error subclass with `.code`, or any non-Error value
 *     without throwing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

type ErrorFromResponse = (res: Response, fallback: string) => Promise<Error>;
type ErrorDetails = (err: unknown) => { message: string; code?: string; stack?: string };

let errorFromResponse: ErrorFromResponse | null = null;
let errorDetails: ErrorDetails | null = null;
let loadError: string | null = null;

try {
	// Dynamic import so module-load failures surface as readable test
	// failures rather than aborting the whole file.
	const mod: any = await import("../src/app/error-helpers.ts");
	errorFromResponse = mod.errorFromResponse ?? null;
	errorDetails = mod.errorDetails ?? null;
	if (typeof errorFromResponse !== "function" || typeof errorDetails !== "function") {
		loadError = `module loaded but missing expected exports (errorFromResponse=${typeof errorFromResponse}, errorDetails=${typeof errorDetails})`;
	}
} catch (err) {
	loadError = err instanceof Error ? err.message : String(err);
}

function requireHelpers(): { fromResp: ErrorFromResponse; details: ErrorDetails } {
	if (loadError || !errorFromResponse || !errorDetails) {
		throw new Error(`src/app/error-helpers.ts not available: ${loadError ?? "missing exports"}`);
	}
	return { fromResp: errorFromResponse, details: errorDetails };
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResponse(status: number, body: string): Response {
	return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

describe("error-helpers module", () => {
	it("exports errorFromResponse and errorDetails from src/app/error-helpers.ts", () => {
		assert.equal(loadError, null,
			`src/app/error-helpers.ts must load and export both helpers. ${loadError ?? ""}`);
		assert.equal(typeof errorFromResponse, "function");
		assert.equal(typeof errorDetails, "function");
	});
});

describe("errorFromResponse", () => {
	it("extracts error / code / stack from a structured JSON body", async () => {
		const { fromResp: errorFromResponse } = requireHelpers();
		const STACK = "Error: bad input\n    at handler (server.ts:42:7)";
		const r = jsonResponse(400, { error: "bad input", code: "bad_request", stack: STACK });
		const err = await errorFromResponse(r, "fallback msg");
		assert.equal(err.message, "bad input");
		assert.equal((err as any).code, "bad_request");
		assert.equal(err.stack, STACK);
	});

	it("uses the supplied fallback when the JSON body lacks an `error` field", async () => {
		const { fromResp: errorFromResponse } = requireHelpers();
		const r = jsonResponse(400, {});
		const err = await errorFromResponse(r, "Failed to create goal: 400");
		assert.equal(err.message, "Failed to create goal: 400");
		assert.equal((err as any).code, undefined);
	});

	it("falls back to a status-derived message when fallback is empty", async () => {
		const { fromResp: errorFromResponse } = requireHelpers();
		const r = jsonResponse(500, {});
		const err = await errorFromResponse(r, "");
		assert.match(err.message, /500/, "fallback message should mention the status code");
	});

	it("does not throw on a non-JSON body — returns fallback instead", async () => {
		const { fromResp: errorFromResponse } = requireHelpers();
		const r = textResponse(503, "<html>down</html>");
		const err = await errorFromResponse(r, "Service unavailable");
		assert.equal(err.message, "Service unavailable");
		assert.equal((err as any).code, undefined);
	});
});

describe("errorDetails", () => {
	it("extracts message + stack from a caught Error", () => {
		const { details: errorDetails } = requireHelpers();
		const e = new Error("boom");
		const d = errorDetails(e);
		assert.equal(d.message, "boom");
		assert.ok(d.stack && d.stack.includes("boom"), "stack should be present for Error instances");
	});

	it("forwards `code` attached to a custom Error", () => {
		const { details: errorDetails } = requireHelpers();
		const e = new Error("nope") as Error & { code?: string };
		e.code = "ENOENT";
		const d = errorDetails(e);
		assert.equal(d.code, "ENOENT");
		assert.equal(d.message, "nope");
	});

	it("returns String(value) message + no stack for non-Error throws", () => {
		const { details: errorDetails } = requireHelpers();
		const d = errorDetails("plain string");
		assert.equal(d.message, "plain string");
		assert.equal(d.stack, undefined);
		assert.equal(d.code, undefined);
	});

	it("handles null and undefined safely", () => {
		const { details: errorDetails } = requireHelpers();
		assert.equal(errorDetails(null).message, "null");
		assert.equal(errorDetails(undefined).message, "undefined");
	});
});
