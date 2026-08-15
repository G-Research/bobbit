/**
 * Strict, flat schema-2 extension-settings declarations.
 *
 * This module deliberately has no persistence or secret-store dependency: it
 * normalizes pack-owned declarations and validates public setting values.
 */

export type ExtensionSettingKind = "string" | "secret" | "enum" | "multi-enum" | "boolean" | "number";
export type ExtensionSettingScalar = string | boolean | number;
export type ExtensionSettingValue = ExtensionSettingScalar | string[];

export interface ExtensionSettingDefinition {
	key: string;
	type: ExtensionSettingKind;
	label?: string;
	description?: string;
	optional?: boolean;
	default?: ExtensionSettingValue;
	values?: string[];
	min?: number;
	max?: number;
}

export interface ExtensionSettingsSchema {
	fields: ExtensionSettingDefinition[];
	requiresConfig: string[];
}

export type ExtensionSettingsTargetKind = "provider" | "hook" | "runtime";
export interface ExtensionSettingsTargetRef {
	packId: string;
	kind: ExtensionSettingsTargetKind;
	id: string;
}

export interface ExtensionSettingsSchemaNormalization {
	schema?: ExtensionSettingsSchema;
	diagnostic?: string;
}

/** A declaration-aware, value-safe view of an effective settings record.
 * `values` intentionally excludes secret bytes by default, while `invalidKeys`
 * includes invalid secrets when callers opt into runtime-only reconciliation. */
export interface ExtensionSettingsValueReconciliation {
	values: Record<string, ExtensionSettingValue>;
	invalidKeys: string[];
}

/**
 * Retain only values declared by the current normalized schema. This is a
 * read-time compatibility boundary: old/removed fields are ignored and values
 * that no longer match an evolved descriptor are reported without modifying
 * durable state. Runtime callers may include secrets; public callers must use
 * the default so a secret can never enter a response projection.
 */
export function reconcileExtensionSettingsValues(
	definitions: readonly ExtensionSettingDefinition[],
	effectiveValues: Readonly<Record<string, unknown>>,
	options: { includeSecrets?: boolean } = {},
): ExtensionSettingsValueReconciliation {
	const values: Record<string, ExtensionSettingValue> = Object.create(null) as Record<string, ExtensionSettingValue>;
	const invalidKeys: string[] = [];
	for (const definition of definitions) {
		// Settings records may be ordinary objects. Only own values were supplied;
		// never reconcile inherited Object.prototype members as field values.
		if (!Object.prototype.hasOwnProperty.call(effectiveValues, definition.key)) continue;
		const value = effectiveValues[definition.key];
		// Undefined is absent; optional/new fields remain absent until an operator
		// supplies a value or a valid declaration default fills it in upstream.
		if (value === undefined) continue;
		if (definition.type === "multi-enum") {
			const normalized = normalizeMultiEnumValue(definition, value);
			if (!normalized) {
				invalidKeys.push(definition.key);
				continue;
			}
			values[definition.key] = normalized;
			continue;
		}
		if (!isValidExtensionSettingValue(definition, value)) {
			invalidKeys.push(definition.key);
			continue;
		}
		if (definition.type !== "secret" || options.includeSecrets) values[definition.key] = value;
	}
	return { values, invalidKeys };
}

export const EXTENSION_SETTING_KEY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const MAX_EXTENSION_SETTINGS_FIELDS = 64;
export const MAX_EXTENSION_SETTING_LABEL_BYTES = 256;
export const MAX_EXTENSION_SETTING_DESCRIPTION_BYTES = 2_048;
export const MAX_EXTENSION_SETTING_STRING_BYTES = 4 * 1024;
export const MAX_EXTENSION_SETTING_SECRET_BYTES = 16 * 1024;
export const MAX_EXTENSION_SETTING_ENUM_VALUES = 128;
export const MAX_EXTENSION_SETTING_ENUM_VALUE_BYTES = 256;
export const MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_VALUES = 64;
export const MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_BYTES = 16 * 1024;
export const MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_VALUES_PER_TARGET = 256;
export const MAX_EXTENSION_SETTINGS_MULTI_ENUM_SELECTED_BYTES_PER_TARGET = 64 * 1024;

const SETTING_KINDS: ReadonlySet<ExtensionSettingKind> = new Set(["string", "secret", "enum", "multi-enum", "boolean", "number"]);
const DESCRIPTOR_KEYS = new Set(["key", "type", "label", "description", "optional", "default", "values", "min", "max"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

/** JavaScript accepts lone UTF-16 surrogates, but UTF-8 serialization replaces them. */
export function isWellFormedExtensionSettingsText(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			index++;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function isBoundedText(value: unknown, maxBytes: number, allowEmpty: boolean): value is string {
	return typeof value === "string"
		&& (allowEmpty || value.length > 0)
		&& isWellFormedExtensionSettingsText(value)
		&& Buffer.byteLength(value, "utf8") <= maxBytes;
}

/**
 * Validate and copy a selected set that came from durable storage. Declaration
 * membership and requiredness are deliberately checked by normalizeMultiEnumValue.
 */
export function normalizeDurableMultiEnumValue(value: unknown): string[] | undefined {
	if (!Array.isArray(value)
		|| value.length > MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_VALUES) return undefined;
	const seen = new Set<string>();
	let totalBytes = 0;
	for (const member of value) {
		if (!isBoundedText(member, MAX_EXTENSION_SETTING_ENUM_VALUE_BYTES, false) || seen.has(member)) return undefined;
		seen.add(member);
		totalBytes += Buffer.byteLength(member, "utf8");
		if (totalBytes > MAX_EXTENSION_SETTING_MULTI_ENUM_SELECTED_BYTES) return undefined;
	}
	return [...value].sort();
}

/**
 * Validate a selected set against a normalized multi-enum descriptor, returning
 * a fresh canonical array. The supplied value is never mutated or retained.
 */
export function normalizeMultiEnumValue(
	definition: ExtensionSettingDefinition,
	value: unknown,
	options: { allowEmpty?: boolean } = {},
): string[] | undefined {
	if (definition.type !== "multi-enum") return undefined;
	const normalized = normalizeDurableMultiEnumValue(value);
	if (!normalized) return undefined;
	// Required multi-enums may never be cleared. The optional option only makes
	// an already-optional descriptor explicit; it cannot relax requiredness.
	if (normalized.length === 0 && definition.optional !== true) return undefined;
	if (normalized.length === 0 && options.allowEmpty === false) return undefined;
	if (!definition.values || normalized.some(member => !definition.values!.includes(member))) return undefined;
	return normalized;
}

export function isExtensionSettingValue(value: unknown): value is ExtensionSettingValue {
	return typeof value === "string"
		|| typeof value === "boolean"
		|| (typeof value === "number" && Number.isFinite(value))
		|| normalizeDurableMultiEnumValue(value) !== undefined;
}

/** Validates a value after the field descriptor has already been normalized. */
export function isValidExtensionSettingValue(definition: ExtensionSettingDefinition, value: unknown): value is ExtensionSettingValue {
	switch (definition.type) {
		case "string":
			return isBoundedText(value, MAX_EXTENSION_SETTING_STRING_BYTES, true);
		case "secret":
			return isBoundedText(value, MAX_EXTENSION_SETTING_SECRET_BYTES, true);
		case "enum":
			return typeof value === "string" && definition.values?.includes(value) === true;
		case "multi-enum":
			return normalizeMultiEnumValue(definition, value) !== undefined;
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value)
				&& (definition.min === undefined || value >= definition.min)
				&& (definition.max === undefined || value <= definition.max);
	}
}

function invalid(diagnostic: string): ExtensionSettingsSchemaNormalization {
	return { diagnostic };
}

function normalizeField(key: string, raw: unknown): ExtensionSettingDefinition | string {
	if (!EXTENSION_SETTING_KEY_RE.test(key)) return `field key ${JSON.stringify(key)} is invalid`;
	if (!isPlainObject(raw)) return `field ${JSON.stringify(key)} must be a descriptor mapping`;
	for (const property of Object.keys(raw)) {
		if (!DESCRIPTOR_KEYS.has(property)) return `field ${JSON.stringify(key)} has unknown property ${JSON.stringify(property)}`;
	}
	if (raw.key !== undefined && raw.key !== key) return `field ${JSON.stringify(key)} has a mismatched key`;
	if (typeof raw.type !== "string" || !SETTING_KINDS.has(raw.type as ExtensionSettingKind)) {
		return `field ${JSON.stringify(key)} has an unsupported type`;
	}
	const type = raw.type as ExtensionSettingKind;
	const field: ExtensionSettingDefinition = { key, type };
	if (raw.label !== undefined) {
		if (!isBoundedText(raw.label, MAX_EXTENSION_SETTING_LABEL_BYTES, false)) return `field ${JSON.stringify(key)} has an invalid label`;
		field.label = raw.label;
	}
	if (raw.description !== undefined) {
		if (!isBoundedText(raw.description, MAX_EXTENSION_SETTING_DESCRIPTION_BYTES, false)) return `field ${JSON.stringify(key)} has an invalid description`;
		field.description = raw.description;
	}
	if (raw.optional !== undefined) {
		if (typeof raw.optional !== "boolean") return `field ${JSON.stringify(key)} optional must be boolean`;
		field.optional = raw.optional;
	}
	if (raw.min !== undefined || raw.max !== undefined) {
		if (type !== "number") return `field ${JSON.stringify(key)} min/max are only valid for number`;
		if (raw.min !== undefined && (typeof raw.min !== "number" || !Number.isFinite(raw.min))) return `field ${JSON.stringify(key)} min must be finite`;
		if (raw.max !== undefined && (typeof raw.max !== "number" || !Number.isFinite(raw.max))) return `field ${JSON.stringify(key)} max must be finite`;
		if (raw.min !== undefined && raw.max !== undefined && raw.min > raw.max) return `field ${JSON.stringify(key)} min must not exceed max`;
		if (raw.min !== undefined) field.min = raw.min as number;
		if (raw.max !== undefined) field.max = raw.max as number;
	}
	if (raw.values !== undefined) {
		if (type !== "enum" && type !== "multi-enum") return `field ${JSON.stringify(key)} values are only valid for enum or multi-enum`;
		if (!Array.isArray(raw.values) || raw.values.length === 0 || raw.values.length > MAX_EXTENSION_SETTING_ENUM_VALUES) return `field ${JSON.stringify(key)} enum values must be a bounded non-empty string array`;
		const values: string[] = [];
		const seen = new Set<string>();
		for (const value of raw.values) {
			if (!isBoundedText(value, MAX_EXTENSION_SETTING_ENUM_VALUE_BYTES, false) || seen.has(value)) return `field ${JSON.stringify(key)} enum values must be unique non-empty strings`;
			seen.add(value);
			values.push(value);
		}
		field.values = values;
	} else if (type === "enum" || type === "multi-enum") {
		return `field ${JSON.stringify(key)} ${type} requires values`;
	}
	if (raw.default !== undefined) {
		if (type === "secret") return `field ${JSON.stringify(key)} secret must not have a default`;
		if (type === "multi-enum") {
			const normalized = normalizeMultiEnumValue(field, raw.default);
			if (!normalized) return `field ${JSON.stringify(key)} has an invalid default`;
			field.default = normalized;
		} else {
			// Validate against the fully-normalized bounds and enum list.
			if (!isValidExtensionSettingValue(field, raw.default)) return `field ${JSON.stringify(key)} has an invalid default`;
			field.default = raw.default;
		}
	}
	return field;
}

/**
 * Normalize a flat `config:` descriptor map plus optional activation metadata.
 * The result never contains raw descriptors, so callers can safely treat a
 * missing `schema` as an invalid/unavailable declaration rather than trying to
 * partially interpret it.
 */
export function normalizeExtensionSettingsSchema(rawConfig: unknown, rawActivation?: unknown): ExtensionSettingsSchemaNormalization {
	if (!isPlainObject(rawConfig)) return invalid("config must be a mapping");
	const entries = Object.entries(rawConfig);
	if (entries.length > MAX_EXTENSION_SETTINGS_FIELDS) return invalid(`config exceeds ${MAX_EXTENSION_SETTINGS_FIELDS} fields`);
	const fields: ExtensionSettingDefinition[] = [];
	for (const [key, raw] of entries) {
		const field = normalizeField(key, raw);
		if (typeof field === "string") return invalid(field);
		fields.push(field);
	}

	const requiresConfig: string[] = [];
	if (rawActivation !== undefined) {
		if (!isPlainObject(rawActivation)) return invalid("activation must be a mapping");
		for (const key of Object.keys(rawActivation)) {
			if (key !== "requiresConfig") return invalid(`activation has unknown property ${JSON.stringify(key)}`);
		}
		if (rawActivation.requiresConfig !== undefined) {
			if (!Array.isArray(rawActivation.requiresConfig)) return invalid("activation.requiresConfig must be an array");
			const declared = new Set(fields.map(field => field.key));
			const seen = new Set<string>();
			for (const key of rawActivation.requiresConfig) {
				if (typeof key !== "string" || !EXTENSION_SETTING_KEY_RE.test(key) || !declared.has(key) || seen.has(key)) {
					return invalid("activation.requiresConfig must contain unique declared field keys");
				}
				seen.add(key);
				requiresConfig.push(key);
			}
		}
	}
	return { schema: { fields, requiresConfig } };
}

/** Stable storage/secret identity. Callers must only pass server-resolved refs. */
export function extensionSettingsTargetKey(ref: ExtensionSettingsTargetRef): string {
	return `${ref.packId}\u0000${ref.kind}\u0000${ref.id}`;
}
