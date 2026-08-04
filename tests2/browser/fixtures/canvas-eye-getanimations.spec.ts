/** Gateway-free coverage for the real boundary-driven canvas eye scheduler. */
import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const FIXTURE = path.resolve("tests/fixtures/canvas-eye-getanimations.html");
const BUNDLE = path.resolve("tests/fixtures/canvas-eye-getanimations-bundle.js");
const ENTRY = path.resolve("tests/fixtures/canvas-eye-getanimations-entry.ts");
const SOURCES = [ENTRY, path.resolve("src/ui/bobbit-render.ts"), path.resolve("src/ui/bobbit-sprite-data.ts")];

function fileUrl(file: string): string {
	return `file://${file.replace(/\\/g, "/")}`;
}

test.beforeAll(() => {
	const sourceMtime = Math.max(...SOURCES.map(source => fs.statSync(source).mtimeMs));
	if (!fs.existsSync(BUNDLE) || fs.statSync(BUNDLE).mtimeMs < sourceMtime) {
		execSync([
			`npx esbuild ${ENTRY}`,
			"--bundle --format=iife --target=es2022",
			`--outfile=${BUNDLE}`,
			"--tsconfig=tsconfig.web.json",
		].join(" "), { stdio: "pipe" });
	}
});

async function openFixture(page: import("@playwright/test").Page): Promise<void> {
	await page.goto(fileUrl(FIXTURE));
	await page.waitForFunction(() => (window as any).__ready === true);
}

test.describe("Canvas eye boundary scheduler", () => {
	test("samples every boundary, wrap, and fake negative-delay phase exactly", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			let currentTime: number | null = 0;
			let effectDelay = 0;
			const animation = {
				get currentTime() { return currentTime; },
				effect: { getTiming: () => ({ duration: 10000, delay: effectDelay }) },
			};
			(canvas as any).getAnimations = () => [animation];
			const originalSetTimeout = window.setTimeout;
			const originalClearTimeout = window.clearTimeout;
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let timerId = 0;
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++timerId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);

			const hash = (target: HTMLCanvasElement): number => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 2166136261;
				for (let i = 0; i < data.length; i += 17) value = Math.imul(value ^ data[i], 16777619);
				return value >>> 0;
			};
			const references = new Map<string, number>();
			for (const frame of [...api.sequences.busy, ...api.sequences.idle]) {
				const key = `${frame.gaze}-${frame.blink}`;
				if (references.has(key)) continue;
				const reference = document.createElement("canvas");
				api.startSequence(reference, 10000, [{ ...frame, pct: 0 }])();
				references.set(key, hash(reference));
			}
			const expectedKey = (sequence: any[], raw: number, delay: number): string => {
				const activeTime = raw - delay;
				const phase = ((activeTime % 10000) + 10000) % 10000;
				let frame = sequence[sequence.length - 1];
				for (let i = sequence.length - 1; i >= 0; i--) {
					if (phase >= sequence[i].pct * 100) { frame = sequence[i]; break; }
				}
				return `${frame.gaze}-${frame.blink}`;
			};
			const failures: string[] = [];
			for (const kind of ["busy", "idle"] as const) {
				effectDelay = 0;
				const sequence = api.sequences[kind];
				const stop = api.start(canvas, 10000, kind);
				const samples = new Set<number>([-1, 0, 10000, 20001]);
				for (const frame of sequence) {
					const boundary = frame.pct * 100;
					samples.add(boundary - 0.01);
					samples.add(boundary);
					samples.add(boundary + 0.01);
				}
				for (const sample of samples) {
					currentTime = sample;
					canvas.dispatchEvent(new AnimationEvent("animationstart"));
					const expected = references.get(expectedKey(sequence, sample, effectDelay));
					if (hash(canvas) !== expected) failures.push(`${kind}@${sample}`);
				}
				stop();
			}

			// WAAPI currentTime does not include KeyframeEffect.delay. A negative
			// CSS delay therefore advances active time by the opposite amount.
			effectDelay = -2700;
			currentTime = 0;
			const stop = api.start(canvas, 10000, "idle");
			const negativeDelayKey = expectedKey(api.sequences.idle, currentTime, effectDelay);
			const negativeDelayMatches = hash(canvas) === references.get(negativeDelayKey);
			stop();
			(window as any).setTimeout = originalSetTimeout;
			(window as any).clearTimeout = originalClearTimeout;
			return { failures, negativeDelayKey, negativeDelayMatches };
		});
		expect(result.failures).toEqual([]);
		expect(result.negativeDelayKey).toBe("up-right-false");
		expect(result.negativeDelayMatches).toBe(true);
	});

	test("uses exact callback budgets, skips late boundaries, and never requests scheduler rAF", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			let currentTime: number | null = 0;
			const animation = {
				get currentTime() { return currentTime; },
				effect: { getTiming: () => ({ duration: 10000, delay: 0 }) },
			};
			(canvas as any).getAnimations = () => [animation];
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let nextId = 0;
			let rafRequests = 0;
			const nativeRaf = window.requestAnimationFrame;
			const nativeSetTimeout = window.setTimeout;
			const nativeClearTimeout = window.clearTimeout;
			(window as any).requestAnimationFrame = () => { rafRequests++; return 1; };
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++nextId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);
			const hash = (target: HTMLCanvasElement): number => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 23) value = Math.imul(value ^ data[i], 31);
				return value >>> 0;
			};
			const run = (kind: "busy" | "idle") => {
				currentTime = 0;
				timers.clear();
				const stop = api.start(canvas, 10000, kind);
				let callbacks = 0;
				while (true) {
					const [id, timer] = [...timers.entries()][0] ?? [];
					if (!timer || (currentTime as number) + timer.delay > 20000) break;
					timers.delete(id);
					currentTime = (currentTime as number) + timer.delay;
					timer.callback();
					callbacks++;
				}
				stop();
				return callbacks;
			};
			const busy = run("busy");
			const idle = run("idle");

			currentTime = 0;
			timers.clear();
			const stop = api.start(canvas, 10000, "busy");
			const [lateId, lateTimer] = [...timers.entries()][0];
			timers.delete(lateId);
			currentTime = 6500;
			lateTimer.callback();
			const expected = document.createElement("canvas");
			api.startSequence(expected, 10000, [{ pct: 0, gaze: "left", blink: false }])();
			const lateWake = {
				pixelsMatch: hash(canvas) === hash(expected),
				pending: timers.size,
				nextDelay: [...timers.values()][0]?.delay,
			};
			stop();
			(window as any).requestAnimationFrame = nativeRaf;
			(window as any).setTimeout = nativeSetTimeout;
			(window as any).clearTimeout = nativeClearTimeout;
			return { busy, idle, rafRequests, lateWake };
		});
		expect(result).toEqual({
			busy: 30,
			idle: 22,
			rafRequests: 0,
			lateWake: { pixelsMatch: true, pending: 1, nextDelay: 300 },
		});
	});

	test("sleep paints exactly once and installs no steady-state work", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const reference = document.createElement("canvas");
			api.startSequence(reference, 10000, [{ pct: 0, gaze: "center", blink: true }])();
			const hash = (target: HTMLCanvasElement) => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 19) value = Math.imul(value ^ data[i], 33);
				return value >>> 0;
			};
			const nativeSetTimeout = window.setTimeout;
			const nativeClearTimeout = window.clearTimeout;
			const nativeRaf = window.requestAnimationFrame;
			const nativeAdd = EventTarget.prototype.addEventListener;
			const nativeRemove = EventTarget.prototype.removeEventListener;
			const nativeDraw = CanvasRenderingContext2D.prototype.drawImage;
			let timerRequests = 0;
			let rafRequests = 0;
			let listenerAdds = 0;
			let listenerRemoves = 0;
			let draws = 0;
			let getAnimationsCalls = 0;
			(canvas as any).getAnimations = () => { getAnimationsCalls++; return []; };
			(window as any).setTimeout = () => { timerRequests++; return 1; };
			(window as any).clearTimeout = () => undefined;
			(window as any).requestAnimationFrame = () => { rafRequests++; return 1; };
			EventTarget.prototype.addEventListener = function (type: string, ...args: any[]) {
				if ((this === canvas || this === document) && ["visibilitychange", "animationstart", "animationcancel"].includes(type)) listenerAdds++;
				return (nativeAdd as any).call(this, type, ...args);
			};
			EventTarget.prototype.removeEventListener = function (type: string, ...args: any[]) {
				if ((this === canvas || this === document) && ["visibilitychange", "animationstart", "animationcancel"].includes(type)) listenerRemoves++;
				return (nativeRemove as any).call(this, type, ...args);
			};
			CanvasRenderingContext2D.prototype.drawImage = function (...args: any[]) {
				draws++;
				return (nativeDraw as any).apply(this, args);
			};
			const stop = api.start(canvas, 10000, "sleep");
			const pixelsMatch = hash(canvas) === hash(reference);
			stop();
			(window as any).setTimeout = nativeSetTimeout;
			(window as any).clearTimeout = nativeClearTimeout;
			(window as any).requestAnimationFrame = nativeRaf;
			EventTarget.prototype.addEventListener = nativeAdd;
			EventTarget.prototype.removeEventListener = nativeRemove;
			CanvasRenderingContext2D.prototype.drawImage = nativeDraw;
			return { timerRequests, rafRequests, listenerAdds, listenerRemoves, draws, getAnimationsCalls, pixelsMatch };
		});
		expect(result).toEqual({
			timerRequests: 0,
			rafRequests: 0,
			listenerAdds: 0,
			listenerRemoves: 0,
			draws: 1,
			getAnimationsCalls: 0,
			pixelsMatch: true,
		});
	});

	test("visibility, cache lifetime, replacement, stale callbacks, and cleanup stay event-driven", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const hash = (target: HTMLCanvasElement): number => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 31) value = Math.imul(value ^ data[i], 37);
				return value >>> 0;
			};
			const expectedVisible = document.createElement("canvas");
			api.startSequence(expectedVisible, 10000, [{ pct: 0, gaze: "up-right", blink: true }])();
			const expectedReplacement = document.createElement("canvas");
			api.startSequence(expectedReplacement, 10000, [{ pct: 0, gaze: "up-right", blink: false }])();
			let hidden = false;
			Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
			let firstTime: number | null = 3400;
			const first: any = {
				get currentTime() { return firstTime; },
				effect: { getTiming: () => ({ duration: 10000, delay: 0 }) },
			};
			let listed: any[] = [first];
			let getAnimationsCalls = 0;
			(canvas as any).getAnimations = () => { getAnimationsCalls++; return listed; };
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let nextId = 0;
			const nativeSetTimeout = window.setTimeout;
			const nativeClearTimeout = window.clearTimeout;
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++nextId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);

			const stop = api.start(canvas, 10000, "busy");
			const callsAfterResolve = getAnimationsCalls;
			let [id, timer] = [...timers.entries()][0];
			timers.delete(id);
			firstTime = 3600;
			timer.callback();
			[id, timer] = [...timers.entries()][0];
			timers.delete(id);
			firstTime = 3700;
			timer.callback();
			const callsAfterCachedWakeups = getAnimationsCalls;

			hidden = true;
			document.dispatchEvent(new Event("visibilitychange"));
			const hiddenTimers = timers.size;
			firstTime = 6400;
			hidden = false;
			document.dispatchEvent(new Event("visibilitychange"));
			const visible = {
				timers: timers.size,
				delay: [...timers.values()][0]?.delay,
				pixelsMatch: hash(canvas) === hash(expectedVisible),
			};

			const [staleId, staleTimer] = [...timers.entries()][0];
			firstTime = 6450;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const activeId = [...timers.keys()][0];
			staleTimer.callback();
			const staleInert = timers.size === 1 && !timers.has(staleId) && timers.has(activeId);

			firstTime = null;
			listed = [];
			canvas.dispatchEvent(new AnimationEvent("animationcancel"));
			const cancelled = { timers: timers.size, calls: getAnimationsCalls };
			let replacementTime = 6000;
			const replacement = {
				get currentTime() { return replacementTime; },
				effect: { getTiming: () => ({ duration: 10000, delay: 0 }) },
			};
			listed = [replacement];
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const replaced = {
				timers: timers.size,
				delay: [...timers.values()][0]?.delay,
				calls: getAnimationsCalls,
				pixelsMatch: hash(canvas) === hash(expectedReplacement),
			};
			const queued = [...timers.values()][0]?.callback;
			stop();
			queued?.();
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			document.dispatchEvent(new Event("visibilitychange"));
			const afterCleanup = { timers: timers.size, calls: getAnimationsCalls };
			(window as any).setTimeout = nativeSetTimeout;
			(window as any).clearTimeout = nativeClearTimeout;
			return {
				callsAfterResolve,
				callsAfterCachedWakeups,
				hiddenTimers,
				visible,
				staleInert,
				cancelled,
				replaced,
				afterCleanup,
			};
		});
		expect(result).toEqual({
			callsAfterResolve: 1,
			callsAfterCachedWakeups: 1,
			hiddenTimers: 0,
			visible: { timers: 1, delay: 100, pixelsMatch: true },
			staleInert: true,
			cancelled: { timers: 0, calls: 3 },
			replaced: { timers: 1, delay: 400, calls: 4, pixelsMatch: true },
			afterCleanup: { timers: 0, calls: 4 },
		});
	});

	test("recovers from the real enter animation when the active CSS animation starts", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(async () => {
			const api = (window as any).__canvasEyeAnim;
			const blob = document.getElementById("blob")!;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const nativeSetTimeout = window.setTimeout;
			const nativeClearTimeout = window.clearTimeout;
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let nextId = 0;
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++nextId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);
			blob.className = "bobbit-blob bobbit-blob--enter";
			const enterName = getComputedStyle(canvas).animationName;
			const stop = api.start(canvas, 10000, "busy");
			const pendingDuringEnter = timers.size;
			const activeStarted = new Promise<string>((resolve, reject) => {
				let watchdog = 0;
				const onStart = (event: Event) => {
					const name = (event as AnimationEvent).animationName;
					if (name !== "blob-busy-move-canvas") return;
					nativeClearTimeout(watchdog);
					canvas.removeEventListener("animationstart", onStart);
					resolve(name);
				};
				canvas.addEventListener("animationstart", onStart);
				watchdog = nativeSetTimeout(() => reject(new Error("active animation did not start")), 2000);
			});
			blob.className = "bobbit-blob";
			const activeName = await activeStarted;
			const matching = canvas.getAnimations().find(animation => animation.effect?.getTiming().duration === 10000)!;
			matching.pause();
			matching.currentTime = 3400;
			const [timerId, timer] = [...timers.entries()][0];
			timers.delete(timerId);
			timer.callback();
			const expected = document.createElement("canvas");
			api.startSequence(expected, 10000, [{ pct: 0, gaze: "right", blink: false }])();
			const hash = (target: HTMLCanvasElement) => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 29) value = Math.imul(value ^ data[i], 41);
				return value >>> 0;
			};
			const recoveredPixels = hash(canvas) === hash(expected);
			const pendingAfterRecovery = timers.size;
			stop();
			(window as any).setTimeout = nativeSetTimeout;
			(window as any).clearTimeout = nativeClearTimeout;
			return { enterName, pendingDuringEnter, activeName, pendingAfterRecovery, recoveredPixels };
		});
		expect(result.enterName).toContain("blob-enter-canvas");
		expect(result).toMatchObject({
			pendingDuringEnter: 0,
			activeName: "blob-busy-move-canvas",
			pendingAfterRecovery: 1,
			recoveredPixels: true,
		});
	});

	test("real CSS negative idle delay advances the sampled eye phase", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const blob = document.getElementById("blob") as HTMLElement;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			blob.style.setProperty("--bobbit-idle-phase", "-2.7s");
			blob.className = "bobbit-blob bobbit-blob--idle";
			void getComputedStyle(canvas).animationName;
			const animation = canvas.getAnimations().find(candidate => candidate.effect?.getTiming().duration === 10000)!;
			animation.pause();
			animation.currentTime = 0;
			const timing = animation.effect!.getTiming();
			const computed = animation.effect!.getComputedTiming();
			const stop = api.start(canvas, 10000, "idle");
			const expected = document.createElement("canvas");
			api.startSequence(expected, 10000, [{ pct: 0, gaze: "up-right", blink: false }])();
			const hash = (target: HTMLCanvasElement) => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 13) value = Math.imul(value ^ data[i], 43);
				return value >>> 0;
			};
			const pixelsMatch = hash(canvas) === hash(expected);
			stop();
			return { delay: timing.delay, progress: computed.progress, pixelsMatch };
		});
		expect(result.delay).toBe(-2700);
		expect(result.progress).toBeCloseTo(0.27, 5);
		expect(result.pixelsMatch).toBe(true);
	});

	test("archived renderer is static with zero scheduler work", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(async () => {
			const api = (window as any).__canvasEyeAnim;
			const host = document.getElementById("archived")!;
			const reference = document.createElement("canvas");
			api.startSequence(reference, 10000, [{ pct: 0, gaze: "center", blink: false }])();
			const hash = (target: HTMLCanvasElement) => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 17) value = Math.imul(value ^ data[i], 47);
				return value >>> 0;
			};
			const nativeSetTimeout = window.setTimeout;
			const nativeClearTimeout = window.clearTimeout;
			const nativeRaf = window.requestAnimationFrame;
			const nativeAdd = EventTarget.prototype.addEventListener;
			const nativeGetAnimations = Element.prototype.getAnimations;
			let timerRequests = 0;
			let rafRequests = 0;
			let schedulerListeners = 0;
			let getAnimationsCalls = 0;
			(window as any).setTimeout = () => { timerRequests++; return 1; };
			(window as any).clearTimeout = () => undefined;
			(window as any).requestAnimationFrame = () => { rafRequests++; return 1; };
			EventTarget.prototype.addEventListener = function (type: string, ...args: any[]) {
				if ((this === document || this instanceof HTMLCanvasElement) && ["visibilitychange", "animationstart", "animationcancel"].includes(type)) schedulerListeners++;
				return (nativeAdd as any).call(this, type, ...args);
			};
			Element.prototype.getAnimations = function (...args: any[]) {
				getAnimationsCalls++;
				return (nativeGetAnimations as any).apply(this, args);
			};
			const canvas = api.renderArchived(host);
			const firstHash = hash(canvas);
			const expectedHash = hash(reference);
			(window as any).setTimeout = nativeSetTimeout;
			(window as any).clearTimeout = nativeClearTimeout;
			(window as any).requestAnimationFrame = nativeRaf;
			EventTarget.prototype.addEventListener = nativeAdd;
			Element.prototype.getAnimations = nativeGetAnimations;
			await new Promise<void>(resolve => nativeRaf(() => nativeRaf(() => resolve())));
			return {
				timerRequests,
				rafRequests,
				schedulerListeners,
				getAnimationsCalls,
				pixelsMatch: firstHash === expectedHash,
				pixelsStable: hash(canvas) === firstHash,
				runningAnimations: canvas.getAnimations().filter((animation: Animation) => animation.playState === "running").length,
			};
		});
		expect(result).toEqual({
			timerRequests: 0,
			rafRequests: 0,
			schedulerListeners: 0,
			getAnimationsCalls: 0,
			pixelsMatch: true,
			pixelsStable: true,
			runningAnimations: 0,
		});
	});

	test("keeps real CSS motion running while eyes change only at boundaries", async ({ page }) => {
		await openFixture(page);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Performance.enable");
		const before = await cdp.send("Performance.getMetrics");
		const result = await page.evaluate(async () => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const center = document.createElement("canvas");
			api.startSequence(center, 10000, [{ pct: 0, gaze: "center", blink: false }])();
			const blink = document.createElement("canvas");
			api.startSequence(blink, 10000, [{ pct: 0, gaze: "center", blink: true }])();
			const hash = (target: HTMLCanvasElement) => {
				const data = target.getContext("2d")!.getImageData(0, 0, target.width, target.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 29) value = Math.imul(value ^ data[i], 31);
				return value >>> 0;
			};
			const stop = api.start(canvas, 10000, "busy");
			const animation = canvas.getAnimations().find(candidate => candidate.effect?.getTiming().duration === 10000)!;
			animation.currentTime = 100;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const time1 = Number(animation.currentTime);
			const transform1 = getComputedStyle(canvas).transform;
			const pixels1 = hash(canvas);
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const time2 = Number(animation.currentTime);
			const transform2 = getComputedStyle(canvas).transform;
			const pixels2 = hash(canvas);
			animation.currentTime = 1590;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const beforeBoundary = hash(canvas);
			await new Promise(resolve => setTimeout(resolve, 40));
			const afterBoundary = hash(canvas);
			const playState = animation.playState;
			stop();
			return {
				time1,
				time2,
				transform1,
				transform2,
				pixels1,
				pixels2,
				beforeBoundary,
				afterBoundary,
				centerHash: hash(center),
				blinkHash: hash(blink),
				playState,
			};
		});
		const after = await cdp.send("Performance.getMetrics");
		const metric = (metrics: any, name: string): number => metrics.metrics.find((item: any) => item.name === name)?.value ?? Number.NaN;
		const taskDelta = metric(after, "TaskDuration") - metric(before, "TaskDuration");
		expect(result.playState).toBe("running");
		expect(result.time2).toBeGreaterThan(result.time1);
		expect(result.transform2).not.toBe(result.transform1);
		expect(result.pixels1).toBe(result.centerHash);
		expect(result.pixels2).toBe(result.centerHash);
		expect(result.beforeBoundary).toBe(result.centerHash);
		expect(result.afterBoundary).toBe(result.blinkHash);
		// CDP task time is a finite observation proxy, not a cross-machine limit.
		expect(Number.isFinite(taskDelta)).toBe(true);
		expect(taskDelta).toBeGreaterThan(0);
	});
});
