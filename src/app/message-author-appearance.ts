import {
	isMessageAuthor,
	sanitizeAuthorIdComponent,
} from "../shared/message-author.js";
import {
	BOBBIT_HUE_ROTATIONS,
	getAccessoryDef,
} from "../ui/bobbit-render.js";
import type { GatewaySession } from "./state.js";

export interface PromptAuthorAppearance {
	sessionId?: string;
	hueRotate: number;
	accessoryId: string;
}

export interface PromptAuthorAppearanceContext {
	liveSessions: readonly GatewaySession[];
	archivedSessions: readonly GatewaySession[];
	staff: ReadonlyArray<{ id: string; currentSessionId?: string }>;
	sessionColorIndexes?: ReadonlyMap<string, number>;
}

export const FALLBACK_PROMPT_AUTHOR_APPEARANCE: Readonly<PromptAuthorAppearance> = Object.freeze({
	hueRotate: 0,
	accessoryId: "none",
});

function isLoadedSession(value: unknown): value is GatewaySession {
	return !!value
		&& typeof value === "object"
		&& typeof (value as Partial<GatewaySession>).id === "string"
		&& (value as Partial<GatewaySession>).id!.trim().length > 0;
}

function findSessionById(
	sessionId: string,
	liveSessions: readonly GatewaySession[],
	archivedSessions: readonly GatewaySession[],
): GatewaySession | undefined {
	return liveSessions.find((session) => isLoadedSession(session) && session.id === sessionId)
		?? archivedSessions.find((session) => isLoadedSession(session) && session.id === sessionId);
}

function findSessionByAuthorId(
	authorId: string,
	liveSessions: readonly GatewaySession[],
	archivedSessions: readonly GatewaySession[],
): GatewaySession | undefined {
	const matches = (session: GatewaySession): boolean => isLoadedSession(session)
		&& `session:${sanitizeAuthorIdComponent(session.id, "unknown", 128)}` === authorId;
	return liveSessions.find(matches) ?? archivedSessions.find(matches);
}

function validColorIndex(value: unknown): value is number {
	return Number.isInteger(value)
		&& (value as number) >= 0
		&& (value as number) < BOBBIT_HUE_ROTATIONS.length;
}

function appearanceForSession(
	session: GatewaySession | undefined,
	sessionColorIndexes?: ReadonlyMap<string, number>,
): PromptAuthorAppearance {
	if (!session || !isLoadedSession(session)) return FALLBACK_PROMPT_AUTHOR_APPEARANCE;
	const mappedIndex = sessionColorIndexes?.get(session.id);
	const colorIndex = validColorIndex(mappedIndex)
		? mappedIndex
		: validColorIndex(session.colorIndex)
			? session.colorIndex
			: undefined;
	if (colorIndex === undefined) return FALLBACK_PROMPT_AUTHOR_APPEARANCE;

	return {
		sessionId: session.id,
		hueRotate: BOBBIT_HUE_ROTATIONS[colorIndex],
		accessoryId: getAccessoryDef(session.accessory).id,
	};
}

/** Resolve a trusted agent author against already-loaded, read-only appearance state. */
export function resolvePromptAuthorAppearance(
	author: unknown,
	context: PromptAuthorAppearanceContext,
): PromptAuthorAppearance {
	if (!isMessageAuthor(author) || author.kind !== "agent") {
		return FALLBACK_PROMPT_AUTHOR_APPEARANCE;
	}

	const liveSessions = Array.isArray(context?.liveSessions) ? context.liveSessions : [];
	const archivedSessions = Array.isArray(context?.archivedSessions) ? context.archivedSessions : [];
	let session: GatewaySession | undefined;

	if (author.id.startsWith("session:")) {
		session = findSessionByAuthorId(author.id, liveSessions, archivedSessions);
	} else if (author.id.startsWith("staff:")) {
		const staffRows = Array.isArray(context?.staff) ? context.staff : [];
		const staff = staffRows.find((row) => !!row
			&& typeof row.id === "string"
			&& row.id.trim().length > 0
			&& `staff:${sanitizeAuthorIdComponent(row.id, "unknown", 128)}` === author.id);
		if (!staff || typeof staff.currentSessionId !== "string" || !staff.currentSessionId.trim()) {
			return FALLBACK_PROMPT_AUTHOR_APPEARANCE;
		}
		session = findSessionById(staff.currentSessionId, liveSessions, archivedSessions);
	} else {
		return FALLBACK_PROMPT_AUTHOR_APPEARANCE;
	}

	return appearanceForSession(session, context?.sessionColorIndexes);
}
