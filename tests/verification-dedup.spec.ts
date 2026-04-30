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

		// Allow Lit's `updated()` lifecycle (which seeds _chunks) to run.
		await page.waitForTimeout(50);

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

		// Let Lit re-render.
		await page.waitForTimeout(100);

		const bodyText = await page
			.locator("verification-output-modal .verif-output-body")
			.innerText();

		const occurrences = bodyText.split(LINE.trim()).length - 1;
		expect(
			occurrences,
			`Expected 1 occurrence, got ${occurrences} — verification line duplicated by document-level event fan-out`,
		).toBe(1);
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

		await page.waitForTimeout(50);

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

		// The component throttles renders via a 200ms timer — wait for the flush.
		await page.waitForTimeout(350);

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
