/**
 * Tool description byte-budget — pinning test for the "Tighten tool descriptions"
 * goal. Every byte in `tool.description` and every nested JSON Schema property
 * `description` is paid on every uncached LLM turn (multiplied by the number of
 * tools the role enables, often 30+). This test caps the bleed so we don't
 * regress.
 *
 * Limits:
 *   - tool.description.length            ≤ 150 chars
 *   - JSON Schema property description   ≤  80 chars (recursive)
 *   - buildMetaToolDescription output    ≤ 150 chars, no inlined op enumeration
 *
 * The first two are checked by importing each `defaults/tools/<group>/extension.ts`
 * with a fake `pi` that captures every `registerTool({...})` invocation. The
 * third hits `buildMetaToolDescription` directly with a synthetic 50-op list of
 * long names.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";

import { buildMetaToolDescription } from "../src/server/mcp/mcp-meta.ts";
import type { McpToolDef } from "../src/server/mcp/mcp-types.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const EXTENSION_FILES = [
	"agent",
	"ask",
	"browser",
	"html",
	"images",
	"lsp",
	"mcp",
	"proposals",
	"review",
	"shell",
	"skills",
	"tasks",
	"team",
	"web",
];

const TOOL_DESC_MAX = 150;
const PARAM_DESC_MAX = 80;

interface CapturedTool {
	name: string;
	description?: string;
	parameters?: unknown;
	source: string;
}

const captured: CapturedTool[] = [];

before(async () => {
	// Ensure tool extensions that read state on import have a directory to look at.
	if (!process.env.BOBBIT_DIR) {
		process.env.BOBBIT_DIR = mkdtempSync(path.join(tmpdir(), "bobbit-tool-budget-"));
	}

	for (const group of EXTENSION_FILES) {
		const file = path.join(REPO_ROOT, "defaults/tools", group, "extension.ts");
		const url = pathToFileURL(file).href;
		const mod: any = await import(url);
		const factory = typeof mod.default === "function" ? mod.default : mod.default?.default;
		assert.ok(typeof factory === "function", `${group}/extension.ts has no callable default export`);

		const pi = {
			registerTool(def: any) {
				captured.push({
					name: def?.name ?? "<unnamed>",
					description: def?.description,
					parameters: def?.parameters,
					source: `${group}/extension.ts`,
				});
			},
			on() {
				// no-op — we don't drive the lifecycle in this test
			},
		};
		factory(pi);
	}

	assert.ok(captured.length >= 13, `expected at least 13 tools registered, got ${captured.length}`);
});

/** Walk a TypeBox / JSON Schema tree and collect every `description` string with a path. */
function collectAllDescriptions(
	schema: any,
	p: string = "$",
	out: Array<{ path: string; text: string }> = [],
): Array<{ path: string; text: string }> {
	if (!schema || typeof schema !== "object") return out;
	if (typeof schema.description === "string") {
		out.push({ path: p, text: schema.description });
	}
	if (schema.properties && typeof schema.properties === "object") {
		for (const [k, v] of Object.entries(schema.properties)) {
			collectAllDescriptions(v, `${p}.properties.${k}`, out);
		}
	}
	if (schema.items) {
		if (Array.isArray(schema.items)) {
			schema.items.forEach((it: any, i: number) =>
				collectAllDescriptions(it, `${p}.items[${i}]`, out),
			);
		} else {
			collectAllDescriptions(schema.items, `${p}.items`, out);
		}
	}
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const arr = schema[key];
		if (Array.isArray(arr)) {
			arr.forEach((sub: any, i: number) =>
				collectAllDescriptions(sub, `${p}.${key}[${i}]`, out),
			);
		}
	}
	if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
		collectAllDescriptions(schema.additionalProperties, `${p}.additionalProperties`, out);
	}
	if (schema.patternProperties && typeof schema.patternProperties === "object") {
		for (const [k, v] of Object.entries(schema.patternProperties)) {
			collectAllDescriptions(v, `${p}.patternProperties[${k}]`, out);
		}
	}
	return out;
}

describe("tool description budget", () => {
	it("every registered tool has description.length <= 150", () => {
		const violations: string[] = [];
		for (const t of captured) {
			const d = t.description ?? "";
			if (d.length > TOOL_DESC_MAX) {
				violations.push(
					`  ${t.source} :: ${t.name} — ${d.length} chars (max ${TOOL_DESC_MAX})\n    ${JSON.stringify(d.slice(0, 200))}`,
				);
			}
		}
		assert.equal(
			violations.length,
			0,
			`${violations.length} tool description(s) exceed ${TOOL_DESC_MAX} chars:\n${violations.join("\n")}`,
		);
	});

	it("every tool has a non-empty description", () => {
		for (const t of captured) {
			assert.ok(
				typeof t.description === "string" && t.description.length > 0,
				`tool ${t.source}::${t.name} is missing a description`,
			);
		}
	});

	it("every parameter description is <= 80 chars (recursive)", () => {
		const violations: string[] = [];
		for (const t of captured) {
			const descs = collectAllDescriptions(t.parameters);
			for (const d of descs) {
				if (d.text.length > PARAM_DESC_MAX) {
					violations.push(
						`  ${t.source} :: ${t.name} ${d.path} — ${d.text.length} chars (max ${PARAM_DESC_MAX})\n    ${JSON.stringify(d.text.slice(0, 200))}`,
					);
				}
			}
		}
		assert.equal(
			violations.length,
			0,
			`${violations.length} parameter description(s) exceed ${PARAM_DESC_MAX} chars:\n${violations.join("\n")}`,
		);
	});

	it("records on-wire tools[] JSON byte size for visibility", () => {
		// Decoration only — never asserts a number, just prints. Helps catch
		// future bloat at PR review time.
		const onWire = captured.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));
		const bytes = JSON.stringify(onWire).length;
		// eslint-disable-next-line no-console
		console.log(
			`[tool-description-budget] ${captured.length} tools, JSON.stringify(tools).length = ${bytes} bytes`,
		);
		// Sanity: the tightened tree should comfortably fit under 50 KB. If this
		// ever fails the tightening regressed badly enough that a hard cap helps.
		assert.ok(bytes < 50_000, `tools[] JSON exceeds 50KB sanity cap: ${bytes}`);
	});
});

describe("buildMetaToolDescription budget", () => {
	function makeOps(n: number): McpToolDef[] {
		const longName = "very_long_operation_name_with_many_words_indeed";
		const ops: McpToolDef[] = [];
		for (let i = 0; i < n; i++) {
			ops.push({
				name: `${longName}_${i}`,
				description: `Operation ${i}`,
				inputSchema: { type: "object", properties: {} },
			});
		}
		return ops;
	}

	it("returns <= 150 chars even for 50 long-named ops", () => {
		const out = buildMetaToolDescription("playwright", makeOps(50), "mcp-tool-docs/playwright.md");
		assert.ok(
			out.length <= TOOL_DESC_MAX,
			`description is ${out.length} chars (max ${TOOL_DESC_MAX}): ${JSON.stringify(out)}`,
		);
	});

	it("does NOT inline a comma-separated op enumeration > 80 chars", () => {
		const ops = makeOps(50);
		const out = buildMetaToolDescription("playwright", ops, "mcp-tool-docs/playwright.md");

		// Look for any comma-joined run of identifier-like tokens. The longest
		// such run must be ≤ 80 chars; otherwise the description is pasting op
		// names back in.
		const enumRuns = out.match(/[A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*){2,}/g) ?? [];
		const longest = enumRuns.reduce((m, s) => Math.max(m, s.length), 0);
		assert.ok(
			longest <= 80,
			`buildMetaToolDescription appears to inline an op-name enumeration ` +
				`(${longest} chars). Output: ${JSON.stringify(out)}`,
		);
		// Also assert no individual op name we synthesised is present — the
		// design contract is that op detail lives off-wire.
		assert.ok(
			!out.includes(ops[0].name),
			`op name leaked into description: ${JSON.stringify(out)}`,
		);
	});

	it("handles 0 / 1 op edge cases without exceeding budget", () => {
		const zero = buildMetaToolDescription("playwright", [], "mcp-tool-docs/playwright.md");
		const one = buildMetaToolDescription("playwright", makeOps(1), "mcp-tool-docs/playwright.md");
		assert.ok(zero.length <= TOOL_DESC_MAX);
		assert.ok(one.length <= TOOL_DESC_MAX);
	});
});
