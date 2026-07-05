// src/server/routes/route-table.ts
//
// STR-01 (route-registry rearchitecture of handleApiRoute). See
// docs/design/route-registry.md for the seam design and migration protocol.
//
// A minimal, generic {method, path-pattern, handler} table. `handleApiRoute`
// consults an instance of this BEFORE its legacy if/else chain: a match here
// short-circuits the request; no match falls through to the legacy chain
// unchanged. Routes are migrated one at a time — each `register()` call
// added here removes the corresponding `if` block from the legacy chain in
// the same commit, so at every point in history the union of
// "registered here" + "still in the legacy chain" is the complete, correct
// route surface (never both, never neither).
//
// Precedence is EXPLICIT and kind-based, not registration-order-based (the
// bug class STR-01 flagged: source-line order silently determining which of
// two overlapping matchers wins). Within a single `match()` call:
//   1. exact literal routes are tried first (O(1) map lookup),
//   2. then `:param` routes (first registered match wins),
//   3. then `/*` prefix routes (first registered match wins).
// This mirrors (and makes explicit) the exact-before-prefix intent already
// implicit in the legacy code's hand-written negative-lookahead regexes
// (e.g. `/^\/api\/projects\/(?!(?:preflight|...)$)([^/]+)$/`).
//
// A pattern segment starting with `:` (e.g. `:id`) captures one path segment
// (no `/`). A pattern ending in `/*` is a prefix match on everything up to
// and including that trailing slash. Anything else is matched literally.

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteHandler<Ctx> = (ctx: Ctx, params: Record<string, string>) => Promise<void> | void;

interface ParamEntry<Ctx> {
	method: RouteMethod;
	pattern: string;
	regex: RegExp;
	paramNames: string[];
	handler: RouteHandler<Ctx>;
}

interface PrefixEntry<Ctx> {
	method: RouteMethod;
	prefix: string;
	handler: RouteHandler<Ctx>;
}

export interface RouteMatch<Ctx> {
	handler: RouteHandler<Ctx>;
	params: Record<string, string>;
}

export interface RegisterOptions {
	/**
	 * Reject specific literal values for a `:param` segment (the param must be
	 * the LAST segment of the pattern — throws otherwise). Compiles to the
	 * same negative-lookahead technique the legacy chain used by hand (e.g.
	 * `/^\/api\/projects\/(?!(?:preflight|archive-bobbit|...)$)([^/]+)$/`) so
	 * a generic `:id` catch-all never shadows sibling literal routes
	 * registered on OTHER methods for those same reserved names (the literal
	 * names themselves are already unambiguous on methods that DO have an
	 * exact registration — see route-table.ts's exact-before-param
	 * precedence — this only matters for the remaining method/path
	 * combinations that have no exact registration at all and must instead
	 * fall through to the legacy chain's final 404, exactly as before).
	 */
	excludeParamValues?: Record<string, string[]>;
}

/** Escape a literal path segment for embedding in a `RegExp`. */
function escapeRegexLiteral(segment: string): string {
	return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class RouteTable<Ctx> {
	// Keyed by `${method} ${pattern}` for O(1) exact lookup.
	private readonly exact = new Map<string, RouteHandler<Ctx>>();
	private readonly params: ParamEntry<Ctx>[] = [];
	private readonly prefixes: PrefixEntry<Ctx>[] = [];

	/**
	 * Register one (method, pattern) → handler mapping. Throws at
	 * registration time (fail fast at boot, not at request time) if the same
	 * (method, pattern) is registered twice — this is exactly the kind of
	 * silent-shadowing bug STR-01 exists to make impossible.
	 */
	register(method: RouteMethod, pattern: string, handler: RouteHandler<Ctx>, opts?: RegisterOptions): void {
		if (pattern.endsWith("/*")) {
			const prefix = pattern.slice(0, -1); // drop trailing "*", keep the "/"
			if (this.prefixes.some((e) => e.method === method && e.prefix === prefix)) {
				throw new Error(`RouteTable: duplicate prefix registration for ${method} ${pattern}`);
			}
			this.prefixes.push({ method, prefix, handler });
			return;
		}
		if (pattern.includes(":")) {
			if (this.params.some((e) => e.method === method && e.pattern === pattern)) {
				throw new Error(`RouteTable: duplicate param registration for ${method} ${pattern}`);
			}
			const paramNames: string[] = [];
			const segments = pattern.split("/");
			const regexBody = segments
				.map((seg, i) => {
					if (seg.startsWith(":")) {
						const name = seg.slice(1);
						paramNames.push(name);
						const excludes = opts?.excludeParamValues?.[name];
						if (excludes && excludes.length > 0) {
							if (i !== segments.length - 1) {
								throw new Error(`RouteTable: excludeParamValues on ":${name}" requires it to be the LAST segment of "${pattern}"`);
							}
							const alternation = excludes.map(escapeRegexLiteral).join("|");
							return `(?!(?:${alternation})$)([^/]+)`;
						}
						return "([^/]+)";
					}
					return escapeRegexLiteral(seg);
				})
				.join("/");
			this.params.push({ method, pattern, regex: new RegExp(`^${regexBody}$`), paramNames, handler });
			return;
		}
		const key = `${method} ${pattern}`;
		if (this.exact.has(key)) {
			throw new Error(`RouteTable: duplicate exact registration for ${key}`);
		}
		this.exact.set(key, handler);
	}

	/** Resolve a request to a handler + extracted `:param` values, or `null` if unrouted (caller should fall through to the legacy chain). */
	match(method: string, pathname: string): RouteMatch<Ctx> | null {
		const exactHit = this.exact.get(`${method} ${pathname}`);
		if (exactHit) return { handler: exactHit, params: {} };

		for (const e of this.params) {
			if (e.method !== method) continue;
			const m = e.regex.exec(pathname);
			if (!m) continue;
			const params: Record<string, string> = {};
			e.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });
			return { handler: e.handler, params };
		}

		for (const e of this.prefixes) {
			if (e.method !== method) continue;
			if (pathname.startsWith(e.prefix)) return { handler: e.handler, params: {} };
		}

		return null;
	}
}
