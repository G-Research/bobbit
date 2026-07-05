// Migrated from tests/markdown-throttle.spec.ts (v2-dom tier).
// Renders the REAL <assistant-message> lit component under happy-dom, replacing
// the esbuild file:// bundle. Pins the streaming markdown-block content throttle:
// mid-stream updates are coalesced, final content is always accurate, and the
// throttle snapshot resets across distinct messages.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Under vitest pool:forks + isolate:false each test file runs in its OWN
// happy-dom realm, but the module graph is cached across files in the fork — so
// a component module's top-level @customElement define only ever registers the
// tag in the FIRST importing file's realm. `vi.resetModules()` forces this file
// to re-evaluate the component graph fresh, so its decorators define the tag in
// THIS realm. Importing after the reset (dynamically) also keeps the component's
// lit instance the same one this file uses. We evaluate session-manager first to
// initialize the pack-panels ⇄ session-manager cycle before Messages.js's app/*
// imports hit it as a TDZ error under vite's native-ESM ordering.
beforeAll(async () => {
	vi.resetModules();
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/lazy/safe-markdown-block.js");
	await customElements.whenDefined("assistant-message");
});

afterEach(() => { document.body.innerHTML = ""; });

describe("AssistantMessage markdown-block content throttling", () => {
	it("streaming updates are throttled to markdown-block", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const updateCount = 15;

		const el = document.createElement("assistant-message") as any;
		el.isStreaming = true;
		el.message = { role: "assistant", content: [{ type: "text", text: "initial" }], stopReason: null };
		container.appendChild(el);
		await el.updateComplete;

		let changes = 0;
		let lastContent = "";
		for (let i = 0; i < updateCount; i++) {
			const newText = "Hello world ".repeat(i + 1) + `update-${i}`;
			el.message = { ...el.message, content: [{ type: "text", text: newText }] };
			el.requestUpdate();
			await el.updateComplete;
			const mb = el.querySelector("markdown-block") as any;
			if (mb) {
				const current = mb.content;
				if (current !== lastContent) { changes++; lastContent = current; }
			}
		}

		// With throttling, markdown-block does NOT update on every render.
		expect(changes).toBeLessThan(updateCount);
	});

	it("final content is accurate after streaming stops", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const el = document.createElement("assistant-message") as any;
		el.isStreaming = true;
		el.message = { role: "assistant", content: [{ type: "text", text: "start" }], stopReason: null };
		container.appendChild(el);
		await el.updateComplete;

		for (let i = 0; i < 10; i++) {
			el.message = { ...el.message, content: [{ type: "text", text: `streaming update ${i}` }] };
			el.requestUpdate();
			await el.updateComplete;
		}

		const expectedFinal = "This is the final complete message with all content.";
		el.isStreaming = false;
		el.message = { role: "assistant", content: [{ type: "text", text: expectedFinal }], stopReason: "stop" };
		el.requestUpdate();
		await el.updateComplete;

		const mb = el.querySelector("markdown-block") as any;
		expect(mb?.content ?? null).toBe(expectedFinal);
	});

	it("content identity resets across different messages", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const el = document.createElement("assistant-message") as any;
		el.isStreaming = true;
		el.message = { role: "assistant", content: [{ type: "text", text: "first message" }], stopReason: null };
		container.appendChild(el);
		await el.updateComplete;

		const first = (el.querySelector("markdown-block") as any)?.content;

		el.message = { role: "assistant", content: [{ type: "text", text: "second message" }], stopReason: null };
		el.requestUpdate();
		await el.updateComplete;

		const second = (el.querySelector("markdown-block") as any)?.content;

		expect(first).toBe("first message");
		expect(second).toBe("second message");
	});
});
