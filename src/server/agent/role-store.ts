import { YamlStore } from "./yaml-store.js";

/** Grant policy controlling what happens when an agent uses an ungranted tool. */
export type GrantPolicy = 'allow' | 'ask' | 'never';

/** Legacy grant policy values accepted during migration. */
type LegacyGrantPolicy = 'always-allow' | 'ask-once' | 'always-ask' | 'never-ask';

/** Normalize legacy grant policy values to the new three-value set. */
export function normalizeGrantPolicy(value: string): GrantPolicy {
	switch (value) {
		case 'always-allow': return 'allow';
		case 'ask-once': return 'ask';
		case 'always-ask': return 'ask';
		case 'never-ask': return 'never';
		case 'allow': return 'allow';
		case 'ask': return 'ask';
		case 'never': return 'never';
		default: return 'allow';
	}
}

/** Check if a value is a valid grant policy (old or new). */
function isGrantPolicyValue(value: unknown): value is GrantPolicy | LegacyGrantPolicy {
	return typeof value === 'string' && ['allow', 'ask', 'never', 'always-allow', 'ask-once', 'always-ask', 'never-ask'].includes(value);
}

/** Normalize all values in a toolPolicies record. */
function normalizeToolPolicies(policies: Record<string, unknown> | undefined): Record<string, GrantPolicy> | undefined {
	if (!policies || typeof policies !== 'object') return undefined;
	const result: Record<string, GrantPolicy> = {};
	for (const [key, value] of Object.entries(policies)) {
		if (isGrantPolicyValue(value)) {
			result[key] = normalizeGrantPolicy(value);
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

export interface Role {
	/** Unique identifier — lowercase alphanumeric + hyphens, immutable after creation */
	name: string;
	/** Human-readable display label */
	label: string;
	/** Markdown system prompt template (supports {{GOAL_BRANCH}} and {{AGENT_ID}} placeholders) */
	promptTemplate: string;
	/** Pixel-art accessory ID for the Bobbit sprite overlay */
	accessory: string;
	/** Default personalities applied when no explicit personalities are specified */
	defaultPersonalities?: string[];
	/** Per-tool or per-group grant policy overrides (tool name or MCP server prefix → policy) */
	toolPolicies?: Record<string, GrantPolicy>;
	createdAt: number;
	updatedAt: number;
}

function parseRole(data: Record<string, unknown>): Role | null {
	if (!data.name) return null;
	return {
		name: data.name as string,
		label: (data.label as string) ?? (data.name as string),
		promptTemplate: (data.promptTemplate as string) ?? "",
		accessory: (data.accessory as string) ?? "none",
		defaultPersonalities: Array.isArray(data.defaultPersonalities) ? data.defaultPersonalities : undefined,
		toolPolicies: normalizeToolPolicies(data.toolPolicies as Record<string, unknown> | undefined),
		createdAt: (data.createdAt as number) ?? 0,
		updatedAt: (data.updatedAt as number) ?? 0,
	};
}

function serializeRole(role: Role): Record<string, unknown> {
	const obj: Record<string, unknown> = {
		name: role.name,
		label: role.label,
		accessory: role.accessory,
	};
	if (role.defaultPersonalities && role.defaultPersonalities.length > 0) {
		obj.defaultPersonalities = role.defaultPersonalities;
	}
	if (role.toolPolicies && Object.keys(role.toolPolicies).length > 0) {
		obj.toolPolicies = role.toolPolicies;
	}
	obj.createdAt = role.createdAt;
	obj.updatedAt = role.updatedAt;
	obj.promptTemplate = role.promptTemplate;
	return obj;
}

/**
 * File-backed role store with builtin cascade support.
 * Each role is a YAML file in roles/<name>.yaml.
 */
export class RoleStore extends YamlStore<Role> {
	constructor(configDir: string) {
		super(configDir, {
			subdir: "roles",
			keyFn: r => r.name,
			parseItem: parseRole,
			serializeItem: serializeRole,
			logPrefix: "[role-store]",
		});
	}

	/** Override put to normalize legacy tool policies before saving. */
	put(role: Role): void {
		if (role.toolPolicies) {
			role.toolPolicies = normalizeToolPolicies(role.toolPolicies) ?? {};
		}
		super.put(role);
	}
}
