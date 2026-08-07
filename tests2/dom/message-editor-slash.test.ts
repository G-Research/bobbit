import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/message-editor-slash.spec.ts (v2-dom tier).
// The legacy fixture mirrored MessageEditor's slash-autocomplete logic in plain JS;
// per the porting guide we render the REAL <message-editor> component and drive its
// input/keydown handlers. Slash skills are served via a stubbed /api/slash-skills
// fetch (same skills the mirror used). We reconstruct each pre-key composer state
// directly (value + caret + one input event) rather than replaying Playwright
// `pressSequentially`, because happy-dom does not preserve the textarea caret across
// Lit's `live()` re-render — the behavioral assertions (filter, in-place completion,
// preserved suffix, menu nav) are identical.
//
// PUNTED to browser (geometry): story 34's two "menu left offset" cases. The menu's
// horizontal offset comes from MessageEditor._getMenuLeft(), which measures a mirror
// <span>'s offsetWidth — happy-dom has no layout engine, so offsetWidth is always 0
// and the >0 / positional assertions cannot be exercised faithfully.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageEditor } from "../../src/ui/components/MessageEditor.js";

// See message-editor-ctrl-arrow.test.ts: re-register the tag in this file's window
// under vitest isolate:false.
if (!customElements.get("message-editor")) customElements.define("message-editor", MessageEditor);

const DEFAULT_SLASH_SKILLS = [
	{ name: "deploy", description: "Deploy to production", argumentHint: "<env>", source: "project" },
	{ name: "deploy-staging", description: "Deploy to staging", source: "project" },
	{ name: "skill-name", description: "A test skill", source: "personal" },
	{ name: "status", description: "Check status", source: "project" },
	{ name: "test", description: "Run tests", argumentHint: "<pattern>", source: "project" },
];
let slashSkills: any[];

beforeEach(() => {
	slashSkills = [...DEFAULT_SLASH_SKILLS];
	vi.stubGlobal("fetch", async (input: any): Promise<Response> => {
		const url = typeof input === "string" ? input : (input && input.url) || String(input);
		if (url.includes("/api/slash-skills")) {
			return new Response(JSON.stringify({ skills: slashSkills }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}
		return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

interface MountOptions {
	runtime?: "pi" | "claude-agent-sdk";
	onSend?: (text: string, attachments: unknown[]) => void;
	onCompact?: () => void;
	attachments?: unknown[];
}

async function mount(options: MountOptions = {}): Promise<any> {
	const el = document.createElement("message-editor") as any;
	// Runtime and onCompact are the composer dispatch boundary. Keep these tests
	// on the real component rather than reproducing the resolver in a fixture.
	el.runtime = options.runtime ?? "pi";
	el.onCompact = options.onCompact;
	el.onSend = options.onSend;
	el.attachments = options.attachments ?? [];
	el.cwd = "/tmp";
	el.showModelSelector = false;
	el.showThinkingSelector = false;
	el.showAttachmentButton = false;
	document.body.appendChild(el);
	await el.updateComplete;
	await el._loadSlashSkills();
	return el;
}

const textarea = (el: any): HTMLTextAreaElement => el.querySelector("textarea");

/** Set the composer to (value, caret) and fire one input event so the real
 *  slash-autocomplete logic recomputes; then restore the caret (Lit's live()
 *  re-render resets it to the end under happy-dom). */
async function setComposer(el: any, value: string, caret: number): Promise<void> {
	const t = textarea(el);
	t.value = value;
	t.setSelectionRange(caret, caret);
	t.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
	await el.updateComplete;
	t.setSelectionRange(caret, caret);
}
async function key(el: any, k: string): Promise<void> {
	textarea(el).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
	await el.updateComplete;
}
const isMenuOpen = (el: any): boolean => !!el._slashMenuOpen;
const filtered = (el: any): string[] => el._slashFilteredSkills.map((s: any) => s.name);

describe("Slash autocomplete", () => {
	it("story 31: typing / shows menu, /tes filters uniquely, Enter selects", async () => {
		const el = await mount();
		await setComposer(el, "/", 1);
		expect(isMenuOpen(el)).toBe(true);
		const all = filtered(el);
		expect(all.length).toBeGreaterThan(0);
		expect(all).toContain("deploy");
		expect(all).toContain("status");
		expect(all).toContain("test");

		await setComposer(el, "/tes", 4);
		expect(filtered(el)).toEqual(["test"]);

		await key(el, "Enter");
		expect(el.value).toBe("/test ");
		expect(isMenuOpen(el)).toBe(false);
	});

	it("story 33: intra-prompt slash — hello /sk shows menu, select replaces in-place", async () => {
		const el = await mount();
		await setComposer(el, "hello /sk", 9);
		expect(isMenuOpen(el)).toBe(true);
		expect(filtered(el)).toContain("skill-name");

		await key(el, "Enter");
		expect(el.value).toBe("hello /skill-name ");
		expect(textarea(el).selectionStart).toBe("hello /skill-name ".length);
		expect(isMenuOpen(el)).toBe(false);
	});

	it("story 33: intra-prompt slash preserves text after cursor", async () => {
		const el = await mount();
		// Caret between "hello " and " the code"; "/sk" typed at index 6.
		await setComposer(el, "hello /sk the code", 9);
		expect(isMenuOpen(el)).toBe(true);
		await key(el, "Enter");
		expect(el.value).toBe("hello /skill-name  the code");
	});

	it("Tab also selects from autocomplete", async () => {
		const el = await mount();
		await setComposer(el, "/tes", 4);
		expect(filtered(el)).toContain("test");
		await key(el, "Tab");
		expect(el.value).toBe("/test ");
		expect(isMenuOpen(el)).toBe(false);
	});

	it("Escape closes menu without selecting", async () => {
		const el = await mount();
		await setComposer(el, "/dep", 4);
		await key(el, "Escape");
		expect(isMenuOpen(el)).toBe(false);
		expect(el.value).toBe("/dep");
	});

	it("ArrowDown/ArrowUp navigate menu items", async () => {
		const el = await mount();
		await setComposer(el, "/dep", 4);
		el._slashSelectedIndex = 0;
		await el.updateComplete;
		expect(el._slashSelectedIndex).toBe(0);

		await key(el, "ArrowDown");
		expect(el._slashSelectedIndex).toBe(1);

		await key(el, "ArrowUp");
		expect(el._slashSelectedIndex).toBe(0);
	});

	it("no menu when slash is not at word boundary", async () => {
		const el = await mount();
		await setComposer(el, "hello/dep", 9);
		expect(isMenuOpen(el)).toBe(false);
	});

	it("slash after newline triggers menu", async () => {
		const el = await mount();
		await setComposer(el, "line1\n/dep", 10);
		expect(isMenuOpen(el)).toBe(true);
	});

	it("selected skills only complete in the editor, then take the ordinary send path", async () => {
		const sends: string[] = [];
		const el = await mount({ onSend: (text) => sends.push(text) });
		await setComposer(el, "/tes", 4);
		await key(el, "Enter");
		expect(el.value).toBe("/test ");
		expect(sends).toEqual([]);

		await setComposer(el, "/test src/ui", "/test src/ui".length);
		await key(el, "Enter");
		expect(sends).toEqual(["/test src/ui"]);
	});

	it("ordinary text, unknown commands, and near-prefix commands pass through unchanged", async () => {
		const sends: string[] = [];
		const el = await mount({ runtime: "claude-agent-sdk", onSend: (text) => sends.push(text) });
		for (const value of ["explain /goal", "/unknown arg", "/review-notes", "/compact-notes"]) {
			await setComposer(el, value, value.length);
			await key(el, "Enter");
		}
		expect(sends).toEqual(["explain /goal", "/unknown arg", "/review-notes", "/compact-notes"]);
	});

	it("Bobbit /goal and /review skills own exact Claude collisions while near-prefixes stay ordinary", async () => {
		slashSkills = [
			{ name: "goal", description: "Bobbit goal skill", source: "project" },
			{ name: "review", description: "Bobbit review skill", source: "project" },
		];
		const sends: string[] = [];
		const el = await mount({ runtime: "claude-agent-sdk", onSend: (text) => sends.push(text) });

		await setComposer(el, "/goal", 5);
		expect(filtered(el)).toEqual(["goal"]);
		await key(el, "Enter");
		expect(el.value).toBe("/goal ");
		await key(el, "Enter");
		expect(sends).toEqual(["/goal "]);

		await setComposer(el, "/review", 7);
		expect(filtered(el)).toEqual(["review"]);
		await setComposer(el, "/review-notes", 13);
		await key(el, "Enter");
		expect(sends).toEqual(["/goal ", "/review-notes"]);
	});

	it("shows /compact only for Pi and locally dispatches the exact command", async () => {
		slashSkills = [{ name: "compact", description: "Compact context", source: "built-in" }];
		const compact = vi.fn();
		const pi = await mount({ runtime: "pi", onCompact: compact });
		await setComposer(pi, "/", 1);
		expect(filtered(pi)).toContain("compact");
		await setComposer(pi, "  /CoMpAcT  ", "  /CoMpAcT  ".length);
		await key(pi, "Enter");
		expect(compact).toHaveBeenCalledTimes(1);

		document.body.innerHTML = "";
		const sdk = await mount({ runtime: "claude-agent-sdk" });
		await setComposer(sdk, "/", 1);
		expect(filtered(sdk)).not.toContain("compact");
	});

	it("consumes exact SDK /compact without sending and preserves draft, files, and focus", async () => {
		const sends: string[] = [];
		const attachment = { id: "a1", type: "image", fileName: "keep.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" };
		const el = await mount({
			runtime: "claude-agent-sdk",
			onSend: (text) => sends.push(text),
			attachments: [attachment],
		});
		const command = "  /CoMpAcT  ";
		await setComposer(el, command, command.length);
		textarea(el).focus();
		await key(el, "Enter");

		expect(sends).toEqual([]);
		expect(el.value).toBe(command);
		expect(el.attachments).toEqual([attachment]);
		expect(document.activeElement).toBe(textarea(el));
		const alert = el.querySelector('[role="alert"]');
		expect(alert?.textContent).toBe("Manual compaction isn’t available for Claude Agent SDK sessions.");
	});

	it("does not discard attachments when Pi /compact is requested", async () => {
		const compact = vi.fn();
		const sends: string[] = [];
		const attachment = { id: "a1", type: "image", fileName: "keep.png", mimeType: "image/png", content: "AAAA", preview: "AAAA" };
		const el = await mount({ runtime: "pi", onCompact: compact, onSend: (text) => sends.push(text), attachments: [attachment] });
		await setComposer(el, "/compact", 8);
		// Enter first accepts the autocomplete item; the second Enter submits it.
		await key(el, "Enter");
		expect(el.value).toBe("/compact ");
		await key(el, "Enter");
		expect(compact).not.toHaveBeenCalled();
		expect(sends).toEqual([]);
		expect(el.value).toBe("/compact ");
		expect(el.attachments).toEqual([attachment]);
		expect(el.querySelector('[role="alert"]')?.textContent).toMatch(/attachment/i);
	});
});
