import {
	PREVIEW_BRIDGE_VERSION,
	PREVIEW_THEME_LIMITS,
	PREVIEW_THEME_PROPERTY_NAMES,
	type PreviewChildMessage,
	type PreviewHostMessage,
} from "../shared/preview-bridge-scripts.js";

export const PREVIEW_INLINE_HEIGHT_LIMITS = Object.freeze({ min: 32, max: 600 });

type PreviewFrameKind = "inline" | "side-panel";

interface PreviewFrameRegistration {
	iframe: HTMLIFrameElement;
	kind: PreviewFrameKind;
}

const registrations = new Map<HTMLIFrameElement, PreviewFrameRegistration>();
let themeObserver: MutationObserver | undefined;
let listening = false;

function boundedOptionalString(value: string | null | undefined, maxLength: number): string | undefined {
	if (!value) return undefined;
	const normalized = value.trim();
	return normalized && normalized.length <= maxLength ? normalized : undefined;
}

/** Snapshot only the finite cosmetic token allowlist. Repository frames never
 * receive DOM access, arbitrary stylesheet contents, or application state. */
export function capturePreviewTheme(root: HTMLElement = document.documentElement): PreviewHostMessage {
	const styles = getComputedStyle(root);
	const properties: Record<string, string> = {};
	let propertyCount = 0;
	for (const name of PREVIEW_THEME_PROPERTY_NAMES) {
		if (propertyCount >= PREVIEW_THEME_LIMITS.maxProperties) break;
		const value = styles.getPropertyValue(name).trim();
		if (value && value.length <= PREVIEW_THEME_LIMITS.maxPropertyValueLength) {
			properties[name] = value;
			propertyCount += 1;
		}
	}

	const palette = boundedOptionalString(root.getAttribute("data-palette"), PREVIEW_THEME_LIMITS.maxPaletteLength);
	const fontFamily = boundedOptionalString(styles.fontFamily, PREVIEW_THEME_LIMITS.maxFontFamilyLength);
	return {
		type: "bobbit-preview-theme",
		version: PREVIEW_BRIDGE_VERSION,
		dark: root.classList.contains("dark"),
		...(palette && /^[a-zA-Z0-9_-]+$/.test(palette) ? { palette } : {}),
		...(fontFamily ? { fontFamily } : {}),
		properties,
	};
}

/** Stable preparation identity for the bounded theme protocol. Live theme
 * values are deliberately excluded so a later host repaint cannot reload a
 * completed iframe and rerun authored initialization. */
export function previewThemeIdentity(): string {
	return `preview-bridge-v${PREVIEW_BRIDGE_VERSION}:${PREVIEW_THEME_PROPERTY_NAMES.join(",")}`;
}

function currentRegistrationForSource(source: MessageEventSource | null): PreviewFrameRegistration | undefined {
	if (!source) return undefined;
	for (const registration of registrations.values()) {
		if (!registration.iframe.isConnected) continue;
		if (registration.iframe.contentWindow === source) return registration;
	}
	return undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const ownKeys = Object.keys(value);
	return ownKeys.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function childMessage(data: unknown): PreviewChildMessage | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const value = data as Record<string, unknown>;
	if (
		value.type === "bobbit-preview-ready"
		&& value.version === PREVIEW_BRIDGE_VERSION
		&& hasExactKeys(value, ["type", "version"])
	) return value as PreviewChildMessage;
	if (
		value.type === "bobbit-preview-resize"
		&& value.version === PREVIEW_BRIDGE_VERSION
		&& typeof value.height === "number"
		&& Number.isFinite(value.height)
		&& hasExactKeys(value, ["type", "version", "height"])
	) return value as PreviewChildMessage;
	return undefined;
}

function postTheme(registration: PreviewFrameRegistration, theme = capturePreviewTheme()): void {
	const target = registration.iframe.contentWindow;
	if (!target) return;
	try {
		target.postMessage(theme, "*");
	} catch { /* a detached/replaced browsing context loses cosmetics only */ }
}

function onMessage(event: MessageEvent): void {
	const registration = currentRegistrationForSource(event.source);
	if (!registration) return;
	const message = childMessage(event.data);
	if (!message) return;

	if (message.type === "bobbit-preview-ready") {
		postTheme(registration);
		return;
	}
	if (message.type === "bobbit-preview-resize" && registration.kind === "inline") {
		const height = Math.max(
			PREVIEW_INLINE_HEIGHT_LIMITS.min,
			Math.min(PREVIEW_INLINE_HEIGHT_LIMITS.max, message.height),
		);
		registration.iframe.style.height = `${height}px`;
	}
}

function sendThemeToAll(): void {
	let theme: PreviewHostMessage;
	try {
		theme = capturePreviewTheme();
	} catch {
		return;
	}
	for (const registration of registrations.values()) {
		if (registration.iframe.isConnected) postTheme(registration, theme);
	}
}

function startHost(): void {
	if (!listening) {
		window.addEventListener("message", onMessage);
		listening = true;
	}
	if (!themeObserver && typeof MutationObserver === "function") {
		themeObserver = new MutationObserver(sendThemeToAll);
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-palette", "style"],
		});
	}
}

function stopHostIfIdle(): void {
	if (registrations.size > 0) return;
	if (listening) {
		window.removeEventListener("message", onMessage);
		listening = false;
	}
	themeObserver?.disconnect();
	themeObserver = undefined;
}

/** Register exactly the iframe's current WindowProxy as a cosmetic channel.
 * The returned cleanup is identity-safe when Lit replaces a ref callback. */
export function registerPreviewFrame(
	iframe: HTMLIFrameElement,
	kind: PreviewFrameKind,
): () => void {
	const existing = registrations.get(iframe);
	if (existing) registrations.delete(iframe);
	const registration = { iframe, kind } satisfies PreviewFrameRegistration;
	registrations.set(iframe, registration);
	startHost();
	postTheme(registration);

	return () => {
		if (registrations.get(iframe) !== registration) return;
		registrations.delete(iframe);
		stopHostIfIdle();
	};
}

/** Deterministic test seam; production cleanup is owned by iframe ref removal. */
export function resetPreviewFrameHostForTests(): void {
	registrations.clear();
	stopHostIfIdle();
}
