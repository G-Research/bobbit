import { html, nothing, render, type TemplateResult } from "lit";
import type { AccessoryDef } from "../ui/bobbit-render.js";
import * as bobbitRenderer from "../ui/bobbit-render.js";
import { sessionColorMap } from "./session-colors.js";
import { state, type GatewaySession } from "./state.js";

/** Internal structural mirror used while constructing the browser-owned API. */
type BrowserHostBobbitState = "active" | "idle" | "paused";
type BrowserHostBobbitSubject =
	| { kind: "session"; id: string }
	| { kind: "staff"; id: string };
export interface BrowserHostBobbitSpriteOptions {
	subject: BrowserHostBobbitSubject;
	state: BrowserHostBobbitState;
	label: string;
	size?: number;
	animated?: boolean;
}

interface HostedRendererOptions {
	state: BrowserHostBobbitState;
	hueRotate: number;
	accessory: AccessoryDef;
	size?: number;
	animated: boolean;
}

// The renderer is implemented in parallel. Keeping this assertion beside the
// call site gives that integration one narrow, explicit contract while allowing
// this branch to type-check independently before the renderer commit is merged.
const hostedRenderer = bobbitRenderer as typeof bobbitRenderer & {
	renderHostBobbitSprite(options: HostedRendererOptions): TemplateResult;
	disposeHostBobbitSprite(root: ParentNode): void;
};

export interface HostBobbitAppearance {
	readonly hueRotate: number;
	readonly accessory: AccessoryDef;
}

const FALLBACK_APPEARANCE: HostBobbitAppearance = Object.freeze({
	hueRotate: 0,
	accessory: bobbitRenderer.NO_ACCESSORY,
});

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function findLoadedSession(sessionId: string): GatewaySession | undefined {
	const isMatch = (candidate: GatewaySession): boolean =>
		isNonEmptyString(candidate?.id) && candidate.id === sessionId;
	return state.gatewaySessions.find(isMatch) ?? state.archivedSessions.find(isMatch);
}

function validColorIndex(value: unknown): value is number {
	return Number.isInteger(value)
		&& (value as number) >= 0
		&& (value as number) < bobbitRenderer.BOBBIT_HUE_ROTATIONS.length;
}

function hueForSession(session: GatewaySession | undefined): number {
	if (!session) return 0;
	const mappedIndex = sessionColorMap.get(session.id);
	const colorIndex = validColorIndex(mappedIndex)
		? mappedIndex
		: validColorIndex(session.colorIndex)
			? session.colorIndex
			: undefined;
	return colorIndex === undefined ? 0 : bobbitRenderer.BOBBIT_HUE_ROTATIONS[colorIndex];
}

/**
 * Resolve appearance only from the already-loaded projection belonging to the
 * closure-bound session's project. All misses share one canonical result so an
 * extension cannot distinguish unknown IDs from IDs owned by another project.
 */
export function resolveHostBobbitAppearance(
	boundSessionId: string | undefined,
	subject: BrowserHostBobbitSubject,
): HostBobbitAppearance {
	if (!isNonEmptyString(boundSessionId)) return FALLBACK_APPEARANCE;
	const boundSession = findLoadedSession(boundSessionId);
	const boundProjectId = boundSession?.projectId;
	if (!isNonEmptyString(boundProjectId)) return FALLBACK_APPEARANCE;

	if (subject.kind === "session") {
		const session = findLoadedSession(subject.id);
		if (!session || session.projectId !== boundProjectId) return FALLBACK_APPEARANCE;
		return {
			hueRotate: hueForSession(session),
			accessory: bobbitRenderer.getAccessoryDef(session.accessory),
		};
	}

	const staff = state.staffList.find((candidate) =>
		isNonEmptyString(candidate?.id)
		&& candidate.id === subject.id
		&& candidate.projectId === boundProjectId,
	);
	if (!staff) return FALLBACK_APPEARANCE;

	const currentSession = isNonEmptyString(staff.currentSessionId)
		? findLoadedSession(staff.currentSessionId)
		: undefined;
	const projectSession = currentSession?.projectId === boundProjectId
		? currentSession
		: undefined;
	return {
		hueRotate: hueForSession(projectSession),
		accessory: bobbitRenderer.getAccessoryDef(staff.accessory),
	};
}

function validateOptions(value: unknown): BrowserHostBobbitSpriteOptions {
	if (!value || typeof value !== "object") {
		throw new TypeError("Bobbit sprite options must be an object");
	}
	const options = value as Record<string, unknown>;
	const subject = options.subject;
	if (!subject || typeof subject !== "object") {
		throw new TypeError("Bobbit sprite subject must be an object");
	}
	const subjectRecord = subject as Record<string, unknown>;
	if (subjectRecord.kind !== "session" && subjectRecord.kind !== "staff") {
		throw new TypeError("Bobbit sprite subject.kind must be session or staff");
	}
	if (typeof subjectRecord.id !== "string") {
		throw new TypeError("Bobbit sprite subject.id must be a string");
	}
	if (options.state !== "active" && options.state !== "idle" && options.state !== "paused") {
		throw new TypeError("Bobbit sprite state must be active, idle, or paused");
	}
	if (typeof options.label !== "string" || options.label.trim().length === 0 || options.label.length > 200) {
		throw new TypeError("Bobbit sprite label must contain 1 to 200 characters");
	}
	if (options.size !== undefined
		&& (!Number.isInteger(options.size) || (options.size as number) < 16 || (options.size as number) > 96)) {
		throw new TypeError("Bobbit sprite size must be an integer from 16 to 96");
	}
	if (options.animated !== undefined && typeof options.animated !== "boolean") {
		throw new TypeError("Bobbit sprite animated must be a boolean");
	}
	return {
		subject: { kind: subjectRecord.kind, id: subjectRecord.id } as BrowserHostBobbitSubject,
		state: options.state,
		label: options.label,
		...(options.size === undefined ? {} : { size: options.size as number }),
		...(options.animated === undefined ? {} : { animated: options.animated }),
	};
}

interface ElementRenderData {
	readonly state: BrowserHostBobbitState;
	readonly label: string;
	readonly size?: number;
	readonly animated: boolean;
	readonly appearance: HostBobbitAppearance;
}

const elementData = new WeakMap<HostBobbitSpriteElement, ElementRenderData>();
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

class HostBobbitSpriteElement extends HTMLElement {
	private motionQuery: MediaQueryList | undefined;

	private readonly onMotionPreferenceChange = (): void => {
		if (this.isConnected) this.paint();
	};

	connectedCallback(): void {
		const data = elementData.get(this);
		if (!data) return;
		this.setAttribute("role", "img");
		this.setAttribute("aria-label", data.label);
		this.style.display = "inline-block";
		this.style.width = `${data.size ?? 40}px`;
		this.style.height = `${data.size ?? 40}px`;

		if (data.animated && data.state !== "paused" && typeof window.matchMedia === "function") {
			this.motionQuery = window.matchMedia(REDUCED_MOTION_QUERY);
			this.motionQuery.addEventListener("change", this.onMotionPreferenceChange);
		}
		this.paint();
	}

	disconnectedCallback(): void {
		this.motionQuery?.removeEventListener("change", this.onMotionPreferenceChange);
		this.motionQuery = undefined;
		hostedRenderer.disposeHostBobbitSprite(this);
		render(nothing, this);
	}

	private paint(): void {
		const data = elementData.get(this);
		if (!data) return;
		const animated = data.animated
			&& data.state !== "paused"
			&& this.motionQuery?.matches !== true;
		const sprite = hostedRenderer.renderHostBobbitSprite({
			state: data.state,
			hueRotate: data.appearance.hueRotate,
			accessory: data.appearance.accessory,
			size: data.size,
			animated,
		});
		render(html`<span aria-hidden="true">${sprite}</span>`, this);
	}
}

const HOST_BOBBIT_ELEMENT = "bobbit-host-sprite";
if (!customElements.get(HOST_BOBBIT_ELEMENT)) {
	customElements.define(HOST_BOBBIT_ELEMENT, HostBobbitSpriteElement);
}

/** Create the required framework-neutral Host sprite element. */
export function createHostBobbitSprite(
	boundSessionId: string | undefined,
	optionsValue: BrowserHostBobbitSpriteOptions,
): HTMLElement {
	// Validation deliberately precedes appearance lookup and element creation.
	const options = validateOptions(optionsValue);
	const appearance = resolveHostBobbitAppearance(boundSessionId, options.subject);
	const element = document.createElement(HOST_BOBBIT_ELEMENT) as HostBobbitSpriteElement;
	elementData.set(element, Object.freeze({
		state: options.state,
		label: options.label,
		size: options.size,
		animated: options.animated !== false,
		appearance: Object.freeze({ ...appearance }),
	}));
	element.setAttribute("role", "img");
	element.setAttribute("aria-label", options.label);
	return element;
}
