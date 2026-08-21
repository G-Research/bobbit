import {
	normalizeGrantPolicy,
	validateModelString,
	validateThinkingLevel,
	type GrantPolicy,
	type Role,
} from "./role-store.js";

const ROLE_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const GRANT_POLICIES = new Set(["allow", "ask", "never", "always-allow", "ask-once", "always-ask", "never-ask"]);

export type InlineRoleValidationResult =
	| { ok: true; roles: Record<string, Role> | undefined }
	| { ok: false; message: string };

export type PersistedInlineRoleValidationResult =
	| { ok: true }
	| { ok: false; message: string };

function plainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Validate the historical persisted-goal role contract without changing its values.
 *
 * Persisted goals may contain model IDs, thinking levels, and tool policies that
 * predate today's candidate allow-lists. Goal loading must retain those snapshots;
 * only newly submitted candidate roles use the stricter validator below.
 */
export function validatePersistedInlineRoles(value: unknown): PersistedInlineRoleValidationResult {
	if (!plainRecord(value)) return { ok: false, message: "inlineRoles must be an object" };
	for (const [key, raw] of Object.entries(value)) {
		if (!plainRecord(raw)
			|| typeof raw.name !== "string"
			|| raw.name !== key
			|| typeof raw.label !== "string"
			|| typeof raw.promptTemplate !== "string") {
			return { ok: false, message: `Inline role "${key}" must have matching name, label, and promptTemplate` };
		}
		for (const field of ["accessory", "model", "thinkingLevel"] as const) {
			if (raw[field] !== undefined && typeof raw[field] !== "string") {
				return { ok: false, message: `Inline role "${key}" ${field} must be a string` };
			}
		}
		for (const field of ["createdAt", "updatedAt"] as const) {
			if (raw[field] !== undefined && (typeof raw[field] !== "number" || !Number.isFinite(raw[field]))) {
				return { ok: false, message: `Inline role "${key}" ${field} must be finite` };
			}
		}
		if (raw.toolPolicies !== undefined) {
			if (!plainRecord(raw.toolPolicies) || Object.values(raw.toolPolicies).some(policy => typeof policy !== "string")) {
				return { ok: false, message: `Inline role "${key}" toolPolicies must be an object with string values` };
			}
		}
	}
	return { ok: true };
}

/** Validate and snapshot new ephemeral roles without consulting or mutating a role store. */
export function validateInlineRoles(value: unknown): InlineRoleValidationResult {
	if (value === undefined || value === null) return { ok: true, roles: undefined };
	if (!plainRecord(value)) return { ok: false, message: "inlineRoles must be a plain object" };
	const roles: Record<string, Role> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (!ROLE_NAME.test(key)) return { ok: false, message: `Inline role name "${key}" must be lowercase alphanumeric + hyphens` };
		if (!plainRecord(raw)) return { ok: false, message: `Inline role "${key}" must be an object` };
		if (raw.name !== key) return { ok: false, message: `Inline role "${key}" must have a matching name` };
		if (typeof raw.label !== "string" || !raw.label.trim()) return { ok: false, message: `Inline role "${key}" must have a non-empty label` };
		if (typeof raw.promptTemplate !== "string" || !raw.promptTemplate.trim()) return { ok: false, message: `Inline role "${key}" must have a non-empty promptTemplate` };
		if (raw.accessory !== undefined && typeof raw.accessory !== "string") return { ok: false, message: `Inline role "${key}" accessory must be a string` };
		for (const field of ["createdAt", "updatedAt"] as const) {
			if (raw[field] !== undefined && (typeof raw[field] !== "number" || !Number.isFinite(raw[field]))) return { ok: false, message: `Inline role "${key}" ${field} must be finite` };
		}
		const model = raw.model === undefined ? undefined : validateModelString(raw.model);
		if (raw.model !== undefined && !model) return { ok: false, message: `Inline role "${key}" model must use provider/model format` };
		const thinkingLevel = raw.thinkingLevel === undefined ? undefined : validateThinkingLevel(raw.thinkingLevel);
		if (raw.thinkingLevel !== undefined && !thinkingLevel) return { ok: false, message: `Inline role "${key}" thinkingLevel is unsupported` };
		let toolPolicies: Record<string, GrantPolicy> | undefined;
		if (raw.toolPolicies !== undefined) {
			if (!plainRecord(raw.toolPolicies)) return { ok: false, message: `Inline role "${key}" toolPolicies must be an object` };
			toolPolicies = {};
			for (const [tool, policy] of Object.entries(raw.toolPolicies)) {
				if (!tool || typeof policy !== "string" || !GRANT_POLICIES.has(policy)) return { ok: false, message: `Inline role "${key}" has an invalid tool policy for "${tool}"` };
				toolPolicies[tool] = normalizeGrantPolicy(policy);
			}
		}
		roles[key] = {
			name: key,
			label: raw.label.trim(),
			promptTemplate: raw.promptTemplate,
			accessory: typeof raw.accessory === "string" ? raw.accessory : "none",
			...(toolPolicies && Object.keys(toolPolicies).length ? { toolPolicies } : {}),
			...(model ? { model } : {}),
			...(thinkingLevel ? { thinkingLevel } : {}),
			createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
			updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
		};
	}
	return { ok: true, roles: structuredClone(roles) };
}
