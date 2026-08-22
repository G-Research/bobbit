import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.js";
syncBeforeAll(() => syncCustomElements());

import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Preserve the established host-api module-cycle initialization order.
import "../../src/app/session-manager.js";
import { getHostApi } from "../../src/app/host-api.js";
import {
	createHostBobbitSprite,
	resolveHostBobbitAppearance,
	type BrowserHostBobbitSpriteOptions,
} from "../../src/app/host-bobbit-sprite.js";
import { sessionColorMap } from "../../src/app/session-colors.js";
import { state, type GatewaySession } from "../../src/app/state.js";
import { BOBBIT_HUE_ROTATIONS } from "../../src/ui/bobbit-render.js";

function session(id: string, projectId: string, overrides: Partial<GatewaySession> = {}): GatewaySession {
	return {
		id,
		projectId,
		title: id,
		cwd: "/tmp",
		status: "idle",
		createdAt: 1,
		lastActivity: 1,
		clientCount: 0,
		...overrides,
	};
}

beforeEach(() => {
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.staffList = [];
	sessionColorMap.clear();
});

afterEach(() => {
	document.body.replaceChildren();
	sessionColorMap.clear();
});

describe("browser Host Bobbit sprite client boundary", () => {
	it("validates synchronously and returns a labelled framework-neutral element", () => {
		const host = getHostApi("bound", undefined) as any;
		const valid: BrowserHostBobbitSpriteOptions = {
			subject: { kind: "session", id: "missing" },
			state: "paused",
			label: "  Missing agent  ",
		};
		const element = host.ui.createBobbitSprite(valid);

		expect(element).toBeInstanceOf(HTMLElement);
		expect(element.getAttribute("role")).toBe("img");
		expect(element.getAttribute("aria-label")).toBe(valid.label);
		expect(element.textContent).toBe("");

		const invalidValues: unknown[] = [
			null,
			{},
			{ ...valid, subject: null },
			{ ...valid, subject: { kind: "goal", id: "x" } },
			{ ...valid, subject: { kind: "session", id: 1 } },
			{ ...valid, state: "busy" },
			{ ...valid, label: " " },
			{ ...valid, label: "x".repeat(201) },
			{ ...valid, size: 15 },
			{ ...valid, size: 97 },
			{ ...valid, size: 40.5 },
			{ ...valid, animated: "yes" },
		];
		for (const value of invalidValues) {
			expect(() => host.ui.createBobbitSprite(value)).toThrow(TypeError);
		}
	});

	it("resolves only loaded same-project session and staff appearance without allocating colour", () => {
		state.gatewaySessions = [
			session("bound", "project-a"),
			session("live", "project-a", { colorIndex: 2, accessory: "crown" }),
			session("foreign", "project-b", { colorIndex: 4, accessory: "bandana" }),
			session("staff-session", "project-a", { colorIndex: 3 }),
		];
		state.archivedSessions = [
			session("archived", "project-a", { colorIndex: 5, accessory: "wand", archived: true }),
		];
		state.staffList = [{
			id: "staff-a",
			name: "Staff A",
			description: "",
			state: "active",
			currentSessionId: "staff-session",
			triggers: [],
			projectId: "project-a",
			accessory: "headset",
		}];
		sessionColorMap.set("live", 7);
		const mapSizeBefore = sessionColorMap.size;

		expect(resolveHostBobbitAppearance("bound", { kind: "session", id: "live" }))
			.toMatchObject({ hueRotate: BOBBIT_HUE_ROTATIONS[7], accessory: { id: "crown" } });
		expect(resolveHostBobbitAppearance("bound", { kind: "session", id: "archived" }))
			.toMatchObject({ hueRotate: BOBBIT_HUE_ROTATIONS[5], accessory: { id: "wand" } });
		expect(resolveHostBobbitAppearance("bound", { kind: "staff", id: "staff-a" }))
			.toMatchObject({ hueRotate: BOBBIT_HUE_ROTATIONS[3], accessory: { id: "headset" } });
		expect(sessionColorMap.size).toBe(mapSizeBefore);

		const foreign = resolveHostBobbitAppearance("bound", { kind: "session", id: "foreign" });
		const missing = resolveHostBobbitAppearance("bound", { kind: "session", id: "does-not-exist" });
		const missingBound = resolveHostBobbitAppearance("does-not-exist", { kind: "session", id: "live" });
		expect(foreign).toMatchObject({ hueRotate: 0, accessory: { id: "none" } });
		expect(missing).toEqual(foreign);
		expect(missingBound).toEqual(foreign);
	});

	it("keeps staff accessory while defaulting colour when no same-project current session exists", () => {
		state.gatewaySessions = [session("bound", "project-a")];
		state.staffList = [{
			id: "staff-a",
			name: "Staff A",
			description: "",
			state: "paused",
			currentSessionId: "foreign-session",
			triggers: [],
			projectId: "project-a",
			accessory: "clipboard",
		}];
		state.archivedSessions = [session("foreign-session", "project-b", { colorIndex: 8 })];

		expect(resolveHostBobbitAppearance("bound", { kind: "staff", id: "staff-a" }))
			.toMatchObject({ hueRotate: 0, accessory: { id: "clipboard" } });

		const detached = createHostBobbitSprite("bound", {
			subject: { kind: "staff", id: "staff-a" },
			state: "idle",
			label: "Staff A",
			animated: false,
			size: 16,
		});
		expect(detached.isConnected).toBe(false);
		expect(detached.childElementCount).toBe(0);
	});
});
