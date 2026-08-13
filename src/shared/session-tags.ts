/**
 * DOM-free session tag normalization and canonical projection primitives.
 *
 * Tags are opaque `key=value` strings except that keys must be lowercase
 * kebab-case. Values are preserved verbatim so identifiers and future tag
 * values can evolve without this module rewriting them.
 */

const TAG_KEY_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

interface ParsedTag {
	key: string;
	value: string;
	tag: string;
}

function parseTag(input: unknown): ParsedTag | undefined {
	if (typeof input !== "string") return undefined;
	const separator = input.indexOf("=");
	if (separator <= 0 || separator === input.length - 1) return undefined;
	const key = input.slice(0, separator);
	if (!TAG_KEY_PATTERN.test(key)) return undefined;
	return { key, value: input.slice(separator + 1), tag: input };
}

function isValidTagPart(key: string, value: string): boolean {
	return TAG_KEY_PATTERN.test(key) && value.length > 0;
}

/**
 * Normalize an unknown persisted tag value.
 *
 * Malformed/non-array legacy data becomes an empty array. Invalid entries are
 * discarded. When a key occurs more than once, its last valid occurrence wins
 * and surviving tags retain their relative input order.
 */
export function normalizeTags(input: unknown): string[] {
	if (!Array.isArray(input)) return [];

	const seenKeys = new Set<string>();
	const normalized: string[] = [];
	for (let index = input.length - 1; index >= 0; index -= 1) {
		const parsed = parseTag(input[index]);
		if (!parsed || seenKeys.has(parsed.key)) continue;
		seenKeys.add(parsed.key);
		normalized.push(parsed.tag);
	}
	normalized.reverse();
	return normalized;
}

/** Test whether a normalized keyed tag has the exact requested value. */
export function hasTag(tags: unknown, key: string, value: string): boolean {
	if (!isValidTagPart(key, value)) return false;
	return normalizeTags(tags).some((tag) => {
		const parsed = parseTag(tag);
		return parsed?.key === key && parsed.value === value;
	});
}

/**
 * Replace every value for a key with one value while preserving unrelated
 * normalized tags. Invalid keys/values are ignored after normalizing input.
 */
export function replaceTag(tags: unknown, key: string, value: string): string[] {
	const normalized = normalizeTags(tags);
	if (!isValidTagPart(key, value)) return normalized;
	return [...normalized.filter((tag) => parseTag(tag)?.key !== key), `${key}=${value}`];
}

/** Remove every value for a key while preserving unrelated normalized tags. */
export function removeTag(tags: unknown, key: string): string[] {
	const normalized = normalizeTags(tags);
	if (!TAG_KEY_PATTERN.test(key)) return normalized;
	return normalized.filter((tag) => parseTag(tag)?.key !== key);
}

/** A session is pinned only by the exact normalized `pinned=true` tag. */
export function isPinned(tags: unknown): boolean {
	return hasTag(tags, "pinned", "true");
}

/** Minimal session shape consumed by the shared projection helpers. */
export interface SessionTagSource {
	status?: string;
	isCompacting?: boolean;
	archived?: boolean;
	role?: string;
	teamGoalId?: string;
	teamLeadSessionId?: string;
	/** Parentage is carried only to make non-membership explicit to callers. */
	delegateOf?: string;
	parentSessionId?: string;
	projectId?: string;
	goalId?: string;
}

export type SessionTeamKind = "lead" | "member" | "none";

/** Canonical production Show Busy classifier. */
export function isSessionBusy(session: SessionTagSource): boolean {
	return session.isCompacting === true
		|| session.status === "streaming"
		|| session.status === "aborting"
		|| session.status === "preparing"
		|| session.status === "starting";
}

/** Whether the canonical sidebar row shows a timestamp rather than active shimmer. */
export function sessionShowsLastActivity(session: SessionTagSource): boolean {
	return session.isCompacting !== true
		&& session.status !== "streaming"
		&& session.status !== "busy";
}

/**
 * Whether a read session is eligible for suppression by production Show Read.
 * Other states, including serialized `archived` records and active work, remain
 * visible when Show Read is off.
 */
export function isSessionReadFilterable(session: SessionTagSource): boolean {
	return session.status === "idle" || session.status === "terminated";
}

/**
 * Classify team ownership without treating delegates or first-class children
 * as members merely because they have a parent.
 */
export function sessionTeamKind(session: SessionTagSource): SessionTeamKind {
	if (session.role === "team-lead") return "lead";
	if (session.teamLeadSessionId || session.teamGoalId) return "member";
	return "none";
}

/** Canonical archive-state classifier. */
export function isSessionArchived(session: SessionTagSource): boolean {
	return session.archived === true;
}

export interface ServerTagProjectionContext {
	/** Result of the canonical unread policy for this serialized session. */
	unread: boolean;
	/** Canonical list context may override incomplete legacy record fields. */
	archived?: boolean;
	projectId?: string;
	goalId?: string;
}

/**
 * Project canonical state into server-controlled tags in stable order.
 * The returned array is derived only; callers must never persist it.
 */
export function projectServerTags(
	session: SessionTagSource,
	context: ServerTagProjectionContext,
): string[] {
	const archived = context.archived ?? isSessionArchived(session);
	const projectId = context.projectId ?? session.projectId;
	const goalId = context.goalId ?? session.teamGoalId ?? session.goalId;
	const tags = [
		`read-state=${context.unread ? "unread" : "read"}`,
		`activity-state=${isSessionBusy(session) ? "busy" : "not-busy"}`,
		`archive-state=${archived ? "archived" : "live"}`,
		`team-kind=${sessionTeamKind(session)}`,
	];
	if (projectId) tags.push(`project-id=${projectId}`);
	if (goalId) tags.push(`goal-id=${goalId}`);
	return normalizeTags(tags);
}
