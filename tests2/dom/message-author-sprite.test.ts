import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACCESSORY_DEFS,
	BOBBIT_HUE_ROTATIONS,
	CANONICAL_PALETTE,
	NO_ACCESSORY,
	getAccessoryDef,
	renderStaticSidebarBobbitCanvas,
	resolveBodyPixels,
} from "../../src/ui/bobbit-render.js";
import {
	BOBBIT_HUE_ROTATIONS as SESSION_HUE_ROTATIONS,
	getAccessory,
} from "../../src/app/session-colors.js";

interface DrawCall {
	x: number;
	y: number;
	width: number;
	height: number;
	color: string;
}

interface ContextStub {
	fillStyle: string;
	imageSmoothingEnabled: boolean;
	drawCalls: DrawCall[];
	fillRect(x: number, y: number, width: number, height: number): void;
}

let contexts: ContextStub[];
let host: HTMLDivElement;

beforeEach(() => {
	contexts = [];
	host = document.createElement("div");
	document.body.appendChild(host);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
		const context: ContextStub = {
			fillStyle: "",
			imageSmoothingEnabled: true,
			drawCalls: [],
			fillRect(x, y, width, height) {
				this.drawCalls.push({ x, y, width, height, color: this.fillStyle });
			},
		};
		contexts.push(context);
		return context as unknown as CanvasRenderingContext2D;
	});
	vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,c3RhdGlj");
});

afterEach(() => {
	render(null, host);
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("message author Bobbit sprite", () => {
	it("shares the canonical accessory and hue registries with session rendering", () => {
		expect(getAccessoryDef("crown")).toBe(ACCESSORY_DEFS.crown);
		expect(getAccessory("crown")).toBe(getAccessoryDef("crown"));
		expect(getAccessoryDef("missing")).toBe(NO_ACCESSORY);
		expect(getAccessory(undefined)).toBe(NO_ACCESSORY);
		expect(SESSION_HUE_ROTATIONS).toBe(BOBBIT_HUE_ROTATIONS);
	});

	it("renders canonical center-facing open eyes with the supplied sidebar appearance and no motion", () => {
		const timeoutSpy = vi.spyOn(window, "setTimeout");
		const animationFrameSpy = vi.spyOn(window, "requestAnimationFrame");
		const hueRotate = BOBBIT_HUE_ROTATIONS[10];

		render(renderStaticSidebarBobbitCanvas({
			hueRotate,
			accessory: getAccessoryDef("crown"),
		}), host);

		const decorativeWrapper = host.firstElementChild as HTMLElement | null;
		expect(decorativeWrapper?.getAttribute("aria-hidden")).toBe("true");
		const sprite = decorativeWrapper?.firstElementChild as HTMLElement | null;
		expect(sprite).not.toBeNull();
		expect(sprite?.getAttribute("style")).toContain(`filter:hue-rotate(${hueRotate}deg)`);
		expect(sprite?.querySelectorAll("img")).toHaveLength(2);

		const markup = host.innerHTML;
		expect(markup).not.toMatch(/animation\s*:/i);
		expect(markup).not.toMatch(/saturate\s*\(/i);
		expect(markup).not.toMatch(/blink|breath|bobbit-bob|cancel|compact|streaming|busy/i);
		expect(timeoutSpy).not.toHaveBeenCalled();
		expect(animationFrameSpy).not.toHaveBeenCalled();

		const expectedBodyDraws = resolveBodyPixels(CANONICAL_PALETTE, "center", false).map(
			([x, y, color]): DrawCall => ({ x: x * 8, y: y * 8, width: 8, height: 8, color }),
		);
		expect(contexts[0]?.drawCalls).toEqual(expectedBodyDraws);
	});
});
