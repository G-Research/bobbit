/**
 * Dependency-free helpers for forwarding structured error payloads to the
 * connection-error modal. Used by every `showConnectionError(...)` call site
 * so the `<error-details>` component can render reason + code + stack.
 *
 * Kept in its own tiny module (no imports from state, render, etc.) so
 * utility files and dialogs can use it without pulling in the app graph.
 *
 * Contract:
 *   - `errorFromResponse(res, fallback)` parses `{ error, code, stack }`
 *     from a JSON body. If the body lacks `error`, uses `fallback`.
 *     If `fallback` is empty, uses `Failed: <status>`. Never throws on
 *     non-JSON bodies.
 *   - `errorDetails(err)` extracts `{ message, code?, stack? }` from a
 *     caught value — Error, custom Error subclass with `.code`, or any
 *     non-Error value — without throwing.
 */

/**
 * Build an Error from a non-OK Response, preserving the server's structured
 * `{ error, code, stack }` body so callers can forward `code`/`stack` to the
 * connection-error modal. Pair with `errorDetails(err)` in the matching catch.
 */
export async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
	let data: any = {};
	try {
		data = await res.json();
	} catch {
		data = {};
	}
	if (!data || typeof data !== "object") data = {};
	const msg = (data && data.error) || fallback || `Failed: ${res.status}`;
	const err = new Error(msg);
	if (data && typeof data.code === "string") (err as any).code = data.code;
	if (data && typeof data.stack === "string") (err as any).stack = data.stack;
	return err;
}

/** Extract `{ message, code, stack }` from a caught value for `showConnectionError`. */
export function errorDetails(err: unknown): { message: string; code?: string; stack?: string } {
	const message = err instanceof Error ? err.message : String(err);
	const code = err && typeof err === "object" ? (err as any).code : undefined;
	const stack = err instanceof Error ? err.stack : undefined;
	return { message, code, stack };
}
