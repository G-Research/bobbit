import { normalizeTags, projectServerTags, type SessionTagSource } from "../../shared/session-tags.js";
import { isSessionUnread, type SessionUnreadContext, type UnreadPolicySession } from "../../shared/session-unread-policy.js";

/** Session-list fields needed to derive server-controlled and user-owned tags. */
export type SessionListTagSource = SessionTagSource & UnreadPolicySession & {
	user_tags?: unknown;
};

export interface SessionListTagProjectionContext extends SessionUnreadContext {
	/** Archive list serializers may override malformed or absent legacy fields. */
	archived?: boolean;
	/** Canonical ownership can override an incomplete legacy row. */
	projectId?: string;
	goalId?: string;
}

/**
 * Attach normalized durable tags and a fresh canonical server projection.
 * `server_tags` is deliberately never accepted from or persisted on the source.
 */
export function projectSessionListTags<T extends SessionListTagSource>(
	session: T,
	context: SessionListTagProjectionContext,
): T & { server_tags: string[]; user_tags: string[] } {
	const user_tags = normalizeTags(session.user_tags);
	const server_tags = projectServerTags(session, {
		unread: isSessionUnread(session, context),
		archived: context.archived,
		projectId: context.projectId,
		goalId: context.goalId,
	});
	return { ...session, server_tags, user_tags };
}
