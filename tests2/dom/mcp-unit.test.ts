import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/mcp-unit.spec.ts (v2-dom tier).
// The legacy spec INLINED a copy of jsonSchemaToTypeBox; per the porting guide we
// import the REAL exported function from src instead (higher fidelity) and assert
// the identical string-conversion facts.
import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeBox } from "../../src/server/agent/tool-activation.js";

describe("jsonSchemaToTypeBox", () => {
	it("converts string type", () => {
		expect(jsonSchemaToTypeBox({ type: "string" })).toBe("Type.String()");
	});

	it("converts number type", () => {
		expect(jsonSchemaToTypeBox({ type: "number" })).toBe("Type.Number()");
	});

	it("converts integer type to Number", () => {
		expect(jsonSchemaToTypeBox({ type: "integer" })).toBe("Type.Number()");
	});

	it("converts boolean type", () => {
		expect(jsonSchemaToTypeBox({ type: "boolean" })).toBe("Type.Boolean()");
	});

	it("converts array type with items", () => {
		expect(jsonSchemaToTypeBox({ type: "array", items: { type: "string" } })).toBe(
			"Type.Array(Type.String())",
		);
	});

	it("converts array type without items", () => {
		expect(jsonSchemaToTypeBox({ type: "array" })).toBe("Type.Array(Type.Any())");
	});

	it("converts object type with properties and required", () => {
		const schema = {
			type: "object",
			properties: { name: { type: "string" }, age: { type: "number" } },
			required: ["name"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"name": Type.String()');
		expect(result).toContain('"age": Type.Optional(Type.Number())');
		expect(result).toMatch(/^Type\.Object\(/);
	});

	it("converts object type without properties returns Any", () => {
		expect(jsonSchemaToTypeBox({ type: "object" })).toBe("Type.Any()");
	});

	it("converts enum values", () => {
		expect(jsonSchemaToTypeBox({ enum: ["a", "b", "c"] })).toBe(
			'Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")])',
		);
	});

	it("converts numeric enum values", () => {
		expect(jsonSchemaToTypeBox({ enum: [1, 2, 3] })).toBe(
			"Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])",
		);
	});

	it("handles null schema", () => {
		expect(jsonSchemaToTypeBox(null as any)).toBe("Type.Any()");
	});

	it("handles undefined schema", () => {
		expect(jsonSchemaToTypeBox(undefined as any)).toBe("Type.Any()");
	});

	it("handles unknown type", () => {
		expect(jsonSchemaToTypeBox({ type: "unknown" })).toBe("Type.Any()");
	});

	it("handles missing type field", () => {
		expect(jsonSchemaToTypeBox({})).toBe("Type.Any()");
	});

	it("handles nested objects", () => {
		const schema = {
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: { host: { type: "string" }, port: { type: "number" } },
					required: ["host"],
				},
			},
			required: ["config"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain("Type.Object(");
		expect(result).toContain('"host": Type.String()');
		expect(result).toContain('"port": Type.Optional(Type.Number())');
	});

	it("handles nested arrays", () => {
		const schema = { type: "array", items: { type: "array", items: { type: "number" } } };
		expect(jsonSchemaToTypeBox(schema)).toBe("Type.Array(Type.Array(Type.Number()))");
	});

	it("handles array of objects", () => {
		const schema = {
			type: "array",
			items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
		};
		expect(jsonSchemaToTypeBox(schema)).toBe('Type.Array(Type.Object({"id": Type.Number()}))');
	});

	it("handles object with all required fields", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["a", "b"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"a": Type.String()');
		expect(result).toContain('"b": Type.Number()');
		expect(result).not.toContain("Type.Optional");
	});

	it("handles object with no required fields", () => {
		const schema = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"a": Type.Optional(Type.String())');
		expect(result).toContain('"b": Type.Optional(Type.Number())');
	});

	it("enum takes precedence over type", () => {
		expect(jsonSchemaToTypeBox({ type: "string", enum: ["x", "y"] })).toBe(
			'Type.Union([Type.Literal("x"), Type.Literal("y")])',
		);
	});

	it("handles mixed enum values", () => {
		expect(jsonSchemaToTypeBox({ enum: ["a", 1, true, null] })).toBe(
			'Type.Union([Type.Literal("a"), Type.Literal(1), Type.Literal(true), Type.Literal(null)])',
		);
	});
});
