// Migrated from tests/gate-verification-markdown.spec.ts (v2-dom tier).
// The legacy fixture reimplemented the step-output rendering decisions in plain JS.
// This port renders the REAL <gate-verification-live> and <verification-output-modal>
// components under happy-dom and asserts the same user-visible facts:
//   - agent steps (type !== "command") render a <markdown-block>; command steps a <pre>
//   - only command steps run their output through ANSI-to-HTML conversion
//   - the real hasAnsi() detector
import { afterEach, describe, expect, it } from "vitest";
// Importing GateVerificationLive registers <gate-verification-live>,
// <verification-output-modal> and <live-timer> (side-effect imports).
import "../../src/ui/tools/renderers/GateVerificationLive.js";
// Pre-import the markdown chunk (ensureMarkdownBlock lazy-loads it) so the
// <markdown-block> decorator runs while happy-dom's customElements is live.
import "../../src/ui/lazy/safe-markdown-block.js";
import { hasAnsi } from "../../src/ui/utils/ansi.js";

afterEach(() => { document.body.innerHTML = ""; });

async function mountModal(stepType: string, initialOutput = "output"): Promise<HTMLElement> {
	const el = document.createElement("verification-output-modal") as any;
	el.stepType = stepType;
	el.initialOutput = initialOutput;
	el.open = true;
	document.body.appendChild(el);
	await el.updateComplete;
	return document.querySelector(".verif-output-body") as HTMLElement;
}

async function mountLive(steps: any[], finalStatus = "passed"): Promise<HTMLElement> {
	const el = document.createElement("gate-verification-live") as any;
	el.finalStatus = finalStatus;
	el.initialSteps = steps;
	document.body.appendChild(el);
	await el.updateComplete;
	return el;
}

const cards = (el: HTMLElement) => Array.from(el.querySelectorAll("div.border.border-border.rounded")) as HTMLElement[];

async function expandCard(el: HTMLElement, i: number): Promise<HTMLElement> {
	const header = cards(el)[i].querySelector(".cursor-pointer") as HTMLElement;
	header.click();
	await (el as any).updateComplete;
	return cards(el)[i];
}

describe("VerificationOutputModal — agent (markdown) vs command (pre) body", () => {
	it("llm-review step renders a markdown div, not a pre", async () => {
		const body = await mountModal("llm-review");
		expect(body.tagName).toBe("DIV");
		expect(body.querySelector("markdown-block")).toBeTruthy();
	});

	it("agent-qa step renders a markdown div, not a pre", async () => {
		const body = await mountModal("agent-qa");
		expect(body.tagName).toBe("DIV");
		expect(body.querySelector("markdown-block")).toBeTruthy();
	});

	it("command step renders a pre, not markdown", async () => {
		const body = await mountModal("command");
		expect(body.tagName).toBe("PRE");
		expect(body.querySelector("markdown-block")).toBeNull();
	});

	it("empty step type renders a pre (command default)", async () => {
		const body = await mountModal("");
		expect(body.tagName).toBe("PRE");
	});

	it("unknown future step type renders a markdown div (future-proof)", async () => {
		const body = await mountModal("agent-linter");
		expect(body.tagName).toBe("DIV");
		expect(body.querySelector("markdown-block")).toBeTruthy();
	});
});

describe("GateVerificationLive — expanded step output element", () => {
	it("non-command steps expand to a markdown-block; command steps to a pre", async () => {
		const el = await mountLive([
			{ name: "Type check", type: "command", status: "passed", output: "All good" },
			{ name: "Code review", type: "llm-review", status: "passed", output: "## Review\n\n- Looks good" },
			{ name: "QA test", type: "agent-qa", status: "passed", output: "## QA\n\nAll passed" },
			{ name: "Lint", type: "command", status: "passed", output: "0 errors" },
		]);
		expect(cards(el)).toHaveLength(4);

		const c0 = await expandCard(el, 0);
		expect(c0.querySelector("pre")).toBeTruthy();
		expect(c0.querySelector("markdown-block")).toBeNull();

		const c1 = await expandCard(el, 1);
		expect(c1.querySelector("markdown-block")).toBeTruthy();
		expect(c1.querySelector("pre")).toBeNull();

		const c2 = await expandCard(el, 2);
		expect(c2.querySelector("markdown-block")).toBeTruthy();

		const c3 = await expandCard(el, 3);
		expect(c3.querySelector("pre")).toBeTruthy();
		expect(c3.querySelector("markdown-block")).toBeNull();
	});

	it("running command step opens the live output modal carrying its type + output", async () => {
		// goalId left unset so the reconcile timer's fetch short-circuits.
		const el = (await mountLive([{ name: "e2e", type: "command", status: "running", output: "cmd output" }], "")) as any;
		(cards(el)[0].querySelector(".cursor-pointer") as HTMLElement).click();
		await el.updateComplete;
		const modal = el.querySelector("verification-output-modal") as any;
		expect(modal).toBeTruthy();
		await modal.updateComplete;
		const body = document.querySelector(".verif-output-body") as HTMLElement;
		expect(body.tagName).toBe("PRE"); // command step type propagated
		expect(body.textContent).toContain("cmd output");
	});
});

describe("ANSI handling — only command steps convert ANSI", () => {
	it("command step with ANSI codes renders converted colour spans", async () => {
		const body = await mountModal("command", "Tests: \x1b[32m12 passed\x1b[0m");
		expect(body.tagName).toBe("PRE");
		expect(body.querySelector('span[style*="--ansi"]')).toBeTruthy();
		expect(body.textContent).toContain("12 passed");
		expect(body.textContent).not.toContain("\x1b");
	});

	it("command step without ANSI codes renders plain text (no colour spans)", async () => {
		const body = await mountModal("command", "Tests: 12 passed");
		expect(body.tagName).toBe("PRE");
		expect(body.querySelector('span[style*="--ansi"]')).toBeNull();
		expect(body.textContent).toContain("Tests: 12 passed");
	});

	it("agent step never converts ANSI — output goes to markdown verbatim", async () => {
		const body = await mountModal("llm-review", "Some \x1b[31mtext\x1b[0m");
		expect(body.tagName).toBe("DIV");
		expect(body.querySelector('span[style*="--ansi"]')).toBeNull();
		const md = body.querySelector("markdown-block") as any;
		expect(md.content).toContain("\x1b");
	});

	it("agent-qa step never converts ANSI", async () => {
		const body = await mountModal("agent-qa", "\x1b[32mgreen\x1b[0m text");
		expect(body.tagName).toBe("DIV");
		expect(body.querySelector('span[style*="--ansi"]')).toBeNull();
	});
});

describe("hasAnsi (real detector)", () => {
	it("detects ANSI escape sequences", () => {
		expect(hasAnsi("Tests: \x1b[32m12 passed\x1b[0m")).toBe(true);
		expect(hasAnsi("\x1b[31mred\x1b[0m")).toBe(true);
	});
	it("returns false for plain text", () => {
		expect(hasAnsi("Tests: 12 passed")).toBe(false);
		expect(hasAnsi("")).toBe(false);
	});
});
