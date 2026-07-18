import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/gate-signal-renderer.spec.ts (v2-dom tier).
// Renders the real GateSignalRenderer, GateVerificationLive, and shared
// SignoffReviewLauncher together under happy-dom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "lit";
import { GATE_STATUS_CLIENT_EVENT } from "../../src/app/gate-status-events.js";
import { GateSignalRenderer } from "../../src/ui/tools/renderers/GateToolRenderers.js";
// Statically import the real <gate-verification-live> so the module (and its
// LiveTimer side-effect define) is evaluated synchronously while happy-dom's
// customElements global is live. The renderer's lazy ensureGateVerificationLive()
// then hits the cached module instead of firing an unhandled async import whose
// top-level define would race teardown.
import "../../src/ui/tools/renderers/GateVerificationLive.js";
// GateVerificationLive.render() fires ensureMarkdownBlock() (a fire-and-forget
// dynamic import of the KaTeX/marked/mini-lit graph). Pre-import it statically so
// that chunk's top-level @customElement decorators run now (while happy-dom's
// customElements is live) instead of racing env teardown as an unhandled
// "customElements is not defined" rejection.
import "../../src/ui/lazy/safe-markdown-block.js";

const AGENT_REMINDER =
	"Gate signal accepted. Verification is running asynchronously. Do not poll with `gate_status` or `gate_inspect`. Go idle now and wait for the server to deliver verification results or further instructions.";

const toolResult = (data: any) => ({ isError: false, content: [{ type: "text", text: JSON.stringify(data) }] });

async function renderSignal(params: any, data: any) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const out = new GateSignalRenderer().render(params, toolResult(data) as any);
	render(out.content, container);
	const live = container.querySelector("gate-verification-live") as any;
	if (live?.updateComplete) await live.updateComplete;
	return {
		container,
		live,
		text: container.textContent || "",
		hasLive: !!live,
		goalId: live?.goalId || "",
		gateId: live?.gateId || "",
		signalId: live?.signalId || "",
		initialSteps: live?.initialSteps || [],
		finalStatus: live?.finalStatus,
	};
}

function jsonResponse(body: any, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function settleLive(live: any): Promise<void> {
	await live.updateComplete;
	const launcher = live.querySelector("signoff-review-launcher") as any;
	if (launcher?.updateComplete) await launcher.updateComplete;
	await live.updateComplete;
}

let eventSeq = 0;

function verificationEvent(type: string, overrides: Record<string, unknown> = {}): CustomEvent {
	return new CustomEvent("gate-verification-event", {
		detail: {
			type,
			goalId: "goal-live",
			gateId: "human-approval",
			signalId: "signal-live",
			seq: ++eventSeq,
			...overrides,
		},
	});
}

beforeEach(() => {
	eventSeq = 0;
	localStorage.clear();
	vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.unstubAllGlobals();
});

describe("GateSignalRenderer", () => {
	it("renders live gate signal UI without exposing the top-level agent reminder", async () => {
		const result = await renderSignal({ gate_id: "implementation" }, {
			signal: {
				id: "signal-123", goalId: "goal-abc", gateId: "implementation", status: "running",
				steps: [
					{ name: "typecheck", type: "command", status: "running", duration_ms: 2500, output: "checking" },
					{ name: "review", type: "llm-review", status: "waiting" },
				],
			},
			agentReminder: AGENT_REMINDER,
		});
		expect(result.hasLive).toBe(true);
		expect(result.text).toContain("Signaled implementation");
		expect(result.text).not.toContain(AGENT_REMINDER);
		expect(result.goalId).toBe("goal-abc");
		expect(result.gateId).toBe("implementation");
		expect(result.signalId).toBe("signal-123");
		expect(result.initialSteps.map((s: any) => s.status)).toEqual(["running", "waiting"]);
		expect(result.finalStatus).toBeUndefined();
	});

	for (const finalStatus of ["passed", "failed"] as const) {
		it(`passes terminal verification.steps as initialSteps for completed ${finalStatus} signals`, async () => {
			const terminalSteps = [
				{ name: "Build", type: "command", status: "passed", phase: 0, passed: true },
				{ name: "Optional deploy", type: "command", status: "skipped", phase: 1, passed: true, skipped: true },
			];
			const result = await renderSignal({ gate_id: "implementation" }, {
				signal: {
					id: `signal-${finalStatus}`, goalId: "goal-terminal", gateId: "implementation", status: finalStatus,
					verification: { status: finalStatus, steps: terminalSteps },
				},
			});
			expect(result.hasLive).toBe(true);
			expect(result.goalId).toBe("goal-terminal");
			expect(result.gateId).toBe("implementation");
			expect(result.signalId).toBe(`signal-${finalStatus}`);
			expect(result.finalStatus).toBe(finalStatus);
			expect(result.initialSteps).toEqual(terminalSteps);
		});
	}

	it("shows Start Review only for an active human-signoff row with the authoritative marker", async () => {
		const { live } = await renderSignal({ gate_id: "human-approval" }, {
			signal: {
				id: "signal-live",
				goalId: "goal-live",
				status: "running",
				steps: [
					{ name: "actionable", type: "human-signoff", status: "running", awaitingHuman: true, humanLabel: "Approve release" },
					{ name: "queued", type: "human-signoff", status: "waiting", awaitingHuman: true },
					{ name: "unmarked", type: "human-signoff", status: "running", output: "Awaiting human approval" },
					{ name: "false-marker", type: "human-signoff", status: "running", awaitingHuman: false },
					{ name: "wrong-type", type: "llm-review", status: "running", awaitingHuman: true },
					{ name: "completed", type: "human-signoff", status: "passed", awaitingHuman: true },
				],
			},
		});
		await settleLive(live);

		const launchers = live.querySelectorAll("signoff-review-launcher");
		expect(launchers).toHaveLength(1);
		expect((launchers[0] as any).target).toEqual({
			goalId: "goal-live",
			gateId: "human-approval",
			signalId: "signal-live",
			stepName: "actionable",
			stepLabel: "Approve release",
		});
		expect(launchers[0].previousElementSibling?.textContent).toBe("actionable");
		expect(launchers[0].querySelectorAll("button")).toHaveLength(1);
		expect(launchers[0].querySelector("button")?.getAttribute("aria-label")).toBe("Start review: Approve release");
	});

	it("launches the exact review document through the shared launcher and exposes loading, failure, and retry", async () => {
		let resolveFetch!: (response: Response) => void;
		const fetchMock = vi.fn((_input?: RequestInfo | URL) => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
		vi.stubGlobal("fetch", fetchMock);
		const openEvents: any[] = [];
		const onOpen = (event: Event) => openEvents.push((event as CustomEvent).detail);
		window.addEventListener("bobbit-open-review-document", onOpen);

		try {
			const { live } = await renderSignal({ gate_id: "human-approval" }, {
				signal: {
					id: "signal-live", goalId: "goal-live", status: "running",
					steps: [{ name: "approve-release", type: "human-signoff", status: "running", awaitingHuman: true, humanLabel: "Approve release" }],
				},
			});
			await settleLive(live);
			const launcher = live.querySelector("signoff-review-launcher") as any;
			const button = launcher.querySelector("button") as HTMLButtonElement;
			button.click();
			await launcher.updateComplete;

			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(fetchMock.mock.calls[0][0]).toBe(`${window.location.origin}/api/goals/goal-live/gates/human-approval/signals`);
			expect(button.disabled).toBe(true);
			expect(button.getAttribute("aria-busy")).toBe("true");
			expect(button.textContent).toContain("Opening…");
			button.click();
			expect(fetchMock).toHaveBeenCalledTimes(1);

			resolveFetch(jsonResponse({ error: "unavailable" }, 503));
			for (let i = 0; i < 10 && !launcher.querySelector('[role="alert"]'); i++) {
				await Promise.resolve();
				await launcher.updateComplete;
			}
			expect(openEvents).toHaveLength(0);
			expect(launcher.querySelector("button")?.disabled).toBe(false);
			expect(launcher.querySelector('[role="alert"]')?.textContent).toBe("Couldn’t open review. Try again.");

			fetchMock.mockImplementationOnce(async () => jsonResponse({
				signals: [{ id: "signal-live", content: "## Release\n\nPlease verify this exact submission." }],
				goalTitle: "Release Goal",
				gateName: "Human Approval",
			}));
			(launcher.querySelector("button") as HTMLButtonElement).click();
			for (let i = 0; i < 10 && openEvents.length === 0; i++) {
				await Promise.resolve();
				await launcher.updateComplete;
			}
			expect(openEvents).toEqual([{
				title: "Sign-off: Release Goal / Human Approval / Approve release",
				markdown: "## Release\n\nPlease verify this exact submission.",
				source: {
					kind: "verification-signoff-markdown",
					goalId: "goal-live",
					gateId: "human-approval",
					signalId: "signal-live",
					stepName: "approve-release",
					goalTitle: "Release Goal",
					gateName: "Human Approval",
					stepLabel: "Approve release",
				},
			}]);
			expect(launcher.querySelector('[role="alert"]')).toBeNull();
		} finally {
			window.removeEventListener("bobbit-open-review-document", onOpen);
		}
	});

	it("keeps identifier title fallbacks when signal history omits display metadata", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
			signals: [{ id: "signal-live", content: "Review this" }],
		})));
		const openEvents: any[] = [];
		const onOpen = (event: Event) => openEvents.push((event as CustomEvent).detail);
		window.addEventListener("bobbit-open-review-document", onOpen);

		try {
			const { live } = await renderSignal({ gate_id: "human-approval" }, {
				signal: {
					id: "signal-live", goalId: "goal-live", status: "running",
					steps: [{ name: "approve-release", type: "human-signoff", status: "running", awaitingHuman: true }],
				},
			});
			await settleLive(live);
			(live.querySelector("signoff-review-launcher button") as HTMLButtonElement).click();
			for (let i = 0; i < 10 && openEvents.length === 0; i++) await Promise.resolve();

			expect(openEvents[0].title).toBe("Sign-off: goal-live / human-approval / approve-release");
			expect(openEvents[0].source).not.toHaveProperty("goalTitle");
			expect(openEvents[0].source).not.toHaveProperty("gateName");
		} finally {
			window.removeEventListener("bobbit-open-review-document", onOpen);
		}
	});

	it("adds the launcher from an awaiting event and removes it on every matching resolution event", async () => {
		const { live } = await renderSignal({ gate_id: "human-approval" }, {
			signal: {
				id: "signal-live", goalId: "goal-live", status: "running",
				steps: [{ name: "approve-release", type: "human-signoff", status: "running" }],
			},
		});
		expect(live.querySelector("signoff-review-launcher")).toBeNull();

		document.dispatchEvent(verificationEvent("gate_verification_awaiting_human", {
			stepIndex: 0, stepName: "approve-release", label: "Approve release", prompt: "Read carefully",
		}));
		await settleLive(live);
		expect((live.querySelector("signoff-review-launcher") as any).target.stepLabel).toBe("Approve release");

		document.dispatchEvent(verificationEvent("gate_verification_step_complete", {
			stepIndex: 1, stepName: "different-step", status: "passed",
		}));
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeTruthy();
		document.dispatchEvent(verificationEvent("gate_verification_step_complete", {
			stepIndex: 0, stepName: "approve-release", status: "passed",
		}));
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeNull();

		document.dispatchEvent(verificationEvent("gate_verification_awaiting_human", { stepIndex: 0, stepName: "approve-release" }));
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeTruthy();
		window.dispatchEvent(new CustomEvent(GATE_STATUS_CLIENT_EVENT, { detail: {
			type: "gate_verification_signoff_resolved",
			goalId: "goal-live", gateId: "human-approval", signalId: "signal-live", stepName: "approve-release", stepIndex: 0,
		} }));
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeNull();

		document.dispatchEvent(verificationEvent("gate_verification_awaiting_human", { stepIndex: 0, stepName: "approve-release" }));
		await settleLive(live);
		document.dispatchEvent(verificationEvent("gate_verification_complete", { status: "passed" }));
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeNull();
	});

	it("uses the active REST snapshot as the authoritative add/remove reconciliation source", async () => {
		let activeSteps: any[] = [{
			name: "approve-release", type: "human-signoff", status: "running",
			awaitingHuman: true, humanLabel: "Approve reconciled release", humanPrompt: "Inspect it",
		}];
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/verifications/active")) {
				return jsonResponse({ verifications: [{ signalId: "signal-live", currentPhase: 0, steps: activeSteps }] });
			}
			return jsonResponse({ signals: [{
				id: "signal-live",
				verification: { status: "running", steps: [{ name: "approve-release", type: "human-signoff", status: "running" }] },
			}] });
		});
		vi.stubGlobal("fetch", fetchMock);
		const { live } = await renderSignal({ gate_id: "human-approval" }, {
			signal: {
				id: "signal-live", goalId: "goal-live", status: "running",
				steps: [{ name: "approve-release", type: "human-signoff", status: "running" }],
			},
		});

		await live._fetchAndReconcile();
		await settleLive(live);
		expect((live.querySelector("signoff-review-launcher") as any).target.stepLabel).toBe("Approve reconciled release");

		// An active row can briefly exist before its steps are seeded. Treat that
		// empty array as unavailable data and retain the signal/event fallback.
		activeSteps = [];
		await live._fetchAndReconcile();
		await settleLive(live);
		expect((live.querySelector("signoff-review-launcher") as any).target.stepLabel).toBe("Approve reconciled release");

		// Once the active snapshot has steps, it remains authoritative and may
		// remove a marker that only the fallback state still carries.
		activeSteps = [{
			name: "approve-release", type: "human-signoff", status: "running",
			output: "Awaiting human approval, but the structured marker was resolved",
		}];
		await live._fetchAndReconcile();
		await settleLive(live);
		expect(live.querySelector("signoff-review-launcher")).toBeNull();
		expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/verifications/active"))).toBe(true);
	});
});

const firstTarget = {
	goalId: "goal-first",
	gateId: "approval",
	signalId: "signal-first",
	stepName: "sign-off",
};

async function renderDirectLauncher(target = firstTarget): Promise<any> {
	const launcher = document.createElement("signoff-review-launcher") as any;
	launcher.target = target;
	document.body.appendChild(launcher);
	await launcher.updateComplete;
	return launcher;
}

async function flushLaunch(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("SignoffReviewLauncher lifecycle", () => {
	it("accepts completion events without goalId but rejects a present goal mismatch", async () => {
		const launcher = await renderDirectLauncher();
		document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: {
			type: "gate_verification_step_complete",
			goalId: "another-goal",
			gateId: firstTarget.gateId,
			signalId: firstTarget.signalId,
			stepName: firstTarget.stepName,
		} }));
		await launcher.updateComplete;
		expect(launcher.querySelector("button")).toBeTruthy();

		document.dispatchEvent(new CustomEvent("gate-verification-event", { detail: {
			type: "gate_verification_step_complete",
			gateId: firstTarget.gateId,
			signalId: firstTarget.signalId,
			stepName: firstTarget.stepName,
		} }));
		await launcher.updateComplete;
		expect(launcher.querySelector("button")).toBeNull();
	});

	it("does not dispatch an in-flight review after the launcher target changes", async () => {
		let resolveFetch!: (response: Response) => void;
		const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		}));
		vi.stubGlobal("fetch", fetchMock);
		const opened = vi.fn();
		window.addEventListener("bobbit-open-review-document", opened);
		try {
			const launcher = await renderDirectLauncher();
			const launched = vi.fn();
			launcher.addEventListener("signoff-review-launched", launched);
			launcher.querySelector("button").click();
			await launcher.updateComplete;
			const requestSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
			expect(requestSignal.aborted).toBe(false);

			launcher.target = { ...firstTarget, signalId: "signal-second" };
			await launcher.updateComplete;
			expect(requestSignal.aborted).toBe(true);
			resolveFetch(jsonResponse({ signals: [{ id: firstTarget.signalId, content: "Stale review" }] }));
			await flushLaunch();

			expect(opened).not.toHaveBeenCalled();
			expect(launched).not.toHaveBeenCalled();
			expect(launcher.querySelector("button")?.textContent).toContain("Start Review");
			expect(launcher.querySelector('[role="alert"]')).toBeNull();
		} finally {
			window.removeEventListener("bobbit-open-review-document", opened);
		}
	});

	it("does not dispatch an in-flight review after the launcher disconnects", async () => {
		let resolveFetch!: (response: Response) => void;
		const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => new Promise<Response>((resolve) => {
			resolveFetch = resolve;
		}));
		vi.stubGlobal("fetch", fetchMock);
		const opened = vi.fn();
		window.addEventListener("bobbit-open-review-document", opened);
		try {
			const launcher = await renderDirectLauncher();
			const launched = vi.fn();
			launcher.addEventListener("signoff-review-launched", launched);
			launcher.querySelector("button").click();
			await launcher.updateComplete;
			const requestSignal = fetchMock.mock.calls[0][1]?.signal as AbortSignal;
			launcher.remove();
			expect(requestSignal.aborted).toBe(true);
			resolveFetch(jsonResponse({ signals: [{ id: firstTarget.signalId, content: "Detached review" }] }));
			await flushLaunch();

			expect(opened).not.toHaveBeenCalled();
			expect(launched).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener("bobbit-open-review-document", opened);
		}
	});
});
