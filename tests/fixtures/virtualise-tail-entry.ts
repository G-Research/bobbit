// Test entry for Phase 2 Opt-H — virtualise eager-tail.
//
// Mounts `<message-list>` with a controllable mix of messages so we can
// exercise the viewport-driven eager set. Reuses the same lit/perf-flags
// plumbing as `defer-offscreen-render-entry.ts`.
//
// Helpers exposed on `window`:
//   __mountMessageList(slotId, opts) — opts.count, opts.kind
//     kind:
//       'user'       — 60px est-height each (existing default)
//       'fat'        — assistant w/ ~800-char text + 2 tool calls → ~408px est
//   __setPerfFlag, __reloadPerfFlags — flag plumbing
//   __setViewportHeight(px)          — stubs `window.innerHeight`
//   __countDeferred, __countEager, __countPlaceholders, __countUserMessages,
//                                    __countAssistantMessages
import { html, render } from "lit";
import "../../src/ui/components/DeferredBlock.js";
import "../../src/ui/components/MessageList.js";
import { reloadPerfFlags, setPerfFlag } from "../../src/app/perf-flags.js";

// No-op IO shim — tests assert on first-paint eager set; we never drive IO.
class NoopIO {
	observe(): void { /* noop */ }
	unobserve(): void { /* noop */ }
	disconnect(): void { /* noop */ }
	takeRecords(): any[] { return []; }
}
(window as any).IntersectionObserver = NoopIO;

(window as any).__setPerfFlag = (name: string, enabled: boolean): void => {
	setPerfFlag(name, enabled);
	reloadPerfFlags();
};
(window as any).__reloadPerfFlags = (): void => { reloadPerfFlags(); };

(window as any).__setViewportHeight = (px: number): void => {
	Object.defineProperty(window, "innerHeight", { configurable: true, value: px });
};

function buildMessages(count: number, kind: "user" | "fat"): any[] {
	const out: any[] = [];
	for (let i = 0; i < count; i++) {
		if (kind === "user") {
			out.push({ role: "user", id: `u-${i}`, content: `message ${i}` });
		} else {
			// estimateMessageHeight for assistant:
			//   48 + ceil(textChars/80)*24 + toolBlocks*60
			// 800 chars + 2 tools → 48 + 10*24 + 120 = 408px.
			const text = "x".repeat(800);
			out.push({
				role: "assistant",
				id: `a-${i}`,
				content: [
					{ type: "text", text },
					{ type: "toolCall", id: `t-${i}-1`, name: "read", arguments: {} },
					{ type: "toolCall", id: `t-${i}-2`, name: "read", arguments: {} },
				],
				stopReason: "end_turn",
			});
		}
	}
	return out;
}

(window as any).__mountMessageList = (
	slotId: string,
	opts: { count: number; kind?: "user" | "fat" },
): void => {
	const slot = document.getElementById(slotId)!;
	const messages = buildMessages(opts.count, opts.kind ?? "user");
	render(
		html`<message-list
			.messages=${messages}
			.tools=${[]}
			.isStreaming=${false}
		></message-list>`,
		slot,
	);
};

(window as any).__countDeferred = (): number =>
	document.querySelectorAll("deferred-block").length;
(window as any).__countEager = (): number =>
	document.querySelectorAll(
		"deferred-block user-message, deferred-block assistant-message",
	).length;
(window as any).__countPlaceholders = (): number =>
	document.querySelectorAll("deferred-block .deferred-block-placeholder").length;
(window as any).__countUserMessages = (): number =>
	document.querySelectorAll("deferred-block user-message").length;
(window as any).__countAssistantMessages = (): number =>
	document.querySelectorAll("deferred-block assistant-message").length;

// Bypass requestIdleCallback for deterministic test timing.
(window as any).requestIdleCallback = ((cb: any) => {
	queueMicrotask(() => cb({ didTimeout: false, timeRemaining: () => 50 }));
	return 0;
}) as any;
(window as any).cancelIdleCallback = (() => { /* noop */ }) as any;

(window as any).__ready = true;
