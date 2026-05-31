/**
 * WP0 / PR-0 — test-fidelity foundation.
 *
 * Pins that the mock agent CAN echo user image content blocks (the faithful
 * shape the real pi-agent produces, pi-agent-core/dist/agent.js:248-259). The
 * default mock echoed text-only and discarded forwarded images, which
 * structurally hid the image round-trip (S1/S6/S18/S26) from the entire e2e
 * tier — see docs/design/comms-stack/02-analysis.md §4 (P0). This test is the
 * harness pin that PR-A's render-from-content fix is asserted against.
 *
 * Pure node:test over MockAgentCore — no browser, no gateway.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockAgentCore } from "./e2e/mock-agent-core.mjs";

function makeCore() {
	const events: any[] = [];
	const core: any = new MockAgentCore({
		cwd: process.cwd(),
		env: { ...process.env },
		onEvent: (e: any) => events.push(e),
	});
	return { core, events };
}

async function runPrompt(core: any, message: string, images?: any[]) {
	await core.handleCommand({ type: "prompt", message, ...(images ? { images } : {}) });
	// handlePrompt runs on the per-instance promise chain; wait for the turn.
	await core._promptChain;
}

function userEcho(events: any[]) {
	return events.find((e) => e.type === "message_end" && e.message?.role === "user");
}

test("ECHO_IMAGE_BLOCK: user echo carries image content blocks from forwarded images", async () => {
	const { core, events } = makeCore();
	const images = [{ type: "image", data: "BASE64DATA", mimeType: "image/jpeg" }];
	await runPrompt(core, "ECHO_IMAGE_BLOCK here is a picture", images);

	const echo = userEcho(events);
	assert.ok(echo, "expected a user message_end echo");
	const imgBlock = echo.message.content.find((b: any) => b.type === "image");
	assert.ok(imgBlock, "user echo MUST include an image content block (was structurally impossible on master)");
	assert.equal(imgBlock.data, "BASE64DATA");
	assert.equal(imgBlock.mimeType, "image/jpeg", "preserves the real mimeType (not hardcoded image/png)");
	// The text block survives alongside the image.
	assert.ok(echo.message.content.some((b: any) => b.type === "text"));
});

test("default prompt (no trigger): user echo stays text-only — default path unchanged", async () => {
	const { core, events } = makeCore();
	// Images forwarded but NOT requested via the trigger → must be ignored.
	await runPrompt(core, "hello world", [{ type: "image", data: "X", mimeType: "image/png" }]);

	const echo = userEcho(events);
	assert.ok(echo, "expected a user message_end echo");
	assert.ok(
		echo.message.content.every((b: any) => b.type === "text"),
		"no ECHO_IMAGE_BLOCK trigger → echo is byte-identical to the legacy text-only shape",
	);
});

test("USER_ECHO_DELAY knob is wired and does not break the image echo", async () => {
	const { core, events } = makeCore();
	await runPrompt(core, "ECHO_IMAGE_BLOCK USER_ECHO_DELAY=40 delayed", [
		{ type: "image", data: "Y", mimeType: "image/png" },
	]);
	const echo = userEcho(events);
	assert.ok(echo?.message.content.some((b: any) => b.type === "image"), "image still attaches with the delay knob");
});
