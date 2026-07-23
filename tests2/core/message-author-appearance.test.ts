import { describe, expect, it } from "vitest";
import {
	FALLBACK_PROMPT_AUTHOR_APPEARANCE,
	resolvePromptAuthorAppearance,
	type PromptAuthorAppearanceContext,
} from "../../src/app/message-author-appearance.js";
import { BOBBIT_HUE_ROTATIONS } from "../../src/ui/bobbit-render.js";
import type { GatewaySession } from "../../src/app/state.js";

function session(
	id: string,
	colorIndex: number | undefined,
	accessory?: string,
): GatewaySession {
	return { id, colorIndex, accessory } as GatewaySession;
}

function context(
	overrides: Partial<PromptAuthorAppearanceContext> = {},
): PromptAuthorAppearanceContext {
	return {
		liveSessions: [],
		archivedSessions: [],
		staff: [],
		...overrides,
	};
}

const agent = (id: string) => ({ kind: "agent" as const, id, label: "Test Coordinator" });

describe("prompt author appearance", () => {
	it("resolves sanitized session authors from live state before archived state", () => {
		const live = session(" Agent Session 42 ", 3, "bandana");
		const archived = session(" Agent Session 42 ", 11, "crown");

		expect(resolvePromptAuthorAppearance(agent("session:agent-session-42"), context({
			liveSessions: [live],
			archivedSessions: [archived],
		}))).toEqual({
			sessionId: live.id,
			hueRotate: BOBBIT_HUE_ROTATIONS[3],
			accessoryId: "bandana",
		});
	});

	it("falls back to archived sessions and prefers an existing color map entry", () => {
		const archived = session("archive-id", 2, "crown");
		const colors = new Map([[archived.id, 9]]);

		expect(resolvePromptAuthorAppearance(agent("session:archive-id"), context({
			archivedSessions: [archived],
			sessionColorIndexes: colors,
		}))).toEqual({
			sessionId: archived.id,
			hueRotate: BOBBIT_HUE_ROTATIONS[9],
			accessoryId: "crown",
		});
		expect(colors).toEqual(new Map([[archived.id, 9]]));
	});

	it("resolves sanitized staff authors through their current session, live before archived", () => {
		const live = session("staff-session", 4, "bandana");
		const archived = session("staff-session", 7, "headset");
		const staff = [{ id: " QA Coordinator ", currentSessionId: archived.id }];

		expect(resolvePromptAuthorAppearance(agent("staff:qa-coordinator"), context({
			liveSessions: [live],
			archivedSessions: [archived],
			staff,
		}))).toEqual({
			sessionId: live.id,
			hueRotate: BOBBIT_HUE_ROTATIONS[4],
			accessoryId: "bandana",
		});
		expect(resolvePromptAuthorAppearance(agent("staff:qa-coordinator"), context({
			archivedSessions: [archived],
			staff,
		}))).toEqual({
			sessionId: archived.id,
			hueRotate: BOBBIT_HUE_ROTATIONS[7],
			accessoryId: "headset",
		});
	});

	it("uses the canonical none accessory fallback without allocating color state", () => {
		const colors = new Map<string, number>();
		const loaded = session("agent-1", 5, "not-a-real-accessory");

		expect(resolvePromptAuthorAppearance(agent("session:agent-1"), context({
			liveSessions: [loaded],
			sessionColorIndexes: colors,
		}))).toEqual({
			sessionId: loaded.id,
			hueRotate: BOBBIT_HUE_ROTATIONS[5],
			accessoryId: "none",
		});
		expect(colors.size).toBe(0);
	});

	it("returns the same frozen fallback for non-agents and unavailable or invalid sources", () => {
		const loaded = session("agent-1", 999, "crown");
		const cases: unknown[] = [
			undefined,
			{ kind: "user", id: "user:local", label: "User" },
			{ kind: "system", id: "system:bobbit", label: "Bobbit" },
			{ kind: "agent", id: "session:missing", label: "Agent" },
			{ kind: "agent", id: "staff:missing", label: "Agent" },
			{ kind: "agent", id: "other:agent-1", label: "Agent" },
		];

		for (const author of cases) {
			expect(resolvePromptAuthorAppearance(author, context({ liveSessions: [loaded] })))
				.toBe(FALLBACK_PROMPT_AUTHOR_APPEARANCE);
		}
		expect(resolvePromptAuthorAppearance(agent("session:agent-1"), context({ liveSessions: [loaded] })))
			.toBe(FALLBACK_PROMPT_AUTHOR_APPEARANCE);
		expect(Object.isFrozen(FALLBACK_PROMPT_AUTHOR_APPEARANCE)).toBe(true);
	});
});
