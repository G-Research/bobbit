import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_helpers/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/bg-process-states.spec.ts. This suite mounts the real
// <bg-process-pill> and <live-timer> components under happy-dom; only the old
// file:// fixture, browser locators, and animation completion are replaced.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BgProcessPill, type BgProcessInfo } from "../../src/ui/components/BgProcessPill.js";

const RUNNING_PROCESS = {
	id: "bg-run-1", name: "dev server", command: "node server.js --port 3000", pid: 12345,
	status: "running" as const, exitCode: null, startTime: Date.now(),
};
const EXITED_OK_PROCESS = {
	id: "bg-exit-0", name: "build", command: "npm run build", pid: 12346,
	status: "exited" as const, exitCode: 0, startTime: Date.now() - 5000,
};
const EXITED_ERROR_PROCESS = {
	id: "bg-exit-1", name: "test runner", command: "npm test", pid: 12347,
	status: "exited" as const, exitCode: 1, startTime: Date.now() - 10000,
};
const KILLED_PROCESS = {
	id: "bg-killed", name: "killed proc", command: "sleep 999", pid: 12348,
	status: "exited" as const, exitCode: null, terminalReason: "killed" as const,
	startTime: Date.now() - 8000, endTime: Date.now() - 2000,
};
const UNRECOVERABLE_PROCESS = {
	id: "bg-unrec", name: "lost proc", command: "npm run watch", pid: 12349,
	status: "unrecoverable" as const, exitCode: null, terminalReason: "unrecoverable" as const,
	startTime: Date.now() - 20000, endTime: Date.now() - 1000,
};

type Process = BgProcessInfo & { endTime?: number | null };
type FetchEntry = { url: string; method: string };
let fetchLog: FetchEntry[] = [];
let mockLogs: Array<{ ts: number; text: string }> = [];

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("waitFor timed out");
}

function installFetch(): void {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		let url = raw;
		try { const parsed = new URL(raw, window.location.href); url = parsed.pathname + parsed.search; } catch { /* keep raw */ }
		fetchLog.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		return new Response(JSON.stringify({ log: url.includes("/logs") ? mockLogs : [] }), {
			status: 200, headers: { "Content-Type": "application/json" },
		});
	});
}

async function createPill(process: Process, callbacks: { onKill?: (id: string) => void; onDismiss?: (id: string) => void } = {}): Promise<BgProcessPill> {
	// Construct the real class directly. The bridge still registers its tag for
	// nested Lit templates; direct construction also avoids a generic element if
	// another isolated happy-dom window evaluated the decorator first.
	const pill = new BgProcessPill();
	pill.sessionId = "test-session";
	pill.process = process;
	pill.onKill = callbacks.onKill;
	pill.onDismiss = callbacks.onDismiss;
	document.getElementById("pill-container")!.appendChild(pill);
	await pill.updateComplete;
	return pill;
}

function toggleButton(pill: BgProcessPill): HTMLButtonElement {
	return pill.querySelectorAll("button")[0] as HTMLButtonElement;
}
function actionButton(pill: BgProcessPill): HTMLButtonElement {
	return pill.querySelectorAll("button")[1] as HTMLButtonElement;
}
function indicator(pill: BgProcessPill): HTMLElement {
	return toggleButton(pill).querySelector("span") as HTMLElement;
}
function pillName(pill: BgProcessPill): HTMLElement {
	return toggleButton(pill).querySelectorAll("span")[1] as HTMLElement;
}
function dropdown(): HTMLElement | null {
	return document.getElementById("bg-process-dropdown");
}
function exactElement(root: ParentNode, selector: string, text: string): HTMLElement | undefined {
	return [...root.querySelectorAll<HTMLElement>(selector)].find((el) => el.textContent?.trim() === text);
}
function dropdownButton(text: string): HTMLButtonElement | undefined {
	const root = dropdown();
	return root ? exactElement(root, "button", text) as HTMLButtonElement | undefined : undefined;
}
async function openDropdown(pill: BgProcessPill): Promise<HTMLElement> {
	toggleButton(pill).click();
	await waitFor(() => !!dropdown() && !dropdown()!.textContent!.includes("Loading..."));
	return dropdown()!;
}
function finishClose(): void {
	const closing = dropdown();
	closing?.dispatchEvent(new Event("animationend"));
}
async function closeByToggle(pill: BgProcessPill): Promise<void> {
	toggleButton(pill).click();
	finishClose();
	await waitFor(() => !dropdown());
}
function modalContainer(): HTMLElement | undefined {
	return [...document.body.children].find((el) => (el as HTMLElement).style.zIndex === "60") as HTMLElement | undefined;
}
async function waitForKillModal(): Promise<HTMLElement> {
	await waitFor(() => !!modalContainer());
	return modalContainer()!;
}
function modalButton(modal: ParentNode, text: string): HTMLButtonElement {
	const button = exactElement(modal, "button", text) as HTMLButtonElement | undefined;
	if (!button) throw new Error(`missing modal button ${text}`);
	return button;
}
function terminalLabel(text: string): HTMLElement | undefined {
	const root = dropdown();
	return root ? exactElement(root, "span", text) : undefined;
}

beforeEach(() => {
	document.body.innerHTML = '<style>.z-50{z-index:50}.fixed{position:fixed}</style><div id="pill-container"></div>';
	fetchLog = [];
	mockLogs = [
		{ ts: 1700000001000, text: "Starting server..." },
		{ ts: 1700000002000, text: "Listening on port 3000" },
		{ ts: 1700000003000, text: "Ready." },
	];
	installFetch();
});

afterEach(async () => {
	// Resolve any real confirmAction left open so its document listener cannot leak.
	if (modalContainer()) document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await tick();
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("BgProcessPill status indicators", () => {
	it("running process shows blue pulsing indicator dot", async () => {
		const dot = indicator(await createPill(RUNNING_PROCESS));
		expect(dot.className).toContain("bg-blue-600");
		expect(dot.className).toContain("animate-pulse");
	});

	it("exited process (code 0) shows green indicator dot", async () => {
		const dot = indicator(await createPill(EXITED_OK_PROCESS));
		expect(dot.className).toContain("bg-green-600");
		expect(dot.className).not.toContain("animate-pulse");
	});

	it("exited process (code 1) shows red error indicator", async () => {
		const mark = indicator(await createPill(EXITED_ERROR_PROCESS));
		expect(mark.className).toContain("text-red-600");
		expect(mark.textContent).toBe("!");
	});

	it("killed process shows a neutral (muted) indicator dot", async () => {
		const dot = indicator(await createPill(KILLED_PROCESS));
		expect(dot.className).toContain("bg-muted-foreground");
		expect(dot.className).not.toContain("animate-pulse");
		expect(dot.className).not.toContain("bg-green-600");
	});

	it("unrecoverable process shows an amber '?' indicator with a restart title", async () => {
		const mark = indicator(await createPill(UNRECOVERABLE_PROCESS));
		expect(mark.className).toContain("text-amber-600");
		expect(mark.textContent).toBe("?");
		expect(mark.title).toMatch(/lost across a restart/i);
	});

	it("pill displays process name", async () => {
		expect(pillName(await createPill(RUNNING_PROCESS)).textContent).toBe("dev server");
	});

	it("pill uses id as fallback when name is missing", async () => {
		expect(pillName(await createPill({ ...RUNNING_PROCESS, name: "", id: "bg-unnamed" })).textContent).toBe("bg-unnamed");
	});
});

describe("BgProcessPill dropdown toggle", () => {
	it("click pill toggle opens dropdown portaled to body", async () => {
		const pill = await createPill(RUNNING_PROCESS);
		expect(dropdown()).toBeNull();
		const menu = await openDropdown(pill);
		expect(menu.parentElement?.parentElement).toBe(document.body);
	});

	it("clicking toggle again closes dropdown", async () => {
		const pill = await createPill(RUNNING_PROCESS);
		await openDropdown(pill);
		await closeByToggle(pill);
		expect(dropdown()).toBeNull();
	});

	it("dropdown shows log output from fetch", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS));
		const lines = [...document.querySelectorAll<HTMLElement>("#bg-log-output > div")];
		expect(lines).toHaveLength(3);
		expect(lines[0].textContent).toContain("Starting server...");
		expect(lines[1].textContent).toContain("Listening on port 3000");
		expect(lines[2].textContent).toContain("Ready.");
	});

	it("dropdown shows (no output yet) when logs empty", async () => {
		mockLogs = [];
		await openDropdown(await createPill(RUNNING_PROCESS));
		expect(document.getElementById("bg-log-output")?.textContent).toContain("(no output yet)");
	});

	it("dropdown shows command text", async () => {
		const menu = await openDropdown(await createPill(RUNNING_PROCESS));
		expect(exactElement(menu, "div", RUNNING_PROCESS.command)).toBeTruthy();
	});

	it("fetch is called with correct URL when dropdown opens", async () => {
		const pill = await createPill(RUNNING_PROCESS);
		fetchLog = [];
		await openDropdown(pill);
		const call = fetchLog.find((entry) => entry.url.includes("/logs"));
		expect(call).toBeDefined();
		expect(call!.url).toContain(`/api/sessions/test-session/bg-processes/${RUNNING_PROCESS.id}/logs`);
	});
});

describe("BgProcessPill kill and dismiss", () => {
	it("dropdown shows Kill button for running process", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS));
		expect(dropdownButton("Kill")?.textContent).toBe("Kill");
		expect(dropdownButton("Remove")).toBeUndefined();
	});

	it("dropdown shows Remove button for exited process", async () => {
		await openDropdown(await createPill(EXITED_OK_PROCESS));
		expect(dropdownButton("Remove")?.textContent).toBe("Remove");
		expect(dropdownButton("Kill")).toBeUndefined();
	});

	it("dropdown shows Remove button (not Kill) for unrecoverable process", async () => {
		await openDropdown(await createPill(UNRECOVERABLE_PROCESS));
		expect(dropdownButton("Remove")?.textContent).toBe("Remove");
		expect(dropdownButton("Kill")).toBeUndefined();
	});

	it("unrecoverable pill action button shows an X icon (dismiss, not kill)", async () => {
		const button = actionButton(await createPill(UNRECOVERABLE_PROCESS));
		expect(button.textContent?.trim()).toBe("✕");
		expect(button.querySelector("svg")).toBeNull();
	});

	it("pill X button dismisses an unrecoverable process", async () => {
		const calls: string[] = [];
		const pill = await createPill(UNRECOVERABLE_PROCESS, { onDismiss: (id) => calls.push(id) });
		actionButton(pill).click();
		expect(calls).toEqual([UNRECOVERABLE_PROCESS.id]);
	});

	it("Kill button fires onKill callback after confirmation", async () => {
		const calls: string[] = [];
		await openDropdown(await createPill(RUNNING_PROCESS, { onKill: (id) => calls.push(id) }));
		dropdownButton("Kill")!.click();
		const modal = await waitForKillModal();
		expect(calls).toEqual([]);
		modalButton(modal, "Kill").click();
		await waitFor(() => calls.length === 1);
		expect(calls).toEqual([RUNNING_PROCESS.id]);
	});

	it("cancelling the confirmation does not kill", async () => {
		const calls: string[] = [];
		await openDropdown(await createPill(RUNNING_PROCESS, { onKill: (id) => calls.push(id) }));
		dropdownButton("Kill")!.click();
		const modal = await waitForKillModal();
		modalButton(modal, "Cancel").click();
		await waitFor(() => !modalContainer());
		expect(calls).toEqual([]);
	});

	it("Remove button fires onDismiss callback", async () => {
		const calls: string[] = [];
		await openDropdown(await createPill(EXITED_OK_PROCESS, { onDismiss: (id) => calls.push(id) }));
		dropdownButton("Remove")!.click();
		expect(calls).toEqual([EXITED_OK_PROCESS.id]);
	});

	it("running pill action button shows a skull icon", async () => {
		const button = actionButton(await createPill(RUNNING_PROCESS));
		// mini-lit owns the current icon class names; preserve the scenario's
		// semantic assertion via the SVG icon and its kill-specific title.
		expect(button.querySelector("svg")).toBeTruthy();
		expect(button.title).toBe("Kill process");
	});

	it("exited pill action button shows an X icon", async () => {
		const button = actionButton(await createPill(EXITED_OK_PROCESS));
		expect(button.textContent?.trim()).toBe("✕");
		expect(button.querySelector("svg")).toBeNull();
	});

	it("pill skull button kills running process after confirmation", async () => {
		const calls: string[] = [];
		const pill = await createPill(RUNNING_PROCESS, { onKill: (id) => calls.push(id) });
		actionButton(pill).click();
		const modal = await waitForKillModal();
		expect(calls).toEqual([]);
		modalButton(modal, "Kill").click();
		await waitFor(() => calls.length === 1);
		expect(calls).toEqual([RUNNING_PROCESS.id]);
	});

	it("confirmation modal renders above the expanded popover", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS, { onKill: () => {} }));
		dropdownButton("Kill")!.click();
		const modal = await waitForKillModal();
		const modalZ = Number(getComputedStyle(modal).zIndex) || 0;
		const dropdownZ = Number(getComputedStyle(dropdown()!).zIndex) || 0;
		expect(modalZ).toBeGreaterThan(dropdownZ);
		modalButton(modal, "Cancel").click();
	});

	it("pill X button dismisses exited process", async () => {
		const calls: string[] = [];
		const pill = await createPill(EXITED_OK_PROCESS, { onDismiss: (id) => calls.push(id) });
		actionButton(pill).click();
		expect(calls).toEqual([EXITED_OK_PROCESS.id]);
	});
});

describe("BgProcessPill dropdown close behaviors", () => {
	it("clicking outside closes dropdown", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS));
		document.body.click();
		finishClose();
		await waitFor(() => !dropdown());
		expect(dropdown()).toBeNull();
	});

	it("Escape key closes dropdown", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS));
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		finishClose();
		await waitFor(() => !dropdown());
		expect(dropdown()).toBeNull();
	});

	it("clicking inside dropdown does NOT close it", async () => {
		const menu = await openDropdown(await createPill(RUNNING_PROCESS));
		exactElement(menu, "div", RUNNING_PROCESS.command)!.click();
		expect(dropdown()).toBeTruthy();
	});
});

describe("BgProcessPill exit code display", () => {
	it("exited process (code 0) shows 'exit 0' in green in dropdown", async () => {
		await openDropdown(await createPill(EXITED_OK_PROCESS));
		const label = terminalLabel("exit 0");
		expect(label).toBeTruthy();
		expect(label!.className).toContain("text-green-700");
	});

	it("exited process (code 1) shows 'exit 1' in red in dropdown", async () => {
		await openDropdown(await createPill(EXITED_ERROR_PROCESS));
		const label = terminalLabel("exit 1");
		expect(label).toBeTruthy();
		expect(label!.className).toContain("text-red-700");
	});

	it("running process does NOT show exit code in dropdown", async () => {
		await openDropdown(await createPill(RUNNING_PROCESS));
		expect([...dropdown()!.querySelectorAll("span")].some((el) => /^exit\b/.test(el.textContent?.trim() ?? ""))).toBe(false);
	});

	it("killed process shows 'killed' label (no fabricated exit code) in dropdown", async () => {
		await openDropdown(await createPill(KILLED_PROCESS));
		const label = terminalLabel("killed");
		expect(label).toBeTruthy();
		expect(label!.textContent).not.toMatch(/exit\s+\d/);
	});

	it("unrecoverable process shows 'exit status unknown' in amber in dropdown", async () => {
		await openDropdown(await createPill(UNRECOVERABLE_PROCESS));
		const label = terminalLabel("exit status unknown");
		expect(label).toBeTruthy();
		expect(label!.className).toContain("text-amber-600");
		expect(label!.title).toMatch(/lost across a restart/i);
		expect(label!.textContent).not.toMatch(/exit\s+\d/);
	});

	it("dropdown header shows process id and pid", async () => {
		const menu = await openDropdown(await createPill(RUNNING_PROCESS));
		expect(menu.textContent).toContain("bg-run-1");
		expect(menu.textContent).toContain("pid 12345");
	});
});

describe("BG timer regression", () => {
	it("exited process uses endTime runtime and stays fixed after re-render and reload", async () => {
		const startTime = Date.now() - 24 * 60 * 60 * 1000;
		const processInfo = {
			id: "bg-fixed-runtime", name: "finished build", command: "npm run build", pid: 22222,
			status: "exited" as const, exitCode: 0, startTime, endTime: startTime + 120_000,
		};
		let pill = await createPill(processInfo);
		let menu = await openDropdown(pill);
		expect(menu.textContent).toMatch(/\b2m 00s\b/);
		const before = menu.textContent;
		await new Promise((resolve) => setTimeout(resolve, 1100));
		pill.requestUpdate();
		await pill.updateComplete;
		(pill as any)._renderPortal();
		menu = dropdown()!;
		expect(menu.textContent).toMatch(/\b2m 00s\b/);
		expect(menu.textContent).toBe(before);

		// A fresh component mount is the happy-dom equivalent of the old page reload.
		document.getElementById("pill-container")!.innerHTML = "";
		dropdown()?.parentElement?.remove();
		pill = await createPill(processInfo);
		menu = await openDropdown(pill);
		expect(menu.textContent).toMatch(/\b2m 00s\b/);
	});

	it("legacy exited process without endTime does not show time since start", async () => {
		const menu = await openDropdown(await createPill({
			id: "bg-legacy-runtime", name: "legacy build", command: "npm run build", pid: 22223,
			status: "exited", exitCode: 0, startTime: Date.now() - 24 * 60 * 60 * 1000,
		}));
		expect(menu.textContent).not.toMatch(/\b(?:\d{3,}m\s+\d{2}s|\d+h\b|\d+d\b)/i);
	});

	it("running process timer increments while running", async () => {
		await openDropdown(await createPill({
			id: "bg-running-runtime", name: "dev server", command: "npm run dev", pid: 22224,
			status: "running", exitCode: null, startTime: Date.now() - 1000, endTime: null,
		}));
		const timer = dropdown()!.querySelector("live-timer")!;
		const initial = timer.textContent?.trim();
		await waitFor(() => timer.textContent?.trim() !== initial, 2500);
		expect(timer.textContent?.trim()).not.toBe(initial);
	});
});
