/**
 * Unit tests for buildMetaToolInputSchema(), buildMetaToolDescription(),
 * and isValidOperationSchema() in mcp-meta.ts.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const { buildMetaToolInputSchema, buildMetaToolDescription, isValidOperationSchema } =
	await import("../src/server/mcp/mcp-meta.ts");

type McpToolDef = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
};

const validOp = (name: string, props: Record<string, unknown> = {}): McpToolDef => ({
	name,
	inputSchema: { type: "object", properties: props },
});

// Silence the [mcp] warnings emitted by isValidOperationSchema during tests.
let warnSpy: { calls: unknown[][] };
const originalWarn = console.warn;
beforeEach(() => {
	warnSpy = { calls: [] };
	console.warn = (...args: unknown[]) => {
		warnSpy.calls.push(args);
	};
});
afterEach(() => {
	console.warn = originalWarn;
});

describe("isValidOperationSchema", () => {
	it("accepts well-formed object schema with properties", () => {
		assert.equal(isValidOperationSchema(validOp("foo", { a: { type: "string" } })), true);
		assert.equal(warnSpy.calls.length, 0);
	});

	it("accepts object schema with no properties", () => {
		assert.equal(isValidOperationSchema({ name: "foo", inputSchema: { type: "object" } }), true);
	});

	it("rejects missing inputSchema", () => {
		assert.equal(isValidOperationSchema({ name: "foo" } as unknown as McpToolDef), false);
		assert.ok(warnSpy.calls.length === 1);
	});

	it("rejects type !== object", () => {
		assert.equal(
			isValidOperationSchema({ name: "foo", inputSchema: { type: "array" } }),
			false,
		);
	});

	it("rejects non-plain-object properties", () => {
		assert.equal(
			isValidOperationSchema({ name: "foo", inputSchema: { type: "object", properties: [] } }),
			false,
		);
		assert.equal(
			isValidOperationSchema({
				name: "foo",
				inputSchema: { type: "object", properties: null },
			}),
			false,
		);
	});

	it("rejects empty / missing name", () => {
		assert.equal(isValidOperationSchema({ name: "", inputSchema: { type: "object" } }), false);
		assert.equal(
			isValidOperationSchema({ inputSchema: { type: "object" } } as unknown as McpToolDef),
			false,
		);
	});
});

describe("buildMetaToolInputSchema", () => {
	it("3 valid ops produce enum of 3 strings, ordered as input", () => {
		const ops = [validOp("alpha"), validOp("beta"), validOp("gamma")];
		const schema = buildMetaToolInputSchema(ops);
		assert.equal(schema.type, "object");
		assert.deepEqual(schema.required, ["operation", "args"]);
		const props = schema.properties as Record<string, { type: string; enum?: string[] }>;
		assert.deepEqual(props.operation.enum, ["alpha", "beta", "gamma"]);
		assert.equal(props.args.type, "object");
	});

	it("filters out invalid ops; only valid ones land in enum", () => {
		const ops: McpToolDef[] = [
			validOp("good1"),
			{ name: "bad-no-type", inputSchema: { properties: {} } },
			validOp("good2"),
			{ name: "bad-array-props", inputSchema: { type: "object", properties: [] as unknown as Record<string, unknown> } },
			validOp("good3"),
		];
		const schema = buildMetaToolInputSchema(ops);
		const props = schema.properties as Record<string, { enum?: string[] }>;
		assert.deepEqual(props.operation.enum, ["good1", "good2", "good3"]);
		// Two warnings logged.
		assert.ok(warnSpy.calls.length >= 2);
	});

	it("empty input → __unavailable__ stub enum", () => {
		const schema = buildMetaToolInputSchema([]);
		const props = schema.properties as Record<string, { enum?: string[] }>;
		assert.deepEqual(props.operation.enum, ["__unavailable__"]);
	});

	it("all-invalid → __unavailable__ stub enum", () => {
		const ops: McpToolDef[] = [
			{ name: "x", inputSchema: { type: "string" } },
			{ name: "", inputSchema: { type: "object" } },
		];
		const schema = buildMetaToolInputSchema(ops);
		const props = schema.properties as Record<string, { enum?: string[] }>;
		assert.deepEqual(props.operation.enum, ["__unavailable__"]);
	});
});

describe("buildMetaToolDescription", () => {
	it("emits single short line with server, op count, and docs path", () => {
		const ops = [validOp("get-direct-reports"), validOp("list-employees"), validOp("get-entity-by-ref")];
		const desc = buildMetaToolDescription("gr-halo", ops, "tool-docs/mcp-gr-halo.md");
		assert.ok(desc.length <= 150, `length was ${desc.length}: ${desc}`);
		assert.ok(desc.includes("gr-halo"));
		assert.ok(desc.includes("3 operations"));
		assert.ok(desc.includes("tool-docs/mcp-gr-halo.md"));
		// Op names must NOT be inlined.
		assert.ok(!desc.includes("get-direct-reports"));
		assert.ok(!desc.includes("list-employees"));
	});

	it("stays under 150 chars even with 100 ops, no op-name enumeration", () => {
		const ops = Array.from({ length: 100 }, (_, i) => validOp(`operation_with_a_long_name_${i}`));
		const desc = buildMetaToolDescription("big-server", ops, "tool-docs/mcp-big-server.md");
		assert.ok(desc.length <= 150, `length was ${desc.length}: ${desc}`);
		assert.ok(desc.includes("big-server"));
		assert.ok(desc.includes("100 operations"));
		assert.ok(!/\.\.\. \(\d+ more\)/.test(desc), `should not contain "... (N more)": ${desc}`);
		assert.ok(!desc.includes("operation_with_a_long_name_0"));
	});

	it("handles zero valid ops gracefully", () => {
		const desc = buildMetaToolDescription("empty", [], "tool-docs/mcp-empty.md");
		assert.ok(desc.length <= 150);
		assert.ok(desc.includes("empty"));
		assert.ok(desc.includes("No operations available"));
		assert.ok(desc.includes("tool-docs/mcp-empty.md"));
	});

	it("uses singular form for exactly one op", () => {
		const desc = buildMetaToolDescription("solo", [validOp("only")], "tool-docs/mcp-solo.md");
		assert.ok(desc.includes("1 operation."));
		assert.ok(!desc.includes("1 operations"));
		assert.ok(!desc.includes("only"), "op name must not be inlined");
	});

	it("counts only valid ops (filters invalid)", () => {
		const ops: McpToolDef[] = [
			validOp("alpha"),
			{ name: "bogus", inputSchema: { type: "string" } },
			validOp("beta"),
		];
		const desc = buildMetaToolDescription("srv", ops, "tool-docs/mcp-srv.md");
		assert.ok(desc.includes("2 operations"));
		assert.ok(!desc.includes("alpha"));
		assert.ok(!desc.includes("beta"));
		assert.ok(!desc.includes("bogus"));
	});
});
