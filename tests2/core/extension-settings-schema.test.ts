import { describe, expect, it } from "vitest";
import {
	isValidExtensionSettingValue,
	normalizeExtensionSettingsSchema,
	reconcileExtensionSettingsValues,
} from "../../src/server/agent/extension-settings-schema.js";

describe("extension settings schema", () => {
	it("normalizes and validates every supported flat field kind", () => {
		const normalized = normalizeExtensionSettingsSchema({
			endpoint: { type: "string", default: "https://service.example" },
			credential: { type: "secret", optional: true },
			mode: { type: "enum", values: ["safe", "fast"], default: "safe" },
			enabled: { type: "boolean", default: true },
			limit: { type: "number", min: 1, max: 10, default: 5 },
		}, { requiresConfig: ["endpoint", "credential"] });

		expect(normalized.diagnostic).toBeUndefined();
		expect(normalized.schema).toEqual({
			fields: [
				{ key: "endpoint", type: "string", default: "https://service.example" },
				{ key: "credential", type: "secret", optional: true },
				{ key: "mode", type: "enum", values: ["safe", "fast"], default: "safe" },
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
		expect(isValidExtensionSettingValue(fields[3], false)).toBe(true);
		expect(isValidExtensionSettingValue(fields[3], "false")).toBe(false);
		expect(isValidExtensionSettingValue(fields[4], 10)).toBe(true);
		expect(isValidExtensionSettingValue(fields[4], 11)).toBe(false);
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

	it("fails closed for malformed descriptors and hook-style requiresConfig metadata", () => {
		const invalidCases: Array<[unknown, unknown]> = [
			[{ endpoint: { type: "string", extra: true } }, undefined],
			[{ credential: { type: "secret", default: "not-allowed" } }, undefined],
			[{ mode: { type: "enum", values: ["same", "same"] } }, undefined],
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
