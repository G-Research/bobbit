/**
 * Reproducing test for the verification log Nx duplication bug.
 *
 * Bug: With N active session WebSockets in the same tab, the server's
 * `broadcastToGoal` fan-out delivers each `gate_verification_step_output`
 * payload to every session WS. Each `RemoteAgent` independently dispatches
 * a `gate-verification-event` CustomEvent on `document`, so the listeners
 * in <verification-output-modal> and <gate-verification-live> append the
 * same chunk N times.
 *
 * This file:// unit test mounts each component in isolation and dispatches
 * the *same* CustomEvent 6 times in succession (simulating 6 active session
 * WS clients). It asserts that the rendered output contains the streamed
 * line exactly once. Today both assertions FAIL with the line repeated 6×.
 */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/verification-dedup.html");
const BUNDLE = path.resolve("tests/fixtures/verification-dedup-bundle.js");
const ENTRY = path.resolve("tests/fixtures/verification-dedup-entry.ts");
const MODAL_SRC = path.resolve("src/ui/components/VerificationOutputModal.ts");
const LIVE_SRC = path.resolve("src/ui/tools/renderers/GateVerificationLive.ts");

test.beforeAll(() => {
	const entryMtime = Math.max(
		fs.statSync(ENTRY).mtimeMs,
		fs.statSync(MODAL_SRC).mtimeMs,
		fs.statSync(LIVE_SRC).mtimeMs,
	);
	const bundleExists = fs.existsSync(BUNDLE);
	const bundleStale = bundleExists && fs.statSync(BUNDLE).mtimeMs < entryMtime;
	if (!bundleExists || bundleStale) {
		execSync(
			[
				`npx esbuild ${ENTRY}`,
				"--bundle --format=iife --target=es2022",
				`--outfile=${BUNDLE}`,
				"--tsconfig=tsconfig.web.json",
				"--alias:pdfjs-dist=./tests/fixtures/empty-shim",
				"--define:import.meta.url='\"http://localhost/\"'",
			].join(" "),
			{ stdio: "pipe" },
		);
	}
});

const PAGE = `file://${FIXTURE}`;

const GOAL_ID = "goal-abc";
const GATE_ID = "gate-test";
const SIGNAL_ID = "sig-1";
const STEP_INDEX = 0;
const LINE = "UNIQUE_OUTPUT_LINE_XYZ_42\n";
const N_SESSIONS = 6;

async function gotoAndWait(page: any) {
	await page.goto(PAGE);
	await page.waitForFunction(() => (window as any).__ready === true, null, {
		timeout: 10_000,
	});
	await page.waitForFunction(
		() =>
			!!customElements.get("verification-output-modal") &&
			!!customElements.get("gate-verification-live"),
		null,
		{ timeout: 10_000 },
	);
}

test.describe("Verification log Nx duplication (reproducing)", () => {
	test("VerificationOutputModal renders streamed line exactly once when same event is dispatched 6×", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(
			(args) => {
				const el = document.createElement("verification-output-modal") as any;
				el.goalId = args.goalId;
				el.gateId = args.gateId;
				el.signalId = args.signalId;
				el.stepIndex = args.stepIndex;
				el.stepName = "Run tests";
				el.stepType = "command";
				el.open = true;
				document.getElementById("container")!.appendChild(el);
			},
			{ goalId: GOAL_ID, gateId: GATE_ID, signalId: SIGNAL_ID, stepIndex: STEP_INDEX },
		);

		// Wait for Lit's `updated()` lifecycle (which seeds _chunks) via the
		// element's updateComplete promise — observable state, not a fixed delay.
		await page.evaluate(() => (document.querySelector("verification-output-modal") as any)?.updateComplete);

		// Dispatch the SAME event N times — this models N session-bucket
		// RemoteAgents in the same tab each receiving the broadcast and
		// re-emitting it on document.
		await page.evaluate(
			(args) => {
				const detail = {
					type: "gate_verification_step_output",
					goalId: args.goalId,
					gateId: args.gateId,
					signalId: args.signalId,
					stepIndex: args.stepIndex,
					stream: "stdout",
					text: args.line,
				};
				for (let i = 0; i < args.n; i++) {
					document.dispatchEvent(
						new CustomEvent("gate-verification-event", { detail }),
					);
				}
			},
			{
				goalId: GOAL_ID,
				gateId: GATE_ID,
				signalId: SIGNAL_ID,
				stepIndex: STEP_INDEX,
				line: LINE,
				n: N_SESSIONS,
			},
		);

		// The overlay is portaled to document.body (so its `position: fixed`
		// escapes the chat message-list's `content-visibility` containing block),
		// so query the body class directly rather than within the host element.
		// Wait on the OBSERVABLE render result (the line appearing) rather than a
		// fixed delay, so CPU-starved re-renders under N-way load never flake.
		const body = page.locator(".verif-output-body");
		await expect(body).toContainText(LINE.trim());
		const bodyText = await body.innerText();

		const occurrences = bodyText.split(LINE.trim()).length - 1;
		expect(
			occurrences,
			`Expected 1 occurrence, got ${occurrences} — verification line duplicated by document-level event fan-out`,
		).toBe(1);
	});

	test("VerificationOutputModal portals its overlay to document.body so fixed positioning escapes a contained ancestor", async ({ page }) => {
		await gotoAndWait(page);

		// Mount the modal inside an ancestor that establishes a containing block
		// for fixed descendants (this is what the chat message-list does via
		// `content-visibility: auto`). If the overlay rendered in light DOM it
		// would be clipped to this box instead of the viewport.
		const result = await page.evaluate(
			(args) => {
				const contained = document.createElement("div");
				contained.style.cssText =
					"position:absolute;left:100px;top:100px;width:200px;height:150px;contain:layout paint;overflow:hidden;";
				document.getElementById("container")!.appendChild(contained);

				const el = document.createElement("verification-output-modal") as any;
				el.goalId = args.goalId;
				el.gateId = args.gateId;
				el.signalId = args.signalId;
				el.stepIndex = args.stepIndex;
				el.stepName = "Run tests";
				el.stepType = "command";
				el.open = true;
				contained.appendChild(el);
				return { containedInHost: el.querySelector(".verif-output-backdrop") != null };
			},
			{ goalId: GOAL_ID, gateId: GATE_ID, signalId: SIGNAL_ID, stepIndex: STEP_INDEX },
		);

		// The overlay must NOT live inside the host element (which sits inside the
		// contained ancestor) — it must be portaled to document.body.
		expect(result.containedInHost, "overlay should not render in the host's light DOM").toBe(false);

		const backdrop = page.locator(".verif-output-backdrop");
		await expect(backdrop).toBeVisible();

		// The portal lives directly under document.body.
		const parentIsBody = await backdrop.evaluate(
			(el) => el.parentElement?.parentElement === document.body,
		);
		expect(parentIsBody, "portal should be appended to document.body").toBe(true);

		// Because it escaped the 200×150 contained ancestor (which sat at left=100),
		// the fixed overlay should originate at the viewport origin and span far
		// wider than the contained box.
		const box = await backdrop.boundingBox();
		expect(box, "backdrop should have a bounding box").not.toBeNull();
		// < 100 proves the overlay is not resolved against the contained box
		// (which sat at left=100); it tracks the viewport instead.
		expect(box!.x).toBeLessThan(50);
		expect(box!.width).toBeGreaterThan(300);

		// Wire up a `close` listener on the host (mirrors how GateVerificationLive
		// consumes the event) so we can assert the close affordances actually fire
		// it. Regression guard: the portal must render with `host: this` so the
		// template's @click handlers dispatch `close` on the component, not the
		// portal DOM node.
		await page.evaluate(() => {
			const el = document.querySelector("verification-output-modal") as any;
			(window as any).__closeCount = 0;
			el.addEventListener("close", () => { (window as any).__closeCount++; });
		});

		// Clicking the ✕ button dispatches `close` on the host element.
		await page.locator(".verif-output-backdrop button[title='Close']").click();
		expect(await page.evaluate(() => (window as any).__closeCount)).toBe(1);

		// Clicking the backdrop itself (target === backdrop) also dispatches
		// `close`. Trigger it directly on the element so the assertion doesn't
		// depend on the fixture reproducing Tailwind's flex/inset layout.
		await page.evaluate(() => {
			(document.querySelector(".verif-output-backdrop") as HTMLElement).click();
		});
		expect(await page.evaluate(() => (window as any).__closeCount)).toBe(2);

		// Closing (open=false) removes the portal from the DOM.
		await page.evaluate(() => {
			const el = document.querySelector("verification-output-modal") as any;
			el.open = false;
		});
		// toHaveCount auto-waits for the portal to be removed — observable state.
		await expect(page.locator(".verif-output-backdrop")).toHaveCount(0);
	});

	test("GateVerificationLive accumulates streamed line exactly once when same event is dispatched 6×", async ({ page }) => {
		await gotoAndWait(page);

		await page.evaluate(
			(args) => {
				const el = document.createElement("gate-verification-live") as any;
				el.goalId = args.goalId;
				el.gateId = args.gateId;
				el.signalId = args.signalId;
				el.initialSteps = [{ name: "Run tests", type: "command" }];
				document.getElementById("container")!.appendChild(el);
				(window as any).__live = el;
			},
			{ goalId: GOAL_ID, gateId: GATE_ID, signalId: SIGNAL_ID },
		);

		// Wait for the component's first render via updateComplete (observable state).
		await page.evaluate(() => (window as any).__live?.updateComplete);

		await page.evaluate(
			(args) => {
				const detail = {
					type: "gate_verification_step_output",
					goalId: args.goalId,
					gateId: args.gateId,
					signalId: args.signalId,
					stepIndex: args.stepIndex,
					stream: "stdout",
					text: args.line,
				};
				for (let i = 0; i < args.n; i++) {
					document.dispatchEvent(
						new CustomEvent("gate-verification-event", { detail }),
					);
				}
			},
			{
				goalId: GOAL_ID,
				gateId: GATE_ID,
				signalId: SIGNAL_ID,
				stepIndex: STEP_INDEX,
				line: LINE,
				n: N_SESSIONS,
			},
		);

		// The component throttles renders via a 200ms timer. Wait on the OBSERVABLE
		// result (the accumulated buffer containing the line) rather than a fixed
		// delay, so a CPU-starved throttle flush under N-way load never flakes.
		await page.waitForFunction(
			(needle) => {
				const el: any = (window as any).__live;
				const s: string = el?._stepOutputs?.get(0) || "";
				return s.includes(needle);
			},
			LINE.trim(),
			{ timeout: 10_000 },
		);

		// Read the accumulated buffer directly off the component (the public
		// effect of the bug). Reaching into _stepOutputs is the cleanest way
		// to get the full accumulated string regardless of UI collapsed state.
		const accumulated = await page.evaluate(() => {
			const el: any = (window as any).__live;
			const map: Map<number, string> = el._stepOutputs;
			return map.get(0) || "";
		});

		const occurrences = accumulated.split(LINE.trim()).length - 1;
		expect(
			occurrences,
			`Expected 1 occurrence, got ${occurrences} — verification line duplicated by document-level event fan-out`,
		).toBe(1);
	});
});
