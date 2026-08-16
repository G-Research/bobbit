export const STRICT_UPDATE_BODY_KEYS = {
	projects: ["name", "color", "rootPath", "palette", "colorLight", "colorDark", "config", "components", "workflows", "configDirectories", "sandboxTokens"],
	goals: ["title", "cwd", "state", "spec", "branch", "reattemptOf", "team"],
	tools: ["projectId", "description", "group", "docs", "detail_docs", "grantPolicy"],
	roles: ["projectId", "label", "promptTemplate", "accessory", "toolPolicies", "model", "thinkingLevel"],
	tasks: ["title", "spec", "state", "assignedSessionId", "dependsOn", "workflowGateId", "inputGateIds", "headSha", "baseSha", "branch", "resultSummary"],
	workflows: ["name", "description", "gates"],
	staffPut: ["name", "description", "systemPrompt", "cwd", "state", "triggers", "memory", "roleId", "accessory", "contextPolicy"],
	sessions: ["title", "colorIndex", "projectId", "preview", "roleId", "assistantType", "goalAssistant", "goalId", "accessory", "delegateOf", "teamLeadSessionId", "archived"],
	staffPatch: ["projectId"],
	goalPolicy: ["subgoalsAllowed", "maxNestingDepth", "divergencePolicy", "maxConcurrentChildren"],
} as const;

// Values remain unvalidated here: each route preserves its existing per-field
// validation rules, while this type prevents it from reading undeclared keys.
export type StrictBody<K extends readonly string[]> = Partial<Record<K[number], any>>;

export interface StrictBodyOptions {
	wrongEndpoint?: Readonly<Record<string, string>>;
}

export class StrictBodyError extends Error {
	constructor(message: string, readonly fields: readonly string[] = []) {
		super(message);
		this.name = "StrictBodyError";
	}
}

/**
 * Restrict a finite-shape JSON request body to an explicit tuple of allowed
 * keys. The returned type exposes only tuple members, keeping route handling
 * and its runtime contract in lockstep.
 */
export function parseStrictBody<K extends readonly string[]>(
	raw: unknown,
	allowedKeys: K,
	options: StrictBodyOptions = {},
): StrictBody<K> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new StrictBodyError("Request body must be a plain object");
	}

	const allowed = new Set<string>(allowedKeys);
	const fields = Object.keys(raw).filter(key => !allowed.has(key)).sort();
	if (fields.length > 0) {
		const hints = [...new Set(fields.map(field => options.wrongEndpoint?.[field]).filter((hint): hint is string => Boolean(hint)))];
		const suffix = hints.length > 0 ? ` Use ${hints.join(" or ")}.` : "";
		throw new StrictBodyError(`Unknown request body field${fields.length === 1 ? "" : "s"}: ${fields.join(", ")}.${suffix}`, fields);
	}

	return raw as StrictBody<K>;
}
