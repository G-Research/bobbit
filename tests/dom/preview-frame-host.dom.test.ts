import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	capturePreviewTheme,
	registerPreviewFrame,
	resetPreviewFrameHostForTests,
} from "../../src/ui/preview-frame-host.js";

function message(source: MessageEventSource | null, data: unknown): MessageEvent {
	return new MessageEvent("message", { source, data });
}

describe("opaque preview frame host", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		document.documentElement.className = "dark";
		document.documentElement.setAttribute("data-palette", "forest");
		document.documentElement.style.cssText = "--background: initial; --chart-1: chart; font-family: Host Sans;";
	});

	afterEach(() => {
		resetPreviewFrameHostForTests();
		vi.restoreAllMocks();
		document.body.innerHTML = "";
		document.documentElement.className = "";
		document.documentElement.removeAttribute("data-palette");
		document.documentElement.removeAttribute("style");
	});

	it("sends bounded theme state only to a registered exact WindowProxy", () => {
		const iframe = document.createElement("iframe");
		document.body.appendChild(iframe);
		const target = iframe.contentWindow!;
		const postMessage = vi.spyOn(target, "postMessage").mockImplementation(() => {});
		const cleanup = registerPreviewFrame(iframe, "inline");

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: "bobbit-preview-theme",
			version: 1,
			dark: true,
			palette: "forest",
			properties: expect.objectContaining({ "--background": "initial", "--chart-1": "chart" }),
		}), "*");
		postMessage.mockClear();

		window.dispatchEvent(message(window, { type: "bobbit-preview-ready", version: 1 }));
		window.dispatchEvent(message(target, { type: "bobbit-preview-ready", version: 1, extra: true }));
		expect(postMessage).not.toHaveBeenCalled();
		window.dispatchEvent(message(target, { type: "bobbit-preview-ready", version: 1 }));
		expect(postMessage).toHaveBeenCalledTimes(1);

		cleanup();
		postMessage.mockClear();
		window.dispatchEvent(message(target, { type: "bobbit-preview-ready", version: 1 }));
		expect(postMessage).not.toHaveBeenCalled();
	});

	it("resends live root mutations without recreating the registered frame", async () => {
		const iframe = document.createElement("iframe");
		document.body.appendChild(iframe);
		const target = iframe.contentWindow!;
		const postMessage = vi.spyOn(target, "postMessage").mockImplementation(() => {});
		const cleanup = registerPreviewFrame(iframe, "inline");
		postMessage.mockClear();

		document.documentElement.classList.remove("dark");
		document.documentElement.setAttribute("data-palette", "rose");
		document.documentElement.style.setProperty("--background", "live");
		await new Promise(resolve => setTimeout(resolve, 0));

		expect(iframe.contentWindow).toBe(target);
		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			dark: false,
			palette: "rose",
			properties: expect.objectContaining({ "--background": "live" }),
		}), "*");
		cleanup();
	});

	it("clamps inline resize and ignores side-panel, stale, malformed and foreign sources", () => {
		const inline = document.createElement("iframe");
		const sidePanel = document.createElement("iframe");
		document.body.append(inline, sidePanel);
		const cleanupInline = registerPreviewFrame(inline, "inline");
		const cleanupSide = registerPreviewFrame(sidePanel, "side-panel");

		window.dispatchEvent(message(window, { type: "bobbit-preview-resize", version: 1, height: 200 }));
		window.dispatchEvent(message(inline.contentWindow, { type: "bobbit-preview-resize", version: 1, height: Number.NaN }));
		window.dispatchEvent(message(inline.contentWindow, { type: "bobbit-preview-resize", version: 1, height: 12, extra: true }));
		expect(inline.style.height).toBe("");

		window.dispatchEvent(message(inline.contentWindow, { type: "bobbit-preview-resize", version: 1, height: 12 }));
		expect(inline.style.height).toBe("32px");
		window.dispatchEvent(message(inline.contentWindow, { type: "bobbit-preview-resize", version: 1, height: 900 }));
		expect(inline.style.height).toBe("600px");
		window.dispatchEvent(message(sidePanel.contentWindow, { type: "bobbit-preview-resize", version: 1, height: 200 }));
		expect(sidePanel.style.height).toBe("");

		cleanupInline();
		cleanupSide();
	});

	it("omits oversized cosmetic values from snapshots", () => {
		document.documentElement.setAttribute("data-palette", "x".repeat(65));
		document.documentElement.style.setProperty("--background", "x".repeat(513));
		document.documentElement.style.fontFamily = "x".repeat(257);
		const theme = capturePreviewTheme();
		expect(theme.palette).toBeUndefined();
		expect(theme.fontFamily).toBeUndefined();
		expect(theme.properties["--background"]).toBeUndefined();
	});
});
