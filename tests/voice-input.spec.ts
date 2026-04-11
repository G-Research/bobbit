/**
 * Unit fixture tests for voice input / SpeechRecognition (PI-09).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";

const FIXTURE = `file://${path.resolve("tests/voice-input.html").replace(/\\/g, "/")}`;

test.describe("Voice input (PI-09)", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(FIXTURE);
		await page.waitForFunction(() => (window as any)._testReady === true);
		await page.evaluate(() => (window as any).resetState());
	});

	test("mic button visible when SpeechRecognition supported", async ({ page }) => {
		await expect(page.locator("#mic-btn")).toBeVisible();
	});

	test("mic button hidden when SpeechRecognition not supported", async ({ page }) => {
		await page.evaluate(() => (window as any).setSpeechSupported(false));
		await expect(page.locator("#mic-btn")).toBeHidden();
	});

	test("click mic starts recording, click again stops", async ({ page }) => {
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		const mock = await page.evaluate(() => {
			const m = (window as any).getMockInstance();
			return { started: m._started, continuous: m.continuous, interimResults: m.interimResults };
		});
		expect(mock.started).toBe(true);
		expect(mock.continuous).toBe(true);
		expect(mock.interimResults).toBe(true);

		// Stop
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
	});

	test("mic button shows recording state", async ({ page }) => {
		await page.click("#mic-btn");
		await expect(page.locator("#mic-btn")).toHaveClass(/recording/);
		await expect(page.locator("#mic-btn")).toHaveText("Stop");

		await page.click("#mic-btn");
		await expect(page.locator("#mic-btn")).not.toHaveClass(/recording/);
		await expect(page.locator("#mic-btn")).toHaveText("Mic");
	});

	test("final speech result appended to textarea", async ({ page }) => {
		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "hello world", isFinal: true },
			]);
		});
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("hello world");
		expect(await page.inputValue("#textarea")).toBe("hello world");
	});

	test("interim results NOT displayed (only final)", async ({ page }) => {
		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "hel", isFinal: false },
			]);
		});
		// Interim results are ignored — textarea should remain empty
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("");
	});

	test("preSpeechText preserved — new speech appended with space", async ({ page }) => {
		await page.fill("#textarea", "existing text");
		// Sync value
		await page.evaluate(() => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.dispatchEvent(new Event("input"));
		});

		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "new words", isFinal: true },
			]);
		});

		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("existing text new words");
	});

	test("preSpeechText ending with space — no double space", async ({ page }) => {
		await page.fill("#textarea", "hello ");
		await page.evaluate(() => {
			const ta = document.getElementById("textarea") as HTMLTextAreaElement;
			ta.dispatchEvent(new Event("input"));
		});

		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "world", isFinal: true },
			]);
		});

		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("hello world");
	});

	test("cumulative mode (mobile) — last final contains all text", async ({ page }) => {
		await page.click("#mic-btn");
		await page.evaluate(() => {
			// Mobile: each subsequent final includes all prior text
			(window as any)._triggerResult([
				{ transcript: "hello", isFinal: true },
				{ transcript: "hello world", isFinal: true },
			]);
		});

		// Should use the last final (cumulative), not concatenate
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("hello world");
	});

	test("segment mode (desktop) — finals concatenated", async ({ page }) => {
		await page.click("#mic-btn");
		await page.evaluate(() => {
			// Desktop: each final is a separate segment
			(window as any)._triggerResult([
				{ transcript: "hello ", isFinal: true },
				{ transcript: "world", isFinal: true },
			]);
		});

		// Should concatenate (second doesn't start with first)
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("hello world");
	});

	test("no-speech error does NOT stop recording", async ({ page }) => {
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		await page.evaluate(() => (window as any)._triggerError("no-speech"));

		// Still recording
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);
	});

	test("network error stops recording", async ({ page }) => {
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		await page.evaluate(() => (window as any)._triggerError("network"));

		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
	});

	test("aborted error stops recording", async ({ page }) => {
		await page.click("#mic-btn");
		await page.evaluate(() => (window as any)._triggerError("aborted"));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
	});

	test("continuous mode — recognition auto-restarts on end while recording", async ({ page }) => {
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		// Simulate recognition ending (e.g., mobile pause)
		// The mock's start() will throw if called while already started,
		// so we need to reset its state first like the real browser would
		await page.evaluate(() => {
			const m = (window as any).getMockInstance();
			m._started = false; // Browser resets this on end
			(window as any)._triggerEnd();
		});

		// Should still be recording — recognition restarted
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		// Mock instance should be started again
		const restarted = await page.evaluate(() => (window as any).getMockInstance()._started);
		expect(restarted).toBe(true);
	});

	test("continuous restart updates preSpeechText", async ({ page }) => {
		await page.click("#mic-btn");

		// Speak some text
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "first part", isFinal: true },
			]);
		});
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("first part");

		// Simulate recognition ending and restarting
		await page.evaluate(() => {
			const m = (window as any).getMockInstance();
			m._started = false;
			(window as any)._triggerEnd();
		});

		// preSpeechText should now be "first part"
		expect(await page.evaluate(() => (window as any).getPreSpeechText())).toBe("first part");

		// New speech should append after "first part"
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "second part", isFinal: true },
			]);
		});
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("first part second part");
	});

	test("onend after explicit stop does NOT restart", async ({ page }) => {
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		// Stop explicitly
		await page.click("#mic-btn");
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);

		// Wait for the delayed stop() to fire and trigger onend
		await page.waitForTimeout(600);

		// Should remain not recording
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
	});

	test("F13 keydown starts recognition", async ({ page }) => {
		// Playwright doesn't support F13, so dispatch manually
		await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" })));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);
	});

	test("F13 keyup stops recognition", async ({ page }) => {
		await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" })));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { key: "F13" })));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
	});

	test("F13 push-to-talk — hold and release", async ({ page }) => {
		await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" })));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(true);

		// Speak while held
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "push to talk", isFinal: true },
			]);
		});

		await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keyup", { key: "F13" })));
		expect(await page.evaluate(() => (window as any).isRecording())).toBe(false);
		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("push to talk");
	});

	test("multiple speech sessions accumulate correctly", async ({ page }) => {
		// First session
		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "first", isFinal: true },
			]);
		});
		await page.click("#mic-btn"); // stop

		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("first");

		// Wait for stop timeout
		await page.waitForTimeout(600);

		// Second session — should append after "first"
		await page.click("#mic-btn");
		await page.evaluate(() => {
			(window as any)._triggerResult([
				{ transcript: "second", isFinal: true },
			]);
		});

		expect(await page.evaluate(() => (window as any).getTextareaValue())).toBe("first second");
	});
});
