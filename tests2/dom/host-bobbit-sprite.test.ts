import { beforeAll as syncBeforeAll } from "vitest";
import { syncCustomElements } from "./_setup/custom-elements.js";
syncBeforeAll(() => syncCustomElements());

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { ACCESSORY_DEFS, BOBBIT_HUE_ROTATIONS } from "../../src/ui/bobbit-render.js";

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

function staff(
	id: string,
	projectId: string,
	overrides: Partial<(typeof state.staffList)[number]> = {},
): (typeof state.staffList)[number] {
	return {
		id,
		name: id,
		description: "",
		state: "idle",
		triggers: [],
		projectId,
		...overrides,
	};
}

function options(overrides: Partial<BrowserHostBobbitSpriteOptions> = {}): BrowserHostBobbitSpriteOptions {
	return {
		subject: { kind: "session", id: "live" },
		state: "active",
		label: "Agent avatar",
		...overrides,
	};
}

function appendSprite(
	boundSessionId: string,
	overrides: Partial<BrowserHostBobbitSpriteOptions> = {},
): HTMLElement {
	const sprite = getHostApi(boundSessionId, undefined).ui.createBobbitSprite(options(overrides));
	document.body.append(sprite);
	return sprite;
}

function blob(sprite: HTMLElement): HTMLElement {
	const result = sprite.querySelector<HTMLElement>(".bobbit-blob");
	expect(result).not.toBeNull();
	return result!;
}

interface MotionController {
	readonly query: MediaQueryList;
	readonly add: ReturnType<typeof vi.fn>;
	readonly remove: ReturnType<typeof vi.fn>;
	setMatches(matches: boolean): void;
}

function installMatchMedia(initialMatches: boolean): MotionController {
	let matches = initialMatches;
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const add = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
		if (typeof listener === "function") listeners.add(listener as (event: MediaQueryListEvent) => void);
	});
	const remove = vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
		if (typeof listener === "function") listeners.delete(listener as (event: MediaQueryListEvent) => void);
	});
	const query = {
		get matches() { return matches; },
		media: "(prefers-reduced-motion: reduce)",
		onchange: null,
		addEventListener: add,
		removeEventListener: remove,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(() => true),
	} as unknown as MediaQueryList;
	Object.defineProperty(window, "matchMedia", {
		configurable: true,
		value: vi.fn(() => query),
	});
	return {
		query,
		add,
		remove,
		setMatches(next: boolean) {
			matches = next;
			const event = { matches: next, media: query.media } as MediaQueryListEvent;
			for (const listener of [...listeners]) listener(event);
		},
	};
}

let originalMatchMedia: PropertyDescriptor | undefined;
let originalHtmlClass = "";
let canvasDraws = new WeakMap<HTMLCanvasElement, string[]>();

function canvasFingerprint(sprite: HTMLElement): string {
	const canvas = sprite.querySelector<HTMLCanvasElement>("canvas.bobbit-blob__sprite");
	expect(canvas).not.toBeNull();
	return (canvasDraws.get(canvas!) ?? []).join("|");
}

beforeEach(() => {
	originalMatchMedia = Object.getOwnPropertyDescriptor(window, "matchMedia");
	originalHtmlClass = document.documentElement.className;
	state.gatewaySessions = [];
	state.archivedSessions = [];
	state.staffList = [];
	sessionColorMap.clear();
	canvasDraws = new WeakMap();
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function(this: HTMLCanvasElement) {
		let fillStyle = "";
		const draws: string[] = [];
		canvasDraws.set(this, draws);
		return {
			get fillStyle() { return fillStyle; },
			set fillStyle(value: string | CanvasGradient | CanvasPattern) { fillStyle = String(value); },
			fillRect: (x: number, y: number, width: number, height: number) => {
				draws.push(`${fillStyle}:${x},${y},${width},${height}`);
			},
			clearRect: () => {},
			drawImage: () => {},
		} as unknown as CanvasRenderingContext2D;
	});
	if (!(Element.prototype as Element & { getAnimations?: () => Animation[] }).getAnimations) {
		Object.defineProperty(Element.prototype, "getAnimations", { configurable: true, value: () => [] });
	}
});

afterEach(() => {
	document.body.replaceChildren();
	document.documentElement.className = originalHtmlClass;
	sessionColorMap.clear();
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	if (originalMatchMedia) Object.defineProperty(window, "matchMedia", originalMatchMedia);
	else delete (window as { matchMedia?: unknown }).matchMedia;
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

	it("renders loaded live, archived, and staff appearance through the real Host API", () => {
		installMatchMedia(false);
		state.gatewaySessions = [
			session("bound", "project-a"),
			session("live", "project-a", { colorIndex: 2, accessory: "crown" }),
			session("staff-session", "project-a", { colorIndex: 3 }),
		];
		state.archivedSessions = [
			session("archived", "project-a", { colorIndex: 5, accessory: "wand", archived: true }),
		];
		state.staffList = [
			staff("staff-a", "project-a", { currentSessionId: "staff-session", accessory: "headset" }),
			staff("staff-no-session", "project-a", { accessory: "clipboard" }),
		];
		sessionColorMap.set("live", 7);
		const mapSizeBefore = sessionColorMap.size;

		const live = appendSprite("bound");
		const archived = appendSprite("bound", { subject: { kind: "session", id: "archived" } });
		const currentStaff = appendSprite("bound", { subject: { kind: "staff", id: "staff-a" } });
		const defaultStaff = appendSprite("bound", { subject: { kind: "staff", id: "staff-no-session" } });

		expect(blob(live).style.getPropertyValue("--bobbit-hue-rotate")).toBe(`${BOBBIT_HUE_ROTATIONS[7]}deg`);
		expect(live.querySelector(".bobbit-blob__crown")).not.toBeNull();
		expect(blob(archived).style.getPropertyValue("--bobbit-hue-rotate")).toBe(`${BOBBIT_HUE_ROTATIONS[5]}deg`);
		expect(archived.querySelector(".bobbit-blob__wand")).not.toBeNull();
		expect(blob(currentStaff).style.getPropertyValue("--bobbit-hue-rotate")).toBe(`${BOBBIT_HUE_ROTATIONS[3]}deg`);
		expect(currentStaff.querySelector(".bobbit-blob__headset")).not.toBeNull();
		expect(blob(defaultStaff).style.getPropertyValue("--bobbit-hue-rotate")).toBe("0deg");
		expect(defaultStaff.querySelector(".bobbit-blob__clipboard")).not.toBeNull();
		expect(sessionColorMap.size).toBe(mapSizeBefore);
	});

	it("maps active, idle, paused, and explicit static presentation to canonical output", () => {
		installMatchMedia(false);
		state.gatewaySessions = [session("bound", "project-a"), session("live", "project-a")];
		const active = appendSprite("bound", { state: "active" });
		const idle = appendSprite("bound", { state: "idle" });
		const paused = appendSprite("bound", { state: "paused" });
		const staticActive = appendSprite("bound", { state: "active", animated: false });
		const staticIdle = appendSprite("bound", { state: "idle", animated: false });

		expect(blob(active).classList).toContain("bobbit-blob--hosted-active");
		expect(blob(active).classList).not.toContain("bobbit-blob--hosted-static");
		expect(blob(idle).classList).toContain("bobbit-blob--hosted-idle");
		expect(blob(idle).classList).toContain("bobbit-blob--idle");
		expect(blob(paused).classList).toContain("bobbit-blob--hosted-paused");
		expect(blob(paused).classList).toContain("bobbit-blob--hosted-static");
		expect(blob(staticActive).classList).toContain("bobbit-blob--hosted-static");
		expect(blob(staticActive).classList).not.toContain("bobbit-blob--idle");
		expect(blob(staticIdle).classList).toContain("bobbit-blob--hosted-static");
		expect(blob(staticIdle).classList).toContain("bobbit-blob--idle");
		expect(canvasFingerprint(staticActive)).toBe(canvasFingerprint(paused));
		expect(canvasFingerprint(staticIdle)).not.toBe(canvasFingerprint(paused));
	});

	it("honours default and boundary dimensions", () => {
		installMatchMedia(false);
		state.gatewaySessions = [session("bound", "project-a"), session("live", "project-a")];
		for (const [size, expected] of [[undefined, 40], [16, 16], [96, 96]] as const) {
			const sprite = appendSprite("bound", { ...(size === undefined ? {} : { size }) });
			expect(sprite.style.width).toBe(`${expected}px`);
			expect(sprite.style.height).toBe(`${expected}px`);
			const composition = sprite.querySelector<HTMLElement>(".bobbit-hosted-composition");
			expect(composition?.style.width).toBe(`${expected}px`);
			expect(composition?.style.height).toBe(`${expected}px`);
		}
	});

	it("uses addsHeight for every tall accessory and never for a normal accessory", () => {
		installMatchMedia(false);
		const tallAccessories = Object.values(ACCESSORY_DEFS).filter(accessory => accessory.addsHeight);
		expect(tallAccessories.map(accessory => accessory.id).sort()).toEqual(["crown", "nurse-cap", "wizard-hat"]);
		state.gatewaySessions = [
			session("bound", "project-a"),
			...tallAccessories.map(accessory => session(accessory.id, "project-a", { accessory: accessory.id })),
			session("normal", "project-a", { accessory: "bandana" }),
		];

		for (const accessory of tallAccessories) {
			const sprite = appendSprite("bound", { subject: { kind: "session", id: accessory.id } });
			expect(blob(sprite).classList, accessory.id).toContain("bobbit-blob--hosted-tall");
			expect(sprite.querySelector(`.bobbit-blob__${accessory.id}`), accessory.id).not.toBeNull();
		}
		const normal = appendSprite("bound", { subject: { kind: "session", id: "normal" } });
		expect(blob(normal).classList).not.toContain("bobbit-blob--hosted-tall");
	});

	it("reacts to reduced-motion changes and removes the media listener on disconnect", () => {
		const motion = installMatchMedia(true);
		state.gatewaySessions = [session("bound", "project-a"), session("live", "project-a")];
		const sprite = appendSprite("bound");

		expect(motion.add).toHaveBeenCalledTimes(1);
		expect(blob(sprite).classList).toContain("bobbit-blob--hosted-static");
		motion.setMatches(false);
		expect(blob(sprite).classList).not.toContain("bobbit-blob--hosted-static");
		motion.setMatches(true);
		expect(blob(sprite).classList).toContain("bobbit-blob--hosted-static");

		sprite.remove();
		expect(motion.remove).toHaveBeenCalledTimes(1);
		expect(sprite.childElementCount).toBe(0);
		motion.setMatches(false);
		expect(sprite.childElementCount).toBe(0);
	});

	it("stops canvas work on remove and restarts allowed motion once on reappend", () => {
		vi.useFakeTimers();
		const motion = installMatchMedia(false);
		state.gatewaySessions = [session("bound", "project-a"), session("live", "project-a")];
		const phaseAnimation = {
			currentTime: 0,
			effect: { getTiming: () => ({ duration: 10_000, delay: 0 }) },
		} as unknown as Animation;
		vi.spyOn(Element.prototype as Element & { getAnimations: () => Animation[] }, "getAnimations")
			.mockReturnValue([phaseAnimation]);
		const sprite = appendSprite("bound");
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		const parking = document.createElement("div");
		document.body.append(parking);
		parking.append(sprite);
		expect(motion.remove).toHaveBeenCalledTimes(1);
		expect(motion.add).toHaveBeenCalledTimes(2);
		expect(sprite.querySelector("canvas.bobbit-blob__sprite")).not.toBeNull();
		expect(vi.getTimerCount()).toBe(1);

		sprite.remove();
		expect(motion.remove).toHaveBeenCalledTimes(2);
		expect(sprite.childElementCount).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("renders canonical-equivalent fallback without leaking foreign or malformed identity", () => {
		installMatchMedia(false);
		state.gatewaySessions = [
			session("bound", "project-a"),
			session("foreign-session-secret", "project-b", { colorIndex: 4, accessory: "bandana" }),
			session("malformed", "project-a", { colorIndex: 999, accessory: "not-an-accessory" }),
		];
		state.staffList = [staff("foreign-staff-secret", "project-b", { accessory: "crown" })];
		const cases: Array<[string, BrowserHostBobbitSpriteOptions["subject"]]> = [
			["bound", { kind: "session", id: "missing" }],
			["bound", { kind: "session", id: "" }],
			["bound", { kind: "session", id: "foreign-session-secret" }],
			["bound", { kind: "staff", id: "foreign-staff-secret" }],
			["bound", { kind: "session", id: "malformed" }],
			["missing-bound", { kind: "session", id: "live" }],
		];
		const rendered = cases.map(([bound, subject]) => appendSprite(bound, {
			subject,
			state: "paused",
			label: "Fallback avatar",
		}).innerHTML);
		for (const output of rendered) {
			expect(output).toBe(rendered[0]);
			expect(output).not.toContain("secret");
			expect(output).not.toContain("malformed");
		}
	});

	it("isolates its selected accessory from conflicting document-level classes", () => {
		installMatchMedia(false);
		document.documentElement.classList.add("bobbit-wizard-hat", "bobbit-crowned");
		state.gatewaySessions = [
			session("bound", "project-a"),
			session("live", "project-a", { accessory: "bandana" }),
		];
		const sprite = appendSprite("bound");
		expect(sprite.querySelector(".bobbit-blob__bandana")).not.toBeNull();
		expect(sprite.querySelector(".bobbit-blob__wizard-hat")).toBeNull();
		expect(sprite.querySelector(".bobbit-blob__crown")).toBeNull();
		expect(blob(sprite).classList).not.toContain("bobbit-blob--hosted-tall");
	});

	it("keeps the pure resolver non-allocating for same-project and fallback paths", () => {
		state.gatewaySessions = [
			session("bound", "project-a"),
			session("live", "project-a", { colorIndex: 2, accessory: "crown" }),
			session("foreign", "project-b", { colorIndex: 4, accessory: "bandana" }),
		];
		sessionColorMap.set("live", 7);
		const mapSizeBefore = sessionColorMap.size;
		expect(resolveHostBobbitAppearance("bound", { kind: "session", id: "live" }))
			.toMatchObject({ hueRotate: BOBBIT_HUE_ROTATIONS[7], accessory: { id: "crown" } });
		const foreign = resolveHostBobbitAppearance("bound", { kind: "session", id: "foreign" });
		expect(resolveHostBobbitAppearance("bound", { kind: "session", id: "missing" })).toEqual(foreign);
		expect(sessionColorMap.size).toBe(mapSizeBefore);
	});

	it("does not render while detached", () => {
		state.gatewaySessions = [session("bound", "project-a")];
		const detached = createHostBobbitSprite("bound", options({ animated: false, size: 16 }));
		expect(detached.isConnected).toBe(false);
		expect(detached.childElementCount).toBe(0);
	});
});
