import { describe, expect, it } from "vitest";
import {
	MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_VALUES,
	isExtensionSettingValue,
	isValidExtensionSettingValue,
	normalizeDurableMultiEnumValue,
	normalizeExtensionSettingsSchema,
	normalizeMultiEnumValue,
	reconcileExtensionSettingsValues,
} from "../../src/server/agent/extension-settings-schema.js";

describe("extension settings schema", () => {
	it("normalizes and validates every supported flat field kind", () => {
		const normalized = normalizeExtensionSettingsSchema({
			endpoint: { type: "string", default: "https://service.example" },
			credential: { type: "secret", optional: true },
			mode: { type: "enum", values: ["safe", "fast"], default: "safe" },
			languages: { type: "multi-enum", values: ["typescript", "python", "rust"], optional: true, default: ["typescript", "python"] },
			enabled: { type: "boolean", default: true },
			limit: { type: "number", min: 1, max: 10, default: 5 },
		}, { requiresConfig: ["endpoint", "credential"] });

		expect(normalized.diagnostic).toBeUndefined();
		expect(normalized.schema).toEqual({
			fields: [
				{ key: "endpoint", type: "string", default: "https://service.example" },
				{ key: "credential", type: "secret", optional: true },
				{ key: "mode", type: "enum", values: ["safe", "fast"], default: "safe" },
				{ key: "languages", type: "multi-enum", values: ["typescript", "python", "rust"], optional: true, default: ["python", "typescript"] },
				{ key: "enabled", type: "boolean", default: true },
				{ key: "limit", type: "number", min: 1, max: 10, default: 5 },
			],
			requiresConfig: ["endpoint", "credential"],
		});

		const fields = normalized.schema!.fields;
		expect(isValidExtensionSettingValue(fields[0], "")).toBe(true);
		expect(isValidExtensionSettingValue(fields[0], false)).toBe(false);
		expect(isValidExtensionSettingValue(fields[1], "runtime-only")).toBe(true);
		expect(isValidExtensionSettingValue(fields[2], "fast")).toBe(true);
		expect(isValidExtensionSettingValue(fields[2], "other")).toBe(false);
		expect(isValidExtensionSettingValue(fields[3], ["typescript", "python"])).toBe(true);
		expect(isValidExtensionSettingValue(fields[3], [])).toBe(true);
		expect(isValidExtensionSettingValue(fields[3], ["other"])).toBe(false);
		expect(isValidExtensionSettingValue(fields[4], false)).toBe(true);
		expect(isValidExtensionSettingValue(fields[4], "false")).toBe(false);
		expect(isValidExtensionSettingValue(fields[5], 10)).toBe(true);
		expect(isValidExtensionSettingValue(fields[5], 11)).toBe(false);
	});

	it("reconciles only own values for prototype-named fields", () => {
		const definitions = [
			{ key: "constructor", type: "string" as const },
			{ key: "toString", type: "number" as const },
			{ key: "credential", type: "secret" as const },
		];
		const inheritedValues = Object.create({
			constructor: "inherited",
			toString: 7,
			credential: "inherited-secret",
		}) as Record<string, unknown>;

		expect(reconcileExtensionSettingsValues(definitions, inheritedValues)).toEqual({
			values: {},
			invalidKeys: [],
		});

		const ownValues: Record<string, unknown> = {
			constructor: "configured",
			toString: 9,
			credential: "runtime-secret",
		};
		const publicResult = reconcileExtensionSettingsValues(definitions, ownValues);
		expect(publicResult).toEqual({
			values: { constructor: "configured", toString: 9 },
			invalidKeys: [],
		});
		expect(Object.getPrototypeOf(publicResult.values)).toBeNull();
		expect(reconcileExtensionSettingsValues(definitions, ownValues, { includeSecrets: true })).toEqual({
			values: { constructor: "configured", toString: 9, credential: "runtime-secret" },
			invalidKeys: [],
		});
	});

	it("normalizes multi-enum selections without retaining caller arrays", () => {
		const declaredValues = ["typescript", "python", "rust"];
		const selected = ["typescript", "python"];
		const normalized = normalizeExtensionSettingsSchema({
			languages: { type: "multi-enum", values: declaredValues, optional: true, default: selected },
		}).schema!;
		const definition = normalized.fields[0];

		expect(definition.default).toEqual(["python", "typescript"]);
		expect(definition.default).not.toBe(selected);
		selected.push("rust");
		declaredValues.push("go");
		expect(definition.default).toEqual(["python", "typescript"]);
		expect(definition.values).toEqual(["typescript", "python", "rust"]);

		const runtimeInput = ["rust", "python"];
		const runtimeValue = normalizeMultiEnumValue(definition, runtimeInput)!;
		expect(runtimeValue).toEqual(["python", "rust"]);
		expect(runtimeValue).not.toBe(runtimeInput);
		runtimeInput[0] = "typescript";
		expect(runtimeValue).toEqual(["python", "rust"]);

		const reconciled = reconcileExtensionSettingsValues([definition], { languages: ["typescript", "python"] });
		expect(reconciled).toEqual({ values: { languages: ["python", "typescript"] }, invalidKeys: [] });
		const reconciledValue = reconciled.values.languages as string[];
		reconciledValue.push("rust");
		expect(reconcileExtensionSettingsValues([definition], { languages: ["typescript", "python"] }).values.languages).toEqual(["python", "typescript"]);
	});

	it("rejects malformed, non-allowlisted, and required-empty selected sets", () => {
		const optional = normalizeExtensionSettingsSchema({
			languages: { type: "multi-enum", values: ["typescript", "python"], optional: true },
		}).schema!.fields[0];
		const required = normalizeExtensionSettingsSchema({
			languages: { type: "multi-enum", values: ["typescript", "python"] },
		}).schema!.fields[0];

		for (const value of [
			"typescript",
			new Set(["typescript"]),
			{ 0: "typescript" },
			[["typescript"]],
			["typescript", "typescript"],
			["missing"],
			["\ud800"],
			["x".repeat(257)],
			Array.from({ length: MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_VALUES + 1 }, (_, index) => `option-${index}`),
		]) expect(normalizeMultiEnumValue(optional, value)).toBeUndefined();

		expect(normalizeMultiEnumValue(optional, [])).toEqual([]);
		expect(normalizeMultiEnumValue(required, [])).toBeUndefined();
		expect(isValidExtensionSettingValue(required, [])).toBe(false);
		expect(reconcileExtensionSettingsValues([required], { languages: [] })).toEqual({ values: {}, invalidKeys: ["languages"] });
	});

	it("keeps generic durable selected-set validation bounded and clone-safe", () => {
		const input = ["typescript", "python"];
		const normalized = normalizeDurableMultiEnumValue(input)!;
		expect(normalized).toEqual(["python", "typescript"]);
		expect(normalized).not.toBe(input);
		expect(isExtensionSettingValue(input)).toBe(true);
		expect(isExtensionSettingValue(["python", "python"])).toBe(false);
		expect(isExtensionSettingValue(["\ud800"])).toBe(false);
		expect(isExtensionSettingValue(["x".repeat(257)])).toBe(false);
	});

	it("fails closed for malformed descriptors and hook-style requiresConfig metadata", () => {
		const invalidCases: Array<[unknown, unknown]> = [
			[{ endpoint: { type: "string", extra: true } }, undefined],
			[{ credential: { type: "secret", default: "not-allowed" } }, undefined],
			[{ mode: { type: "enum", values: ["same", "same"] } }, undefined],
			[{ languages: { type: "multi-enum" } }, undefined],
			[{ languages: { type: "multi-enum", values: ["typescript"], default: [] } }, undefined],
			[{ endpoint: { type: "string", values: ["not-allowed"] } }, undefined],
			[{ count: { type: "number", min: 4, max: 3 } }, undefined],
			[{ endpoint: { type: "string" } }, { requiresConfig: ["missing"] }],
			[{ endpoint: { type: "string" } }, { requiresConfig: ["endpoint", "endpoint"] }],
			[{ endpoint: { type: "string" } }, { unexpected: [] }],
		];

		for (const [config, activation] of invalidCases) {
			const normalized = normalizeExtensionSettingsSchema(config, activation);
			expect(normalized.schema).toBeUndefined();
			expect(normalized.diagnostic).toMatch(/field|activation|config/);
		}
	});
});
