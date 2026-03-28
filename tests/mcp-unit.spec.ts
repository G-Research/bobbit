import { test, expect } from "@playwright/test";

/**
 * Inline copy of jsonSchemaToTypeBox from src/server/agent/tool-activation.ts
 * for unit testing without TypeScript/ESM import issues.
 */
function jsonSchemaToTypeBox(schema: Record<string, unknown>): string {
	if (!schema || typeof schema !== "object") return "Type.Any()";

	// Handle enum
	const enumVals = schema.enum as unknown[] | undefined;
	if (enumVals && Array.isArray(enumVals)) {
		const literals = enumVals
			.map((v) => `Type.Literal(${JSON.stringify(v)})`)
			.join(", ");
		return `Type.Union([${literals}])`;
	}

	const type = schema.type as string | undefined;
	switch (type) {
		case "string":
			return "Type.String()";
		case "number":
			return "Type.Number()";
		case "integer":
			return "Type.Number()";
		case "boolean":
			return "Type.Boolean()";
		case "array": {
			const items = schema.items as Record<string, unknown> | undefined;
			return `Type.Array(${items ? jsonSchemaToTypeBox(items) : "Type.Any()"})`;
		}
		case "object": {
			const properties = schema.properties as
				| Record<string, Record<string, unknown>>
				| undefined;
			if (!properties) return "Type.Any()";
			const required = (schema.required as string[]) || [];
			const entries = Object.entries(properties).map(([key, propSchema]) => {
				const tb = jsonSchemaToTypeBox(propSchema);
				const isRequired = required.includes(key);
				return `${JSON.stringify(key)}: ${isRequired ? tb : `Type.Optional(${tb})`}`;
			});
			return `Type.Object({${entries.join(", ")}})`;
		}
		default:
			return "Type.Any()";
	}
}

test.describe("jsonSchemaToTypeBox", () => {
	test("converts string type", () => {
		expect(jsonSchemaToTypeBox({ type: "string" })).toBe("Type.String()");
	});

	test("converts number type", () => {
		expect(jsonSchemaToTypeBox({ type: "number" })).toBe("Type.Number()");
	});

	test("converts integer type to Number", () => {
		expect(jsonSchemaToTypeBox({ type: "integer" })).toBe("Type.Number()");
	});

	test("converts boolean type", () => {
		expect(jsonSchemaToTypeBox({ type: "boolean" })).toBe("Type.Boolean()");
	});

	test("converts array type with items", () => {
		expect(
			jsonSchemaToTypeBox({ type: "array", items: { type: "string" } }),
		).toBe("Type.Array(Type.String())");
	});

	test("converts array type without items", () => {
		expect(jsonSchemaToTypeBox({ type: "array" })).toBe(
			"Type.Array(Type.Any())",
		);
	});

	test("converts object type with properties and required", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				age: { type: "number" },
			},
			required: ["name"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"name": Type.String()');
		expect(result).toContain('"age": Type.Optional(Type.Number())');
		expect(result).toMatch(/^Type\.Object\(/);
	});

	test("converts object type without properties returns Any", () => {
		expect(jsonSchemaToTypeBox({ type: "object" })).toBe("Type.Any()");
	});

	test("converts enum values", () => {
		const result = jsonSchemaToTypeBox({ enum: ["a", "b", "c"] });
		expect(result).toBe(
			'Type.Union([Type.Literal("a"), Type.Literal("b"), Type.Literal("c")])',
		);
	});

	test("converts numeric enum values", () => {
		const result = jsonSchemaToTypeBox({ enum: [1, 2, 3] });
		expect(result).toBe(
			"Type.Union([Type.Literal(1), Type.Literal(2), Type.Literal(3)])",
		);
	});

	test("handles null schema", () => {
		expect(jsonSchemaToTypeBox(null as any)).toBe("Type.Any()");
	});

	test("handles undefined schema", () => {
		expect(jsonSchemaToTypeBox(undefined as any)).toBe("Type.Any()");
	});

	test("handles unknown type", () => {
		expect(jsonSchemaToTypeBox({ type: "unknown" })).toBe("Type.Any()");
	});

	test("handles missing type field", () => {
		expect(jsonSchemaToTypeBox({})).toBe("Type.Any()");
	});

	test("handles nested objects", () => {
		const schema = {
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: {
						host: { type: "string" },
						port: { type: "number" },
					},
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

	test("handles nested arrays", () => {
		const schema = {
			type: "array",
			items: {
				type: "array",
				items: { type: "number" },
			},
		};
		expect(jsonSchemaToTypeBox(schema)).toBe(
			"Type.Array(Type.Array(Type.Number()))",
		);
	});

	test("handles array of objects", () => {
		const schema = {
			type: "array",
			items: {
				type: "object",
				properties: {
					id: { type: "number" },
				},
				required: ["id"],
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBe(
			'Type.Array(Type.Object({"id": Type.Number()}))',
		);
	});

	test("handles object with all required fields", () => {
		const schema = {
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
			required: ["a", "b"],
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"a": Type.String()');
		expect(result).toContain('"b": Type.Number()');
		// Neither should be Optional
		expect(result).not.toContain("Type.Optional");
	});

	test("handles object with no required fields", () => {
		const schema = {
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
		};
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toContain('"a": Type.Optional(Type.String())');
		expect(result).toContain('"b": Type.Optional(Type.Number())');
	});

	test("enum takes precedence over type", () => {
		const schema = { type: "string", enum: ["x", "y"] };
		const result = jsonSchemaToTypeBox(schema);
		expect(result).toBe(
			'Type.Union([Type.Literal("x"), Type.Literal("y")])',
		);
	});

	test("handles mixed enum values", () => {
		const result = jsonSchemaToTypeBox({ enum: ["a", 1, true, null] });
		expect(result).toBe(
			'Type.Union([Type.Literal("a"), Type.Literal(1), Type.Literal(true), Type.Literal(null)])',
		);
	});
});
