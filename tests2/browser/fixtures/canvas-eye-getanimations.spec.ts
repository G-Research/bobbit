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
	test("samples every busy and idle boundary, wrap, and negative phase exactly", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			let currentTime: number | null = 0;
			const animation = {
				get currentTime() { return currentTime; },
				effect: { getTiming: () => ({ duration: 10000 }) },
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
			const expectedKey = (sequence: any[], raw: number): string => {
				const phase = ((raw % 10000) + 10000) % 10000;
				let frame = sequence[sequence.length - 1];
				for (let i = sequence.length - 1; i >= 0; i--) {
					if (phase >= sequence[i].pct * 100) { frame = sequence[i]; break; }
				}
				return `${frame.gaze}-${frame.blink}`;
			};
			const failures: string[] = [];
			for (const kind of ["busy", "idle"] as const) {
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
					const expected = references.get(expectedKey(sequence, sample));
					if (hash(canvas) !== expected) failures.push(`${kind}@${sample}`);
				}
				stop();
			}
			(window as any).setTimeout = originalSetTimeout;
			(window as any).clearTimeout = originalClearTimeout;
			return { failures };
		});
		expect(result.failures).toEqual([]);
	});

	test("uses exact bounded callback budgets and no scheduler rAF", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			let currentTime: number | null = 0;
			const animation = { get currentTime() { return currentTime; }, effect: { getTiming: () => ({ duration: 10000 }) } };
			(canvas as any).getAnimations = () => [animation];
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let nextId = 0;
			let rafRequests = 0;
			const nativeRaf = window.requestAnimationFrame;
			(window as any).requestAnimationFrame = () => { rafRequests++; return 1; };
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++nextId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);
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
			(window as any).requestAnimationFrame = nativeRaf;
			return { busy, idle, rafRequests };
		});
		expect(result).toEqual({ busy: 30, idle: 22, rafRequests: 0 });
	});

	test("sleep is terminal; visibility, replacement, stale callbacks, and cleanup are event-driven", async ({ page }) => {
		await openFixture(page);
		const result = await page.evaluate(() => {
			const api = (window as any).__canvasEyeAnim;
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			let hidden = false;
			Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
			let currentTime: number | null = 3400;
			let animation: any = { get currentTime() { return currentTime; }, effect: { getTiming: () => ({ duration: 10000 }) } };
			let getAnimationsCalls = 0;
			(canvas as any).getAnimations = () => { getAnimationsCalls++; return [animation]; };
			const timers = new Map<number, { callback: () => void; delay: number }>();
			let nextId = 0;
			(window as any).setTimeout = (callback: () => void, delay: number) => {
				const id = ++nextId;
				timers.set(id, { callback, delay });
				return id;
			};
			(window as any).clearTimeout = (id: number) => timers.delete(id);

			const sleepStop = api.start(canvas, 10000, "sleep");
			const sleep = { timers: timers.size, getAnimationsCalls };
			sleepStop();

			hidden = true;
			const stop = api.start(canvas, 10000, "busy");
			const hiddenTimers = timers.size;
			hidden = false;
			document.dispatchEvent(new Event("visibilitychange"));
			const visibleTimers = timers.size;
			const [staleId, staleTimer] = [...timers.entries()][0];
			currentTime = 3500;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			staleTimer.callback();
			const staleInert = timers.size === 1 && !timers.has(staleId);

			currentTime = null;
			canvas.dispatchEvent(new AnimationEvent("animationcancel"));
			const cancelledTimers = timers.size;
			let replacementTime = 6000;
			animation = { get currentTime() { return replacementTime; }, effect: { getTiming: () => ({ duration: 10000 }) } };
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const replacementTimers = timers.size;
			const queued = [...timers.values()][0]?.callback;
			stop();
			queued?.();
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			document.dispatchEvent(new Event("visibilitychange"));
			return {
				sleep,
				hiddenTimers,
				visibleTimers,
				staleInert,
				cancelledTimers,
				replacementTimers,
				afterCleanup: timers.size,
			};
		});
		expect(result).toEqual({
			sleep: { timers: 0, getAnimationsCalls: 0 },
			hiddenTimers: 0,
			visibleTimers: 1,
			staleInert: true,
			cancelledTimers: 0,
			replacementTimers: 1,
			afterCleanup: 0,
		});
	});

	test("keeps real CSS body motion running while pixels change only at eye boundaries", async ({ page }) => {
		await openFixture(page);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send("Performance.enable");
		const before = await cdp.send("Performance.getMetrics");
		const result = await page.evaluate(async () => {
			const canvas = document.getElementById("sprite") as HTMLCanvasElement;
			const stop = (window as any).__canvasEyeAnim.start(canvas, 10000, "busy");
			const animation = canvas.getAnimations().find(a => a.effect?.getTiming().duration === 10000)!;
			const hash = () => {
				const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
				let value = 0;
				for (let i = 0; i < data.length; i += 29) value = Math.imul(value ^ data[i], 31);
				return value >>> 0;
			};
			animation.currentTime = 100;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const transform1 = getComputedStyle(canvas).transform;
			const pixels1 = hash();
			await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
			const transform2 = getComputedStyle(canvas).transform;
			const pixels2 = hash();
			animation.currentTime = 1590;
			canvas.dispatchEvent(new AnimationEvent("animationstart"));
			const beforeBoundary = hash();
			await new Promise(resolve => setTimeout(resolve, 40));
			const afterBoundary = hash();
			const playState = animation.playState;
			stop();
			return { transform1, transform2, pixels1, pixels2, beforeBoundary, afterBoundary, playState };
		});
		const after = await cdp.send("Performance.getMetrics");
		const task = (metrics: any) => metrics.metrics.find((m: any) => m.name === "TaskDuration")?.value ?? 0;
		expect(result.playState).toBe("running");
		expect(result.transform2).not.toBe(result.transform1);
		expect(result.pixels2).toBe(result.pixels1);
		expect(result.afterBoundary).not.toBe(result.beforeBoundary);
		expect(task(after) - task(before)).toBeGreaterThanOrEqual(0);
	});
});
