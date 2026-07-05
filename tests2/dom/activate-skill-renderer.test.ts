// Migrated from tests/activate-skill-renderer.spec.ts (v2-dom tier).
// Renders the REAL ActivateSkillRenderer via lit into happy-dom (was an esbuild
// file:// bundle). Pins that a FAILED activation (no details.skillExpansion,
// with `activate_skill failed: …` text) surfaces a visible error — REGARDLESS
// of the `isError` flag (pi drops isError for tools that return rather than
// throw) — and that the happy path renders a <skill-chip>, no error text.
import { afterEach, describe, expect, it } from "vitest";
import { render } from "lit";
import { ActivateSkillRenderer } from "../../src/ui/tools/renderers/ActivateSkillRenderer.js";
import "../../src/ui/components/SkillChip.js";
// SkillChip.connectedCallback() fires ensureMarkdownBlock() — a fire-and-forget
// dynamic import of the KaTeX/marked/mini-lit <markdown-block> graph. Pre-import
// it statically so that chunk's top-level @customElement decorators run now
// (while happy-dom's customElements is live) instead of racing env teardown as
// an unhandled "customElements is not defined" rejection. See
// gate-signal-renderer.test.ts for the same pattern.
import "../../src/ui/lazy/safe-markdown-block.js";

const PARAMS = { name: "resolve-pr-conflicts", args: "497" };
const FAIL_TEXT = "activate_skill failed: name is required";

function renderActivate(params: any, result: any): HTMLElement {
	const container = document.createElement("div");
	container.id = "container";
	document.body.appendChild(container);
	const out = new ActivateSkillRenderer().render(params, result, false);
	render(out.content, container);
	return container;
}

afterEach(() => { document.body.innerHTML = ""; });

describe("ActivateSkillRenderer failed-activation surfacing", () => {
	it("no skillExpansion + content text + isError:true → visible error text (not benign header)", () => {
		const el = renderActivate(PARAMS, {
			isError: true,
			content: [{ type: "text", text: FAIL_TEXT }],
		});
		expect(el.querySelector("div.text-destructive")?.textContent).toContain(FAIL_TEXT);
		// The benign "Activating…" header must NOT be shown.
		expect(el.textContent || "").not.toContain("Activating");
	});

	it("no skillExpansion + content text WITHOUT isError flag → STILL visible error text", () => {
		const el = renderActivate(PARAMS, {
			// NO isError field — pi drops it for tools that return rather than throw.
			content: [{ type: "text", text: FAIL_TEXT }],
		});
		expect(el.querySelector("div.text-destructive")?.textContent).toContain(FAIL_TEXT);
		expect(el.textContent || "").not.toContain("Activating");
	});

	it("happy path with skillExpansion → renders skill chip, no error text", () => {
		const el = renderActivate(PARAMS, {
			content: [{ type: "text", text: "EXPANDED BODY" }],
			details: {
				skillExpansion: {
					name: "resolve-pr-conflicts",
					args: "497",
					source: "project",
					filePath: "/x/SKILL.md",
					expanded: "EXPANDED BODY",
				},
			},
		});
		expect(el.querySelectorAll("skill-chip").length).toBe(1);
		expect(el.querySelectorAll("div.text-destructive").length).toBe(0);
	});
});
