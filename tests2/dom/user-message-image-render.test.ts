import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/user-message-image-render.spec.ts (v2-dom tier).
//
// Renders the REAL <user-message> Lit component into happy-dom (replacing the
// esbuild-bundled file:// fixture) and pins that it renders image tiles from a
// user message's server-authoritative {type:"image"} content blocks (WP1/RC2/S6).
// Messages.js registers <user-message>; AttachmentTile.js registers
// <attachment-tile>. UserMessage.connectedCallback() calls ensureMarkdownBlock()
// (a fire-and-forget dynamic import) — we import safe-markdown-block so that
// chunk's @customElement decorators run now, while happy-dom's customElements is
// live, and the dynamic import resolves from cache instead of racing teardown.
//
// The Messages.js graph forms a session-manager ↔ pack-panels TDZ import cycle
// ("Cannot access 'sessionSwitcher' before initialization") when Messages is the
// static entry. Per the migration guide, break it with ordered dynamic imports in
// a beforeAll — session-manager FIRST so pack-panels fully initializes before
// session-manager's top-level setSessionSwitcher() runs — then syncCustomElements().
import { afterEach, beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/components/AttachmentTile.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	__syncCE();
});

// Tiny valid-ish base64 payload — the render only inspects the src prefix + tile presence.
const DATA =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function renderUserMessage(message: any): Promise<HTMLDivElement> {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	const el = document.createElement("user-message") as any;
	el.message = message;
	container.appendChild(el);
	if (el.updateComplete) await el.updateComplete;
	const tile = container.querySelector("attachment-tile") as any;
	if (tile?.updateComplete) await tile.updateComplete;
	return container;
}

afterEach(() => {
	document.body.innerHTML = "";
});

describe("UserMessage renders image tiles from authoritative content (WP1/RC2/S6)", () => {
	it("role:user + one image block + no attachments → exactly one tile, data:image/png src", async () => {
		const container = await renderUserMessage({
			role: "user",
			content: [
				{ type: "text", text: "hi" },
				{ type: "image", data: DATA, mimeType: "image/png" },
			],
			timestamp: 0,
		});
		expect(container.querySelectorAll("attachment-tile")).toHaveLength(1);
		const src = container.querySelector("attachment-tile img")!.getAttribute("src");
		expect(src?.startsWith("data:image/png;base64,")).toBe(true);
	});

	it("role:user with NO image block → zero tiles (default path unchanged)", async () => {
		const container = await renderUserMessage({
			role: "user",
			content: [{ type: "text", text: "no image here" }],
			timestamp: 0,
		});
		expect(container.querySelectorAll("attachment-tile")).toHaveLength(0);
	});

	it("JPEG content block → data:image/jpeg src (block's own mimeType, not hardcoded png)", async () => {
		const container = await renderUserMessage({
			role: "user",
			content: [{ type: "image", data: DATA, mimeType: "image/jpeg" }],
			timestamp: 0,
		});
		const src = container.querySelector("attachment-tile img")!.getAttribute("src");
		expect(src?.startsWith("data:image/jpeg;base64,")).toBe(true);
	});

	it("user-with-attachments with BOTH attachments AND image content → tiles from attachments (rich wins, no double)", async () => {
		const container = await renderUserMessage({
			role: "user-with-attachments",
			content: [
				{ type: "text", text: "hi" },
				{ type: "image", data: DATA, mimeType: "image/png" },
			],
			attachments: [
				{ id: "a", type: "image", fileName: "rich.png", mimeType: "image/png", size: 1, content: DATA, preview: DATA },
			],
			timestamp: 0,
		});
		// Rich attachments win → exactly ONE tile, not two (content + attachments).
		expect(container.querySelectorAll("attachment-tile")).toHaveLength(1);
	});
});
