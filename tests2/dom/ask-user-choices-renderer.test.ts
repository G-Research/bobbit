import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/ask-user-choices-renderer.spec.ts (v2-dom tier).
// Renders the REAL AskUserChoicesRenderer via lit into happy-dom, replacing the
// esbuild file:// bundle. Pins the gating between error chip and interactive
// widget for the three completed-result shapes.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { html, render } from "lit";
import { AskUserChoicesRenderer } from "../../src/ui/tools/renderers/AskUserChoicesRenderer.js";
import "../../src/app/message-reducer.js";
import type { ToolRenderContext } from "../../src/ui/tools/types.js";
import "../../src/ui/components/AskUserChoicesWidget.js";

let state: typeof import("../../src/app/state.js")["state"];
let registerToolRenderer: typeof import("../../src/ui/tools/renderer-registry.js")["registerToolRenderer"];

beforeAll(async () => {
	// Match the app boot order before loading Messages' host-capability graph.
	await import("../../src/app/session-manager.js");
	await import("../../src/ui/components/Messages.js");
	await import("../../src/ui/components/MessageList.js");
	({ state } = await import("../../src/app/state.js"));
	({ registerToolRenderer } = await import("../../src/ui/tools/renderer-registry.js"));
	__syncCE();
});

const PARAMS = {
	questions: [
		{ question: "Q1", options: ["a", "b"], tab_label: "First" },
		{ question: "Q2", options: ["c", "d"], tab_label: "Second" },
	],
};

async function renderAsk(params: any, result: any, ctx?: ToolRenderContext): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new AskUserChoicesRenderer().render(params, result, false, ctx);
	render(out.content, container);
	// The renderer emits an <ask-user-choices-widget>; its light-DOM content
	// (.ask-error / tabs / .ask-submit) only exists after the widget's async
	// first update settles.
	await customElements.whenDefined("ask-user-choices-widget");
	const widget = container.querySelector("ask-user-choices-widget") as any;
	if (widget?.updateComplete) await widget.updateComplete;
	return container;
}
const count = (el: HTMLElement, sel: string) => el.querySelectorAll(sel).length;

afterEach(() => {
	document.body.innerHTML = "";
	state.remoteAgent = null;
	state.gatewaySessions = [];
	state.archivedSessions = [];
	vi.restoreAllMocks();
});

describe("AskUserChoicesRenderer error-vs-interactive gating", () => {
	it("isError:true result renders minimal error chip, not interactive widget", async () => {
		const el = await renderAsk(PARAMS, {
			isError: true,
			content: [{ type: "text", text: JSON.stringify({ error: "ask_user_choices: questions[1].tab_label is required when there are multiple questions." }) }],
		});
		expect(count(el, ".ask-error")).toBe(1);
		expect(count(el, '[role="tab"]')).toBe(0);
		expect(count(el, ".ask-submit")).toBe(0);
	});

	it("{error:'...'} content without isError flag also renders minimal error chip (defense-in-depth)", async () => {
		const el = await renderAsk(PARAMS, {
			content: [{ type: "text", text: JSON.stringify({ error: "some failure" }) }],
		});
		expect(count(el, ".ask-error")).toBe(1);
		expect(count(el, '[role="tab"]')).toBe(0);
		expect(count(el, ".ask-submit")).toBe(0);
	});

	it("{status:'posted'} stub renders interactive widget (tabs + submit)", async () => {
		const el = await renderAsk(PARAMS, {
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: "abc" }) }],
		});
		expect(count(el, '[role="tab"]')).toBe(2);
		expect(count(el, ".ask-submit")).toBe(1);
		expect(count(el, ".ask-error")).toBe(0);
	});

	it("renders an unanswered historical question visibly but without any submit path", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const el = await renderAsk(PARAMS, {
			content: [{ type: "text", text: JSON.stringify({ status: "posted", tool_use_id: "old-ask" }) }],
		}, {
			capabilityMode: "history",
			toolUseId: "old-ask",
		});
		const widget = el.querySelector("ask-user-choices-widget") as any;
		expect(el.querySelector(".ask-history-readonly")?.textContent).toContain("read-only history");
		expect(el.querySelectorAll(".ask-option")).toHaveLength(3);
		expect(el.querySelectorAll(".ask-submit")).toHaveLength(0);
		expect(Array.from(el.querySelectorAll("input")).every((input) => (input as HTMLInputElement).disabled)).toBe(true);

		// Even a stale/direct handler cannot cross the read-only boundary.
		await widget._submit();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("renders answered choices as a visibly completed, read-only summary", async () => {
		const el = await renderAsk(PARAMS, {
			content: [{
				type: "text",
				text: JSON.stringify({
					answers: [
						{ question: "Q1", selected: "a", other_text: null },
						{ question: "Q2", selected: "d", other_text: null },
					],
				}),
			}],
		});
		const widget = el.querySelector(".ask-widget") as HTMLElement;
		expect(widget.className).toContain("ask-answered");
		expect(el.querySelector(".ask-answered-badge")?.textContent).toContain("Answered");
		expect(widget.querySelector(".ask-question")?.className).toContain("opacity-70");
		expect(widget.querySelector('[role="radio"][aria-checked="true"]')?.className).toContain("opacity-70");
		expect(widget.querySelector('[role="radio"][aria-checked="false"]')?.className).toContain("opacity-30");
	});
});

describe("historical tool renderer capabilities", () => {
	it("omits current session, goal, answer lookup, and host while active tools keep them", async () => {
		const contexts: ToolRenderContext[] = [];
		registerToolRenderer("capability_probe_dom", {
			render: (_params, _result, _streaming, ctx) => {
				if (ctx) contexts.push(ctx);
				return { content: html`<button class="probe-action">Probe</button>`, isCustom: false };
			},
		});
		state.remoteAgent = {
			gatewaySessionId: "current-session",
			findAskResponseAnswers: vi.fn(),
		} as any;
		state.gatewaySessions = [{ id: "current-session", goalId: "current-goal" }] as any;

		const messages = [
			{
				id: "assistant-probe",
				role: "assistant",
				content: [{ type: "toolCall", id: "probe-call", name: "capability_probe_dom", arguments: {} }],
				timestamp: 1,
			},
			{
				id: "result-probe",
				role: "toolResult",
				toolCallId: "probe-call",
				toolName: "capability_probe_dom",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 2,
			},
		];
		const mount = async (mode: "active" | "history") => {
			const list = document.createElement("message-list") as any;
			list.messages = messages;
			list.capabilityMode = mode;
			document.body.appendChild(list);
			await list.updateComplete;
			for (let i = 0; i < 3; i++) {
				await Promise.resolve();
				await Promise.all(Array.from(list.querySelectorAll("*")).map((el: any) => el.updateComplete));
			}
			return list;
		};

		const history = await mount("history");
		expect(history.querySelector(".probe-action")).not.toBeNull();
		const historical = contexts.at(-1)!;
		expect(historical.capabilityMode).toBe("history");
		expect("sessionId" in historical).toBe(false);
		expect("goalId" in historical).toBe(false);
		expect("getAskResponseAnswers" in historical).toBe(false);
		expect("host" in historical).toBe(false);

		const active = await mount("active");
		expect(active.querySelector(".probe-action")).not.toBeNull();
		const live = contexts.at(-1)!;
		expect(live.capabilityMode).toBe("active");
		expect(live.sessionId).toBe("current-session");
		expect(live.goalId).toBe("current-goal");
		expect(live.getAskResponseAnswers).toBeTypeOf("function");
		expect(live.host).toBeDefined();
	});
});
