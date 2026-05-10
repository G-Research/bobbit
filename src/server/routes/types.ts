/**
 * Per-domain HTTP route types and the per-request RouteContext.
 *
 * A `Route` is `{ method, pattern, handler }`. `pattern` is either a literal
 * string (exact match) or a RegExp anchored `^...$`. Anchored regexes ensure
 * that at most one route matches a given pathname — pinned by
 * `tests/routes-anchor-pinned.test.ts`.
 *
 * Created during the server.ts → routes/ split.
 */
import type http from "node:http";
import type { SandboxScope } from "../auth/sandbox-token.js";
import type { RouteDeps } from "./route-deps.js";

export interface RouteContext {
	req: http.IncomingMessage;
	res: http.ServerResponse;
	url: URL;
	pathname: string;
	/** Numeric/string capture groups. params[0] is the full match. */
	params: ReadonlyArray<string>;
	/** Sandbox token scope, if the caller authenticated as a sandbox token. */
	sandboxScope?: SandboxScope;
	/** Lazy parsed JSON body. Returns null on malformed JSON (matches readBody). */
	readBody(): Promise<any>;
	/** Standard JSON response. */
	json(body: unknown, status?: number): void;
	/** Standard error response — every error path SHOULD go through here. */
	jsonError(status: number, err: unknown, extra?: Record<string, unknown>): void;
	/** All server singletons. */
	deps: RouteDeps;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void> | void;

export interface Route {
	method: string; // "GET" | "POST" | "PUT" | "DELETE" | "PATCH"
	/**
	 * Either a literal string (exact match) or a RegExp.
	 * RegExp must be anchored with `^...$` — pinned by a unit test.
	 */
	pattern: string | RegExp;
	handler: RouteHandler;
}
