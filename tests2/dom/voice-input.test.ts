import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Migrated from tests/voice-input.spec.ts (v2-dom tier).
//
// The legacy file:// fixture replicated MessageEditor's SpeechRecognition
// behaviour (PI-09) as a self-contained DOM + JS harness with a controllable
// mock SpeechRecognition (the real MessageEditor needs the full editor graph to
// mount). We reproduce that harness under happy-dom and assert the identical
// facts. No geometry is involved. Timer-dependent behaviour (500ms stop debounce,
// 10ms onend) uses vitest fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class MockSpeechRecognition {
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: ((event: any) => void) | null = null;
	onerror: ((event: any) => void) | null = null;
	onend: (() => void) | null = null;
	_started = false;
	_stopped = false;
	constructor() {
		lastMock = this;
	}
	start() {
		if (this._started) throw new Error("Already started");
		this._started = true;
		this._stopped = false;
	}
	stop() {
		this._started = false;
		this._stopped = true;
		setTimeout(() => {
			if (this.onend) this.onend();
		}, 10);
	}
	abort() {
		this._started = false;
		this._stopped = true;
		setTimeout(() => {
			if (this.onend) this.onend();
		}, 10);
	}
}

let lastMock: MockSpeechRecognition | null = null;

function setup() {
	lastMock = null;
	document.body.innerHTML = `
		<textarea id="textarea" rows="3"></textarea>
		<button id="mic-btn">Mic</button>`;

	(window as any).SpeechRecognition = MockSpeechRecognition;
	(window as any).webkitSpeechRecognition = MockSpeechRecognition;

	let speechRecognition: MockSpeechRecognition | null = null;
	let speechSupported = true;
	let recording = false;
	let preSpeechText = "";
	let stopTimeout: ReturnType<typeof setTimeout> | null = null;
	let value = "";

	const textarea = document.getElementById("textarea") as HTMLTextAreaElement;
	const micBtn = document.getElementById("mic-btn") as HTMLButtonElement;

	function updateUI() {
		micBtn.classList.toggle("recording", recording);
		micBtn.textContent = recording ? "Stop" : "Mic";
		micBtn.title = recording ? "Stop recording" : "Start recording";
		if (!speechSupported) micBtn.classList.add("hidden");
		else micBtn.classList.remove("hidden");
	}

	function toggleSpeechRecognition() {
		if (recording) stopSpeechRecognition();
		else startSpeechRecognition();
	}

	function startSpeechRecognition() {
		if (!speechSupported) return;
		const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
		const recognition: MockSpeechRecognition = new Ctor();
		recognition.continuous = true;
		recognition.interimResults = true;
		recognition.lang = navigator.language || "en-US";

		preSpeechText = value;

		recognition.onresult = (event: any) => {
			const nonEmptyFinals: string[] = [];
			for (let i = 0; i < event.results.length; i++) {
				const result = event.results[i];
				if (result.isFinal) {
					const t = result[0].transcript;
					if (t) nonEmptyFinals.push(t);
				}
			}
			if (nonEmptyFinals.length === 0) return;

			const isCumulative =
				nonEmptyFinals.length >= 2 &&
				nonEmptyFinals[nonEmptyFinals.length - 1].startsWith(nonEmptyFinals[nonEmptyFinals.length - 2]);

			const fullText = isCumulative ? nonEmptyFinals[nonEmptyFinals.length - 1] : nonEmptyFinals.join("");
			const separator = preSpeechText && !preSpeechText.endsWith(" ") ? " " : "";
			value = preSpeechText + separator + fullText;
			textarea.value = value;
		};

		recognition.onerror = (event: any) => {
			if (event.error !== "no-speech") {
				stopSpeechRecognition();
				updateUI();
			}
		};

		recognition.onend = () => {
			if (recording && speechRecognition === recognition) {
				preSpeechText = value;
				try {
					recognition.start();
				} catch {
					recording = false;
					speechRecognition = null;
					updateUI();
				}
			} else {
				recording = false;
				speechRecognition = null;
				updateUI();
			}
		};

		speechRecognition = recognition;
		recording = true;
		recognition.start();
		updateUI();
	}

	function stopSpeechRecognition() {
		if (stopTimeout) {
			clearTimeout(stopTimeout);
			stopTimeout = null;
		}
		if (speechRecognition) {
			const recognition = speechRecognition;
			stopTimeout = setTimeout(() => {
				recognition.stop();
				stopTimeout = null;
			}, 500);
			speechRecognition = null;
		}
		recording = false;
		updateUI();
	}

	micBtn.addEventListener("click", toggleSpeechRecognition);
	textarea.addEventListener("input", (e) => {
		value = (e.target as HTMLTextAreaElement).value;
	});

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key === "F13" && !e.repeat) {
			e.preventDefault();
			startSpeechRecognition();
		}
	};
	const onKeyUp = (e: KeyboardEvent) => {
		if (e.key === "F13") {
			e.preventDefault();
			stopSpeechRecognition();
		}
	};
	document.addEventListener("keydown", onKeyDown);
	document.addEventListener("keyup", onKeyUp);

	updateUI();

	return {
		textarea,
		micBtn,
		triggerResult: (results: { transcript: string; isFinal: boolean }[]) => {
			const resultList: any = results.map((r) => {
				const res: any = [{ transcript: r.transcript }];
				res.isFinal = r.isFinal;
				return res;
			});
			resultList.length = results.length;
			if (lastMock && lastMock.onresult) lastMock.onresult({ results: resultList });
		},
		triggerError: (errorType: string) => {
			if (lastMock && lastMock.onerror) lastMock.onerror({ error: errorType });
		},
		triggerEnd: () => {
			if (lastMock && lastMock.onend) lastMock.onend();
		},
		isRecording: () => recording,
		getTextareaValue: () => value,
		getMockInstance: () => lastMock,
		getPreSpeechText: () => preSpeechText,
		setSpeechSupported: (supported: boolean) => {
			speechSupported = supported;
			if (!supported) {
				(window as any).SpeechRecognition = undefined;
				(window as any).webkitSpeechRecognition = undefined;
			} else {
				(window as any).SpeechRecognition = MockSpeechRecognition;
			}
			updateUI();
		},
		teardown: () => {
			document.removeEventListener("keydown", onKeyDown);
			document.removeEventListener("keyup", onKeyUp);
		},
	};
}

type Harness = ReturnType<typeof setup>;
let h: Harness;

beforeEach(() => {
	vi.useFakeTimers();
	h = setup();
});
afterEach(() => {
	h.teardown();
	vi.clearAllTimers();
	vi.useRealTimers();
	document.body.innerHTML = "";
	(window as any).SpeechRecognition = undefined;
	(window as any).webkitSpeechRecognition = undefined;
});

const isHidden = (el: Element) => el.classList.contains("hidden");
const hasClass = (el: Element, c: string) => el.classList.contains(c);

describe("Voice input (PI-09)", () => {
	it("mic button visible when SpeechRecognition supported", () => {
		expect(isHidden(h.micBtn)).toBe(false);
	});

	it("mic button hidden when SpeechRecognition not supported", () => {
		h.setSpeechSupported(false);
		expect(isHidden(h.micBtn)).toBe(true);
	});

	it("click mic starts recording, click again stops", () => {
		h.micBtn.click();
		expect(h.isRecording()).toBe(true);

		const mock = h.getMockInstance()!;
		expect(mock._started).toBe(true);
		expect(mock.continuous).toBe(true);
		expect(mock.interimResults).toBe(true);

		h.micBtn.click();
		expect(h.isRecording()).toBe(false);
	});

	it("mic button shows recording state", () => {
		h.micBtn.click();
		expect(hasClass(h.micBtn, "recording")).toBe(true);
		expect(h.micBtn.textContent).toBe("Stop");

		h.micBtn.click();
		expect(hasClass(h.micBtn, "recording")).toBe(false);
		expect(h.micBtn.textContent).toBe("Mic");
	});

	it("final speech result appended to textarea", () => {
		h.micBtn.click();
		h.triggerResult([{ transcript: "hello world", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("hello world");
		expect(h.textarea.value).toBe("hello world");
	});

	it("interim results NOT displayed (only final)", () => {
		h.micBtn.click();
		h.triggerResult([{ transcript: "hel", isFinal: false }]);
		expect(h.getTextareaValue()).toBe("");
	});

	it("preSpeechText preserved — new speech appended with space", () => {
		h.textarea.value = "existing text";
		h.textarea.dispatchEvent(new Event("input"));

		h.micBtn.click();
		h.triggerResult([{ transcript: "new words", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("existing text new words");
	});

	it("preSpeechText ending with space — no double space", () => {
		h.textarea.value = "hello ";
		h.textarea.dispatchEvent(new Event("input"));

		h.micBtn.click();
		h.triggerResult([{ transcript: "world", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("hello world");
	});

	it("cumulative mode (mobile) — last final contains all text", () => {
		h.micBtn.click();
		h.triggerResult([
			{ transcript: "hello", isFinal: true },
			{ transcript: "hello world", isFinal: true },
		]);
		expect(h.getTextareaValue()).toBe("hello world");
	});

	it("segment mode (desktop) — finals concatenated", () => {
		h.micBtn.click();
		h.triggerResult([
			{ transcript: "hello ", isFinal: true },
			{ transcript: "world", isFinal: true },
		]);
		expect(h.getTextareaValue()).toBe("hello world");
	});

	it("no-speech error does NOT stop recording", () => {
		h.micBtn.click();
		expect(h.isRecording()).toBe(true);
		h.triggerError("no-speech");
		expect(h.isRecording()).toBe(true);
	});

	it("network error stops recording", () => {
		h.micBtn.click();
		expect(h.isRecording()).toBe(true);
		h.triggerError("network");
		expect(h.isRecording()).toBe(false);
	});

	it("aborted error stops recording", () => {
		h.micBtn.click();
		h.triggerError("aborted");
		expect(h.isRecording()).toBe(false);
	});

	it("continuous mode — recognition auto-restarts on end while recording", () => {
		h.micBtn.click();
		expect(h.isRecording()).toBe(true);

		const m = h.getMockInstance()!;
		m._started = false;
		h.triggerEnd();

		expect(h.isRecording()).toBe(true);
		expect(h.getMockInstance()!._started).toBe(true);
	});

	it("continuous restart updates preSpeechText", () => {
		h.micBtn.click();
		h.triggerResult([{ transcript: "first part", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("first part");

		const m = h.getMockInstance()!;
		m._started = false;
		h.triggerEnd();

		expect(h.getPreSpeechText()).toBe("first part");

		h.triggerResult([{ transcript: "second part", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("first part second part");
	});

	it("onend after explicit stop does NOT restart", () => {
		h.micBtn.click();
		expect(h.isRecording()).toBe(true);

		h.micBtn.click();
		expect(h.isRecording()).toBe(false);

		// Flush the 500ms stop() debounce + the 10ms onend.
		vi.advanceTimersByTime(600);
		expect(h.isRecording()).toBe(false);
	});

	it("F13 keydown starts recognition", () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" }));
		expect(h.isRecording()).toBe(true);
	});

	it("F13 keyup stops recognition", () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" }));
		expect(h.isRecording()).toBe(true);
		document.dispatchEvent(new KeyboardEvent("keyup", { key: "F13" }));
		expect(h.isRecording()).toBe(false);
	});

	it("F13 push-to-talk — hold and release", () => {
		document.dispatchEvent(new KeyboardEvent("keydown", { key: "F13" }));
		expect(h.isRecording()).toBe(true);

		h.triggerResult([{ transcript: "push to talk", isFinal: true }]);

		document.dispatchEvent(new KeyboardEvent("keyup", { key: "F13" }));
		expect(h.isRecording()).toBe(false);
		expect(h.getTextareaValue()).toBe("push to talk");
	});

	it("multiple speech sessions accumulate correctly", () => {
		h.micBtn.click();
		h.triggerResult([{ transcript: "first", isFinal: true }]);
		h.micBtn.click();
		expect(h.getTextareaValue()).toBe("first");

		vi.advanceTimersByTime(600);

		h.micBtn.click();
		h.triggerResult([{ transcript: "second", isFinal: true }]);
		expect(h.getTextareaValue()).toBe("first second");
	});
});
