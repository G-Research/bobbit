import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/team-tool-renderers.spec.ts (v2-dom tier).
// Renders the REAL TeamDismissRenderer via lit into a happy-dom container
// (replacing the esbuild file:// bundle) and asserts the same rendered text.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { TeamDismissRenderer } from "../../src/ui/tools/renderers/TeamToolRenderers.js";

const renderer = new TeamDismissRenderer();

function makeResult(text: string, details?: any, isError = false) {
	return {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "team_dismiss",
		isError,
		content: [{ type: "text", text }],
		details,
		timestamp: 0,
	};
}

function mixedText(result: any): string {
	return [
		`team_dismiss ${result.status} for ${result.sessionId}`,
		result.message ? `message: ${result.message}` : undefined,
		`retryable: ${result.retryable === true ? "true" : "false"}`,
		"",
		JSON.stringify(result, null, 2),
	].filter(Boolean).join("\n");
}

let container: HTMLElement;

function renderDismiss(result: any, params: any = { session_id: "fallback-session-000" }) {
	const out = renderer.render(params, result as any, false);
	render(out.content, container);
}

afterEach(() => { document.body.innerHTML = ""; });

function text() { return container.textContent || ""; }

describe("TeamDismissRenderer", () => {
	it("prefers structured details over mixed human text plus JSON", () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		const textBody = mixedText({ status: "dismissed", sessionId: "wrong-session-000", message: "Dismissed live agent.", retryable: false });
		renderDismiss(makeResult(textBody, {
			ok: true,
			status: "already-dismissed",
			sessionId: "owned-session-1234567890",
			message: "Agent was already archived.",
			retryable: false,
		}));

		expect(text()).toContain("Agent already dismissed");
		expect(text()).toContain("owned-sessio");
		expect(text()).toContain("Agent was already archived.");
		expect(text()).toContain("Do not retry.");
		expect(text()).not.toContain("Dismissed agent");
	});

	for (const scenario of [
		{ status: "dismissed", label: "Dismissed agent", message: "Terminated and archived.", retryable: false },
		{ status: "already-dismissed", label: "Agent already dismissed", message: "No live process remains.", retryable: false },
		{ status: "not-owned", label: "Dismiss failed — not owned", message: "Session belongs to another owner.", retryable: false },
		{ status: "not-found", label: "Dismiss failed — not found", message: "No session exists for that id.", retryable: false },
		{ status: "failed", label: "Dismiss failed", message: "Archive failed.", retryable: true },
	]) {
		it(`renders ${scenario.status} from mixed text JSON block`, () => {
			container = document.createElement("div");
			document.body.appendChild(container);
			const result = {
				ok: scenario.status === "dismissed" || scenario.status === "already-dismissed",
				status: scenario.status,
				sessionId: `session-${scenario.status}-abcdef`,
				message: scenario.message,
				retryable: scenario.retryable,
			};
			renderDismiss(makeResult(mixedText(result), undefined, scenario.status === "failed"));

			expect(text()).toContain(scenario.label);
			expect(text()).toContain(`session-${scenario.status}`.slice(0, 12));
			expect(text()).toContain(scenario.message);
			expect(text()).toContain(scenario.retryable ? "Retry may help." : "Do not retry.");
		});
	}
});
