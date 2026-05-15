/**
 * LSP `symbolName` shorthand — extension-level integration test.
 *
 * Covers the resolver baked into `defaults/tools/lsp/extension.ts` for
 * `lsp_definition`, `lsp_references`, and `lsp_hover`:
 *
 *   • Explicit (path, line, character) coordinates pass through unchanged.
 *   • `symbolName` is resolved via an internal workspace_symbol call.
 *   • Successful shorthand results are decorated with `resolvedFrom`.
 *   • Missing symbols return `{ error: "lsp_symbol_not_found" }` (no throw).
 *   • `path` hint narrows ambiguity by exact-path → same-directory → first.
 *   • Bare ambiguous lookups return `{ ambiguous, candidates }`.
 *
 * Strategy: spawn a real `LspSupervisor` against `tests/fixtures/lsp-ts/`,
 * monkey-patch `globalThis.fetch` so the extension's `/api/lsp/*` calls
 * land on `sup.dispatch(...)`, then dynamic-import the extension factory
 * and drive the registered `execute()` callbacks.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LspSupervisor } from "../../src/server/lsp/supervisor.ts";
import { TypescriptLspFactory } from "../../src/server/lsp/clients/typescript.ts";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE = path.resolve(__dirname, "..", "fixtures", "lsp-ts");

const factory = new TypescriptLspFactory();
const HAS_LSP = factory.isInstalled();
const skip = !HAS_LSP ? { skip: "typescript-language-server not installed" } : undefined;

interface RegisteredTool {
	name: string;
	description: string;
	parameters: unknown;
	execute: (id: string, args: any, abort: any, onUpdate?: any) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
}

describe("lsp_* symbolName shorthand (extension)", skip, () => {
	let sup: LspSupervisor;
	let tools: Map<string, RegisteredTool>;
	let origFetch: typeof globalThis.fetch;
	let prevEnv: { token?: string; url?: string; cwd?: string };

	before(async () => {
		sup = new LspSupervisor({
			maxServers: 4,
			idleTtlMs: 60_000,
			factories: [new TypescriptLspFactory()],
		});

		// Stub fetch — route /api/lsp/* to the in-process supervisor.
		origFetch = globalThis.fetch;
		globalThis.fetch = (async (input: any, init: any) => {
			const url = new URL(typeof input === "string" ? input : input.url);
			if (url.pathname.startsWith("/api/lsp/")) {
				const method = url.pathname.replace("/api/lsp/", "");
				const body = init?.body ? JSON.parse(String(init.body)) : {};
				try {
					const result = await sup.dispatch(method, body);
					return new Response(JSON.stringify(result), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				} catch (err: any) {
					return new Response(
						JSON.stringify({ error: "lsp_unavailable", message: String(err?.message ?? err) }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
			}
			return origFetch(input, init);
		}) as any;

		// Force the extension's `resolveGateway` to take the env-var path
		// (so it never touches the real `.bobbit/state/` on disk).
		prevEnv = {
			token: process.env.BOBBIT_TOKEN,
			url: process.env.BOBBIT_GATEWAY_URL,
			cwd: process.env.BOBBIT_HOST_CWD,
		};
		process.env.BOBBIT_TOKEN = "test-token";
		process.env.BOBBIT_GATEWAY_URL = "http://lsp-shorthand-test.invalid";
		process.env.BOBBIT_HOST_CWD = FIXTURE;

		// Dynamic-import after env is wired so `resolveGateway()` picks up our values.
		tools = new Map();
		const pi = {
			registerTool: (t: RegisteredTool) => { tools.set(t.name, t); },
		};
		const mod = await import("../../defaults/tools/lsp/extension.ts");
		mod.default(pi as any);

		// Pre-warm the supervisor so workspace_symbol returns hits on the
		// very first call. typescript-language-server needs an initial
		// document open to index project symbols.
		const client = await sup.ensure({ worktreePath: FIXTURE, language: "typescript" });
		await client.ensureDocOpen(path.join(FIXTURE, "src", "math.ts"));
		await client.ensureDocOpen(path.join(FIXTURE, "src", "index.ts"));
		await client.ensureDocOpen(path.join(FIXTURE, "src", "adder.ts"));
	});

	after(async () => {
		if (origFetch) globalThis.fetch = origFetch;
		process.env.BOBBIT_TOKEN = prevEnv.token;
		process.env.BOBBIT_GATEWAY_URL = prevEnv.url;
		process.env.BOBBIT_HOST_CWD = prevEnv.cwd;
		if (sup) await sup.shutdownAll();
	});

	/** Parse the JSON payload returned by an extension tool's `asText` wrapper. */
	function payload(res: { content: Array<{ type: "text"; text: string }> }): any {
		assert.ok(Array.isArray(res.content) && res.content[0]?.text, "tool result missing content[0].text");
		return JSON.parse(res.content[0].text);
	}

	test("lsp_definition: explicit coordinates pass through unchanged (no resolvedFrom)", async () => {
		const tool = tools.get("lsp_definition")!;
		const res = await tool.execute("t1", { path: "src/index.ts", line: 2, character: 10 });
		const data = payload(res);
		// Explicit-coordinate path must NOT decorate.
		assert.equal(data.resolvedFrom, undefined, "explicit-coords result must not carry resolvedFrom");
		assert.ok(data.path && /math\.ts$/.test(String(data.path)), `expected definition in math.ts; got ${JSON.stringify(data)}`);
		assert.equal(data.range?.start?.line, 0);
	});

	test("lsp_definition({symbolName:'add'}) matches the explicit-coordinate definition", async () => {
		const tool = tools.get("lsp_definition")!;
		// adder.ts adds a second `add` so we narrow with a path hint to pin
		// the comparison to the math.ts function.
		const shorthand = payload(await tool.execute("t2", { symbolName: "add", path: "src/math.ts" }));
		const explicit = payload(await tools.get("lsp_definition")!.execute("t2b", {
			path: "src/math.ts", line: 0, character: 16,
		}));

		assert.ok(shorthand.resolvedFrom, "shorthand result must carry resolvedFrom");
		assert.equal(shorthand.resolvedFrom.symbolName, "add");
		assert.match(String(shorthand.resolvedFrom.matched), /math\.ts:1$/);

		// Strip the wrapper field and compare the rest of the payload.
		const { resolvedFrom: _rf, ...rest } = shorthand;
		assert.deepEqual(rest, explicit, "shorthand definition payload must match explicit-coordinate payload");
	});

	test("lsp_references({symbolName:'add'}) returns call-site list (array wrapped under .result)", async () => {
		const tool = tools.get("lsp_references")!;
		const shorthand = payload(await tool.execute("t3", { symbolName: "add", path: "src/math.ts" }));
		const explicit = payload(await tool.execute("t3b", {
			path: "src/math.ts", line: 0, character: 16, includeDeclaration: true,
		}));

		assert.ok(shorthand.resolvedFrom, "shorthand result must carry resolvedFrom");
		// Array results are wrapped: { resolvedFrom, result: [...] }.
		assert.ok(Array.isArray(shorthand.result), `expected .result to be an array, got: ${JSON.stringify(shorthand).slice(0, 200)}`);
		assert.deepEqual(shorthand.result, explicit, "shorthand references list must equal explicit-coord list");
		assert.ok(shorthand.result.length >= 2, `expected ≥2 references (decl + use), got ${shorthand.result.length}`);
	});

	test("lsp_hover({symbolName:'add'}) matches the explicit-coordinate hover", async () => {
		const tool = tools.get("lsp_hover")!;
		// Pin via the Adder.add method — workspace_symbol returns a method range
		// whose start lands on the identifier, so shorthand and explicit-at-name
		// land on the same hover position.
		const shorthand = payload(await tool.execute("t4", { symbolName: "add", path: "src/adder.ts" }));
		assert.ok(shorthand.resolvedFrom, "shorthand hover must carry resolvedFrom");

		// Hover returns an object → decorator spreads fields, no `.result` wrapper.
		const { resolvedFrom, ...rest } = shorthand;
		// Match against an explicit call placed at the same coordinates the
		// resolver picked. The two MUST be byte-identical — that is the contract.
		const matchedLine1 = Number(String(resolvedFrom.matched).split(":").pop()) - 1;
		const explicit = payload(await tool.execute("t4b", {
			path: "src/adder.ts", line: matchedLine1, character: 1,
		}));
		assert.deepEqual(rest, explicit, "shorthand hover payload must equal hover at the resolved coordinates");
		assert.ok(rest && typeof rest.contents === "string" && /add/.test(rest.contents), `hover contents missing 'add': ${JSON.stringify(rest).slice(0, 200)}`);
	});

	test("lsp_definition({symbolName:'doesNotExist'}) returns lsp_symbol_not_found (no throw)", async () => {
		const tool = tools.get("lsp_definition")!;
		const res = await tool.execute("t5", { symbolName: "xyzzy_DoesNotExistAnywhere_42" });
		const data = payload(res);
		assert.equal(data.error, "lsp_symbol_not_found", `expected lsp_symbol_not_found, got: ${JSON.stringify(data)}`);
		assert.ok(typeof data.message === "string" && /xyzzy_DoesNotExistAnywhere_42/.test(data.message));
		// Must surface a recovery hint, not bubble an exception.
		assert.ok(typeof data.hint === "string" && data.hint.length > 0, "expected a hint string");
	});

	test("lsp_definition({path:'src/index.ts', symbolName:'add'}) resolves via use-site to math.ts", async () => {
		// Goal-spec scenario: the hint file (index.ts) is NOT a definition site,
		// it's a USE site (`import { add } from './math.js'`). Same-dir matching
		// would otherwise see two `add` candidates (math.ts, adder.ts) both under
		// `src/` and flag ambiguous. Resolver must instead treat the hint as a
		// use-site and dispatch from there so the LSP resolves the real target.
		const tool = tools.get("lsp_definition")!;
		const res = payload(await tool.execute("t5a", { path: "src/index.ts", symbolName: "add" }));
		assert.notEqual(res.ambiguous, true, `expected non-ambiguous resolution; got: ${JSON.stringify(res).slice(0, 300)}`);
		assert.ok(res.resolvedFrom, "expected shorthand decoration");
		assert.match(String(res.resolvedFrom.matched), /index\.ts:/, `use-site must be in index.ts; got ${res.resolvedFrom.matched}`);
		// Resulting definition (object-spread when LSP returns a single Location,
		// or wrapped under `.result` when it returns an array) must land in math.ts
		// — the actual imported definition the use-site references.
		const locs = Array.isArray(res.result)
			? res.result
			: (res.path ? [{ path: res.path, range: res.range }] : []);
		assert.ok(locs.length >= 1, `expected at least one definition location; got: ${JSON.stringify(res).slice(0, 300)}`);
		assert.match(String(locs[0].path), /math\.ts$/, `definition should land in math.ts; got ${locs[0]?.path}`);
	});

	test("lsp_definition({path:'src/adder.ts', symbolName:'add'}) selects the adder.ts hit, not math.ts", async () => {
		const tool = tools.get("lsp_definition")!;
		const res = payload(await tool.execute("t6", { path: "src/adder.ts", symbolName: "add" }));
		assert.ok(res.resolvedFrom, "expected shorthand decoration");
		assert.match(String(res.resolvedFrom.matched), /adder\.ts:/, `path hint must steer resolution to adder.ts; got ${res.resolvedFrom.matched}`);
		// Definition should also land in adder.ts (the class method body).
		assert.match(String(res.path), /adder\.ts$/, `definition path should be adder.ts; got ${res.path}`);
	});

	test("lsp_definition({symbolName:'add'}) without path hint is ambiguous with two `add` symbols", async () => {
		const tool = tools.get("lsp_definition")!;
		const res = payload(await tool.execute("t7", { symbolName: "add" }));
		assert.equal(res.ambiguous, true, `expected ambiguous result; got: ${JSON.stringify(res).slice(0, 200)}`);
		assert.equal(res.symbol, "add");
		assert.ok(Array.isArray(res.candidates) && res.candidates.length >= 2, `expected ≥2 candidates; got ${res.candidates?.length}`);
		const paths = res.candidates.map((c: any) => String(c.path));
		assert.ok(paths.some((p: string) => /math\.ts$/.test(p)), `expected math.ts in candidates; got ${paths.join(",")}`);
		assert.ok(paths.some((p: string) => /adder\.ts$/.test(p)), `expected adder.ts in candidates; got ${paths.join(",")}`);
		assert.ok(typeof res.hint === "string" && res.hint.length > 0, "ambiguous response should include a hint");
		// Each candidate must be a usable workspace-symbol record (no silent pick).
		for (const c of res.candidates) {
			assert.equal(typeof c.name, "string");
			assert.equal(c.name, "add");
			assert.ok(c.range?.start && typeof c.range.start.line === "number");
		}
	});
});
