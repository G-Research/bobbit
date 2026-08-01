import { render } from "lit";
import { WriteRenderer } from "../../src/ui/tools/renderers/WriteRenderer.js";
import { EditRenderer } from "../../src/ui/tools/renderers/EditRenderer.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const FONT_STACK = '"Fixture Source Sans", "Segoe UI", sans-serif';

const hostThemeStyle = document.createElement("style");
hostThemeStyle.dataset.fixture = "inline-html-host-theme";
hostThemeStyle.textContent = `
	:root {
		--background: #f8fafc;
		--foreground: #172033;
		--card: #ffffff;
		--positive: #15803d;
		--chart-1: #2563eb;
		font-family: ${FONT_STACK};
	}
	:root[data-palette="azure"] { --chart-1: #2563eb; }
	:root[data-palette="rose"] { --chart-1: #e11d48; }
	:root.dark {
		--background: #111827;
		--foreground: #f8fafc;
		--card: #1f2937;
		--positive: #4ade80;
	}
	:root.dark[data-palette="rose"] { --chart-1: #fb7185; }
	body { background: var(--background); color: var(--foreground); }
	.fixture-renderer-host { display: block; width: 720px; margin: 12px; }
`;
document.head.appendChild(hostThemeStyle);

function authoredDocument(marker: string): string {
	const markerLiteral = JSON.stringify(marker);
	return `<!doctype html>
<html>
<head>
	<script>
	(function () {
		var root = document.documentElement;
		var styles = getComputedStyle(root);
		window.__inlineThemeAuthored = {
			marker: ${markerLiteral},
			runs: (window.__inlineThemeAuthored && window.__inlineThemeAuthored.runs || 0) + 1,
			parse: {
				dark: root.classList.contains("dark"),
				palette: root.getAttribute("data-palette"),
				font: styles.fontFamily,
				tokens: {
					background: styles.getPropertyValue("--background").trim(),
					foreground: styles.getPropertyValue("--foreground").trim(),
					card: styles.getPropertyValue("--card").trim(),
					positive: styles.getPropertyValue("--positive").trim(),
					chart: styles.getPropertyValue("--chart-1").trim()
				}
			}
		};
	})();
	<\/script>
	<style>
		html, body { margin: 0; background: var(--background); color: var(--foreground); font-family: inherit; }
		#theme-card { margin: 12px; padding: 12px; background: var(--card); color: var(--foreground); border: 2px solid var(--chart-1); }
		#semantic-probe { color: var(--positive); }
	</style>
</head>
<body>
	<main id="theme-card" data-authored-marker=${markerLiteral}>
		<strong>Authored renderer script: ${marker}</strong>
		<span id="semantic-probe">semantic token probe</span>
	</main>
</body>
</html>`;
}

const documents = {
	write: authoredDocument("write-complete"),
	streamInitial: authoredDocument("stream-initial"),
	streamUpdate: authoredDocument("stream-updated"),
	streamComplete: authoredDocument("stream-complete"),
	edit: authoredDocument("edit-complete"),
};

const app = document.getElementById("app");
if (!app) throw new Error("#app missing");
app.innerHTML = `
	<section aria-label="WriteRenderer fixture"><div id="write-host" class="fixture-renderer-host"></div></section>
	<section aria-label="EditRenderer fixture"><div id="edit-host" class="fixture-renderer-host"></div></section>
`;

const writeHost = document.getElementById("write-host") as HTMLElement;
const editHost = document.getElementById("edit-host") as HTMLElement;
const writeRenderer = new WriteRenderer();
const editRenderer = new EditRenderer();
let editResponseContent = documents.edit;
const fetchLog: Array<{ url: string; authorization: string }> = [];
const swipeMessages: unknown[] = [];

function okResult(toolName: string, toolCallId: string, details?: Record<string, unknown>): any {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		isError: false,
		content: [{ type: "text", text: "ok" }],
		details,
		timestamp: Date.now(),
	};
}

function setHostTheme(dark: boolean, palette: string): void {
	const root = document.documentElement;
	root.classList.toggle("dark", dark);
	root.setAttribute("data-palette", palette);
}

function renderWriteDocument(content: string, complete: boolean): void {
	const output = writeRenderer.render(
		{ path: "source-theme-card.html", content },
		complete ? okResult("write", "write-theme-call") : undefined,
		!complete,
	);
	render(output.content, writeHost);
}

function renderEditTemplate(): void {
	const params = {
		path: "edited-theme-card.htm",
		oldText: "before",
		newText: "after",
	};
	const result = okResult("edit", "edit-theme-call", {
		diff: "@@ -1 +1 @@\n-before\n+after",
	});
	render(editRenderer.render(params, result, false).content, editHost);
}

async function renderEditDocument(content: string): Promise<void> {
	editResponseContent = content;
	await new Promise<void>((resolve, reject) => {
		const timeout = window.setTimeout(() => {
			document.removeEventListener("bobbit-tool-preview-ready", onReady);
			reject(new Error("EditRenderer did not request a cached HTML re-render"));
		}, 5_000);
		const onReady = () => {
			window.clearTimeout(timeout);
			document.removeEventListener("bobbit-tool-preview-ready", onReady);
			renderEditTemplate();
			requestAnimationFrame(() => resolve());
		};
		document.addEventListener("bobbit-tool-preview-ready", onReady);
		renderEditTemplate();
	});
}

function hostFrame(hostId: string): HTMLIFrameElement {
	const iframe = document.querySelector(`#${hostId} iframe`) as HTMLIFrameElement | null;
	if (!iframe) throw new Error(`iframe missing from #${hostId}`);
	return iframe;
}

function tokenValues(root: HTMLElement): Record<string, string> {
	const styles = getComputedStyle(root);
	return {
		background: styles.getPropertyValue("--background").trim(),
		foreground: styles.getPropertyValue("--foreground").trim(),
		card: styles.getPropertyValue("--card").trim(),
		positive: styles.getPropertyValue("--positive").trim(),
		chart: styles.getPropertyValue("--chart-1").trim(),
	};
}

function frameState(hostId: string): Record<string, unknown> {
	const host = document.getElementById(hostId);
	if (!host) throw new Error(`#${hostId} missing`);
	const iframe = hostFrame(hostId);
	const frameDocument = iframe.contentDocument;
	const frameWindow = iframe.contentWindow as (Window & { __inlineThemeAuthored?: unknown }) | null;
	const root = frameDocument?.documentElement;
	const card = frameDocument?.getElementById("theme-card");
	const semantic = frameDocument?.getElementById("semantic-probe");
	const source = host.querySelector("code-block") as (HTMLElement & { code?: string }) | null;
	const sourceContainer = source?.parentElement;
	return {
		identity: iframe.dataset.fixtureIdentity || "",
		sandbox: iframe.getAttribute("sandbox"),
		srcdoc: iframe.srcdoc,
		dark: root?.classList.contains("dark") ?? false,
		palette: root?.getAttribute("data-palette") ?? null,
		font: root ? getComputedStyle(root).fontFamily : "",
		tokens: root ? tokenValues(root) : {},
		resolved: root && card && semantic ? {
			background: getComputedStyle(root).backgroundColor,
			foreground: getComputedStyle(root).color,
			card: getComputedStyle(card).backgroundColor,
			cardForeground: getComputedStyle(card).color,
			positive: getComputedStyle(semantic).color,
			chart: getComputedStyle(card).borderTopColor,
		} : null,
		authored: frameWindow?.__inlineThemeAuthored ?? null,
		source: source?.code ?? null,
		sourceCollapsed: sourceContainer?.classList.contains("max-h-0") ?? null,
		streamingChrome: iframe.nextElementSibling instanceof HTMLDivElement,
	};
}

function tagFrame(hostId: string, identity: string): void {
	hostFrame(hostId).dataset.fixtureIdentity = identity;
}

async function dispatchSwipe(hostId: string): Promise<unknown[]> {
	const doc = hostFrame(hostId).contentDocument;
	if (!doc) throw new Error("iframe document unavailable");
	const dispatch = (type: string, property: "touches" | "changedTouches", x: number, y: number) => {
		const event = new Event(type, { bubbles: true, cancelable: true });
		Object.defineProperty(event, property, { value: [{ clientX: x, clientY: y }] });
		doc.dispatchEvent(event);
	};
	swipeMessages.length = 0;
	dispatch("touchstart", "touches", 10, 10);
	dispatch("touchmove", "touches", 80, 12);
	dispatch("touchend", "changedTouches", 100, 12);
	await new Promise((resolve) => window.setTimeout(resolve, 50));
	return swipeMessages.slice();
}

window.addEventListener("message", (event) => {
	if (typeof event.data?.type === "string" && event.data.type.startsWith("preview-swipe")) {
		swipeMessages.push(event.data);
	}
});

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const headers = new Headers(init?.headers);
	fetchLog.push({ url, authorization: headers.get("Authorization") || "" });
	if (url.includes(`/api/sessions/${SESSION_ID}/file-content`)) {
		return new Response(JSON.stringify({ content: editResponseContent }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}
	return new Response(JSON.stringify({ error: `Unhandled fixture request: ${url}` }), {
		status: 404,
		headers: { "Content-Type": "application/json" },
	});
}) as typeof window.fetch;

window.location.hash = `#/session/${SESSION_ID}`;
localStorage.setItem("gateway.url", "http://fixture.invalid");
localStorage.setItem("gateway.token", "fixture-token");
setHostTheme(false, "azure");

(window as any).__inlineThemeDocuments = documents;
(window as any).__inlineThemeFixtureConstants = { SESSION_ID, FONT_STACK };
(window as any).__setInlineThemeHost = setHostTheme;
(window as any).__renderInlineThemeWrite = renderWriteDocument;
(window as any).__renderInlineThemeEdit = renderEditDocument;
(window as any).__inlineThemeFrameState = frameState;
(window as any).__tagInlineThemeFrame = tagFrame;
(window as any).__dispatchInlineThemeSwipe = dispatchSwipe;
(window as any).__inlineThemeFetchLog = () => fetchLog.slice();
(window as any).__inlineThemeFixtureReady = true;
