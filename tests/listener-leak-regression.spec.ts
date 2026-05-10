/**
 * Listener-leak regression test.
 *
 * Mounts each migrated `BobbitElement` 10x in a fresh file:// fixture and
 * asserts the total number of live event-listener references on shared
 * targets (`window`, `document`) returns to the pre-mount baseline after
 * each disconnect cycle.
 *
 * The fixture HTML wraps `EventTarget.prototype.addEventListener` /
 * `removeEventListener` BEFORE the component bundle is loaded, tracking
 * counts in a `WeakMap<EventTarget, number>`. When a listener is bound
 * with `{ signal }` we hook the signal's `abort` event so the count
 * auto-decrements on disconnect.
 *
 * See docs/design/listener-cleanup-standardisation.md §4.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import { buildBundle } from "./fixtures/build-bundle.js";

const FIXTURE = path.resolve("tests/fixtures/listener-leak-fixture.html");
const BUNDLE = path.resolve("tests/fixtures/listener-leak-bundle.js");
const ENTRY = path.resolve("tests/fixtures/listener-leak-entry.ts");
const WIDGET_SRC = path.resolve("src/ui/components/GitStatusWidget.ts");
const MESSAGE_EDITOR_SRC = path.resolve("src/ui/components/MessageEditor.ts");
const SANDBOX_SRC = path.resolve("src/ui/components/SandboxedIframe.ts");
const AGENT_SRC = path.resolve("src/ui/components/AgentInterface.ts");
const BASE_SRC = path.resolve("src/ui/components/base/BobbitElement.ts");
const TIMERS_SRC = path.resolve("src/ui/components/base/lifecycle-timers.ts");

test.beforeAll(() => {
	buildBundle({
		entry: ENTRY,
		outfile: BUNDLE,
		deps: [
			ENTRY,
			WIDGET_SRC,
			MESSAGE_EDITOR_SRC,
			SANDBOX_SRC,
			AGENT_SRC,
			BASE_SRC,
			TIMERS_SRC,
		],
	});
});

const PAGE = `file://${FIXTURE}`;

async function gotoAndWait(page: any, tag: string) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.waitForFunction(
		(t: string) => !!customElements.get(t),
		tag,
		{ timeout: 10_000 },
	);
}

interface MountConfig {
	tag: string;
	prepare?: (el: any) => void;
}

async function runLeakCycle(page: any, cfg: MountConfig) {
	await gotoAndWait(page, cfg.tag);

	// Baseline: count listeners on shared targets BEFORE we mount anything.
	// Anything Lit / customElements installed at module load time is part of
	// the baseline — we only assert that each MOUNT/DISCONNECT cycle restores
	// it.
	const baseline = await page.evaluate(() =>
		(window as any).__totalLiveListeners([window, document]),
	);

	const samples: number[] = [];
	for (let i = 0; i < 10; i++) {
		await page.evaluate(
			({ tag, prepareSrc }: { tag: string; prepareSrc: string | null }) => {
				const el = document.getElementById("container")!;
				const node = document.createElement(tag) as any;
				if (prepareSrc) {
					// eslint-disable-next-line @typescript-eslint/no-implied-eval
					const prepare = new Function("el", prepareSrc);
					prepare(node);
				}
				el.appendChild(node);
			},
			{
				tag: cfg.tag,
				prepareSrc: cfg.prepare ? `(${cfg.prepare.toString()})(el);` : null,
			},
		);
		// Let Lit complete its first render + connectedCallback.
		await page.waitForTimeout(20);

		await page.evaluate(() => {
			const el = document.getElementById("container")!;
			while (el.firstChild) el.removeChild(el.firstChild);
		});
		// Allow signal-abort microtasks to flush.
		await page.waitForTimeout(20);

		const after = await page.evaluate(() =>
			(window as any).__totalLiveListeners([window, document]),
		);
		samples.push(after);
	}

	// Every sample must be at the baseline. If any cycle leaked even one
	// listener, the count grows monotonically and this fails.
	for (let i = 0; i < samples.length; i++) {
		expect(
			samples[i],
			`After mount/disconnect cycle ${i + 1}, listener count on (window, document) was ${samples[i]} (baseline ${baseline}). Sample history: ${JSON.stringify(samples)}`,
		).toBe(baseline);
	}
}

test.describe("listener-leak regression", () => {
	test("git-status-widget releases all listeners on disconnect (10x mount cycle)", async ({ page }) => {
		await runLeakCycle(page, {
			tag: "git-status-widget",
			prepare: (w) => {
				w.branch = "feature/x";
				w.primaryBranch = "master";
				w.isOnPrimary = false;
				w.clean = true;
			},
		});
	});

	test("message-editor releases all listeners on disconnect (10x mount cycle)", async ({ page }) => {
		await runLeakCycle(page, {
			tag: "message-editor",
			prepare: (e) => {
				// Minimal props — component renders fine without sessionId.
				e.isStreaming = false;
			},
		});
	});

	test("sandbox-iframe releases all listeners on disconnect (10x mount cycle)", async ({ page }) => {
		// Mount with no `sandboxUrlProvider` — the element binds no listeners
		// until `loadContent`/`execute` is called, but the regression test only
		// cares that connect/disconnect itself is leak-free.
		await runLeakCycle(page, { tag: "sandbox-iframe" });
	});

	test("agent-interface releases all listeners on disconnect (10x mount cycle)", async ({ page }) => {
		await runLeakCycle(page, {
			tag: "agent-interface",
			prepare: (w) => {
				// No session set — component renders the "No session set"
				// placeholder branch but still installs window/document
				// listeners in connectedCallback (Escape handler, narrow RO).
				// That's enough to exercise the cleanup path.
				w.readOnly = true;
			},
		});
	});
});
