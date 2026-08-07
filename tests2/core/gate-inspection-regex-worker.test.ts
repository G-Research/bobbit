import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";

import { gateStoreV2Root, selectGateTextStream } from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildGateVerificationInspectionSnapshot } from "../../src/server/gate-verification-snapshot.js";
import {
	createGateInspectionRegexMatcher,
	GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES,
	GATE_INSPECTION_REGEX_MAX_QUEUE,
	GATE_INSPECTION_REGEX_MAX_WORKERS,
	GateInspectionRegexError,
	type GateInspectionRegexMatcher,
} from "../../src/server/gate-inspection-regex-worker.js";

const heldMatchers: GateInspectionRegexMatcher[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.allSettled(heldMatchers.splice(0).map(matcher => matcher.dispose()));
	for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function heartbeat(intervalMs = 5): { stop(): number } {
	let expected = performance.now() + intervalMs;
	let maxLag = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxLag = Math.max(maxLag, now - expected);
		expected = now + intervalMs;
	}, intervalMs);
	return {
		stop(): number {
			clearInterval(timer);
			return maxLag;
		},
	};
}

async function* chunks(values: Array<string | Buffer>): AsyncGenerator<string | Buffer> {
	for (const value of values) yield value;
}

describe("gate inspection regex worker bounds", () => {
	it("caps process-wide workers, bounds the admission queue, and recovers every permit", async () => {
		for (let index = 0; index < GATE_INSPECTION_REGEX_MAX_WORKERS; index++) {
			heldMatchers.push(await createGateInspectionRegexMatcher(`active-${index}`));
		}

		const queued = Array.from({ length: GATE_INSPECTION_REGEX_MAX_QUEUE }, (_unused, index) =>
			createGateInspectionRegexMatcher(`queued-${index}`).then(matcher => {
				heldMatchers.push(matcher);
				return matcher;
			}),
		);
		await expect(createGateInspectionRegexMatcher("overflow")).rejects.toMatchObject({
			code: "GATE_INSPECT_REGEX_SATURATED",
			status: 429,
		});

		const active = heldMatchers.splice(0, GATE_INSPECTION_REGEX_MAX_WORKERS);
		await Promise.all(active.map(matcher => matcher.dispose()));
		await Promise.all(queued);
		await Promise.all(heldMatchers.splice(0).map(matcher => matcher.dispose()));

		const recovered = await createGateInspectionRegexMatcher("healthy");
		heldMatchers.push(recovered);
		await expect(recovered.test("healthy")).resolves.toBe(true);
	});

	it("matches long-line prefixes and markers split across source and rolling-window boundaries", async () => {
		const prefixLine = `PREFIX-MARKER ${"x".repeat(96 * 1024)}`;
		const prefix = await selectGateTextStream(chunks([prefixLine]), {
			mode: "grep",
			pattern: "PREFIX-MARKER",
			maxBytes: 4 * 1024,
		});
		expect(prefix.matchCount).toBe(1);
		expect(prefix.text.length).toBeLessThanOrEqual(4 * 1024 + 8);

		const left = `${"a".repeat(32 * 1024 - 4)}CHUNK`;
		const right = `-BOUNDARY${"b".repeat(80 * 1024)}\r\nnext line`;
		const boundary = await selectGateTextStream(chunks([
			Buffer.from(left.slice(0, -2)),
			Buffer.from(left.slice(-2)),
			Buffer.from(right.slice(0, 3)),
			Buffer.from(right.slice(3)),
		]), {
			mode: "grep",
			pattern: "CHUNK-BOUNDARY",
			maxBytes: 8 * 1024,
		});
		expect(boundary).toMatchObject({ matchCount: 1, shownMatches: 1, totalLines: 2 });
		expect(boundary.range).toEqual({ from: 1, to: 1 });

		const acrossLines = await selectGateTextStream(chunks(["must-not-CROSS\r", "\nLINE-boundary"]), {
			mode: "grep",
			pattern: "CROSSLINE",
		});
		expect(acrossLines).toMatchObject({ matchCount: 0, shownMatches: 0, totalLines: 2 });
	});

	it("matches a greedy alternative only after a real line start rolls out of the selector window", async () => {
		const greedyStart = "GREEDY-START";
		const marker = "ROLLING-BOUNDARY-MARKER";
		const payload = [
			"p".repeat(GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES + 257),
			greedyStart,
			"m".repeat(1_013),
			marker,
			// Roll the marker out before EOF so success must come from an intermediate
			// synthetic window rather than the final line-boundary evaluation.
			"s".repeat(GATE_INSPECTION_REGEX_MAX_CANDIDATE_BYTES + 263),
		].join("");
		const posted: Array<{ candidate: string; lineStart: boolean; lineEnd: boolean }> = [];
		const postMessage = Worker.prototype.postMessage;
		vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, value: any, ...transfer: any[]) {
			if (value?.type === "test" && typeof value.candidate === "string") {
				posted.push({
					candidate: value.candidate,
					lineStart: value.lineStart,
					lineEnd: value.lineEnd,
				});
			}
			return postMessage.call(this, value, ...transfer as []);
		});

		const greedy = await selectGateTextStream(chunks([payload]), {
			mode: "grep",
			pattern: `^NEVER-MATCH|${greedyStart}.*${marker}`,
			maxBytes: 4 * 1024,
		});
		expect(greedy).toMatchObject({ matchCount: 1, shownMatches: 1, totalLines: 1 });
		expect(posted.some(message =>
			message.candidate.includes(marker)
			&& message.lineStart === false
			&& message.lineEnd === false
		)).toBe(true);

		posted.length = 0;
		const anchored = await selectGateTextStream(chunks([payload]), {
			mode: "grep",
			pattern: `^${greedyStart}.*${marker}`,
			maxBytes: 4 * 1024,
		});
		expect(anchored).toMatchObject({ matchCount: 0, shownMatches: 0, totalLines: 1 });
		const markerWindows = posted.filter(message => message.candidate.includes(marker));
		expect(markerWindows.length).toBeGreaterThan(0);
		expect(markerWindows.every(message => message.lineStart === false)).toBe(true);
		expect(posted.at(-1)).toMatchObject({ lineStart: false, lineEnd: true });
		expect(posted.at(-1)?.candidate).not.toContain(marker);
	});

	it("matches greedy patterns after several rolling windows without inventing line anchors", async () => {
		const matcher = await createGateInspectionRegexMatcher(".*MARKER|MARKER.*SUFFIX");
		heldMatchers.push(matcher);
		await expect(matcher.test("prefix MARKER and MARKER suffix SUFFIX", {
			lineStart: false,
			lineEnd: false,
		})).resolves.toBe(true);

		// Every padding character is matched by ordinary JavaScript dot semantics.
		// Both payloads exceed multiple 32 KiB rolling byte windows, and the greedy
		// match itself straddles a supplied source boundary rather than hiding behind
		// a U+2028 character that dot cannot consume.
		const prefixChunks = [
			"界".repeat(8 * 1024),
			`MARKER${"y".repeat(40 * 1024)}`,
		];
		const prefixGreedy = await selectGateTextStream(chunks(prefixChunks), {
			mode: "grep",
			pattern: ".*MARKER",
			maxBytes: 4 * 1024,
		});
		expect(prefixGreedy).toMatchObject({ matchCount: 1, shownMatches: 1 });

		const suffixChunks = [
			`prefix MARKER${"界".repeat(8 * 1024)}`,
			`${"y".repeat(4 * 1024)}SUFFIX${"λ".repeat(40 * 1024)}`,
		];
		const suffixGreedy = await selectGateTextStream(chunks(suffixChunks), {
			mode: "grep",
			pattern: "MARKER.*SUFFIX",
			maxBytes: 4 * 1024,
		});
		expect(suffixGreedy).toMatchObject({ matchCount: 1, shownMatches: 1 });

		const middle = suffixChunks.join("");
		const falseStart = await selectGateTextStream(chunks([middle]), { mode: "grep", pattern: "^MARKER" });
		const falseEnd = await selectGateTextStream(chunks([middle]), { mode: "grep", pattern: "SUFFIX$" });
		expect(falseStart.matchCount).toBe(0);
		expect(falseEnd.matchCount).toBe(0);

		const realBoundaries = await selectGateTextStream(chunks(["MARKER body SUFFIX"]), {
			mode: "grep",
			pattern: "^MARKER.*SUFFIX$",
		});
		expect(realBoundaries).toMatchObject({ matchCount: 1, shownMatches: 1 });
	});

	it("shares one absolute deadline across multiple verification steps and sources", async () => {
		const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-gate-inspect-deadline-"));
		tempDirs.push(stateDir);
		const diagnosticsRoot = path.join(stateDir, "gate-diagnostics");
		const candidate = (source: string, index: number): string => `${source}-${index}: ordinary output`;
		const steps = Array.from({ length: 8 }, (_unused, index) => {
			const base = {
				name: `step-${index}`,
				type: "command" as const,
				status: "failed" as const,
				passed: false,
				duration_ms: 1,
			};
			if (index % 2 === 0) return { ...base, output: candidate("INLINE", index) };
			const baseDir = path.join(diagnosticsRoot, "goal", "gate", "signal", `step-${index}`);
			const stdoutPath = path.join(baseDir, "stdout.log");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.writeFileSync(stdoutPath, candidate("RETAINED", index), "utf8");
			return {
				...base,
				output: "",
				diagnostics: {
					type: "retained-command-diagnostics" as const,
					baseDir,
					stdout: { path: stdoutPath, bytes: fs.statSync(stdoutPath).size, lines: 1 },
					artifacts: [],
					createdAt: 1,
				},
			};
		});

		// Advance the wall-clock seam only after both source types and three distinct
		// steps have reached isolated workers. This proves later selectors reuse the
		// request's original deadline without depending on host CPU or worker startup
		// speed, which made the previous catastrophic-backtracking timing test flaky.
		const baselineNow = Date.now();
		const deadlineWindowMs = 60_000;
		let fakeNow = baselineNow;
		vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
		const postedCandidates: string[] = [];
		const postMessage = Worker.prototype.postMessage;
		vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (this: Worker, value: any, ...transfer: any[]) {
			if (value?.type === "test" && typeof value.candidate === "string") {
				postedCandidates.push(value.candidate);
				const stepCount = new Set(postedCandidates.map(candidate => candidate.match(/-(\d+):/)?.[1])).size;
				if (stepCount === 3) fakeNow = baselineNow + deadlineWindowMs + 1;
			}
			return postMessage.call(this, value, ...transfer as []);
		});

		let caught: unknown;
		try {
			await buildGateVerificationInspectionSnapshot({
				goalId: "goal",
				gateId: "gate",
				signalId: "signal",
				verification: { status: "failed", steps },
				selectionOptions: { mode: "grep", pattern: "NEVER-(?:INLINE|RETAINED)" },
				v2Root: gateStoreV2Root(stateDir),
				inspectionDeadlineAt: baselineNow + deadlineWindowMs,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(GateInspectionRegexError);
		expect(caught).toMatchObject({
			code: "GATE_INSPECT_REGEX_TIMEOUT",
			status: 408,
			message: expect.stringContaining("total wall timeout"),
		});
		expect(postedCandidates.some(value => value.startsWith("INLINE-"))).toBe(true);
		expect(postedCandidates.some(value => value.startsWith("RETAINED-"))).toBe(true);
		expect(new Set(postedCandidates.map(value => value.match(/-(\d+):/)?.[1])).size).toBe(3);

		const healthy = await selectGateTextStream(chunks(["follow-up healthy"]), {
			mode: "grep",
			pattern: "healthy$",
		});
		expect(healthy).toMatchObject({ matchCount: 1, shownMatches: 1 });
	});

	it("applies one aggregate deadline to stream reads without leaking capacity", async () => {
		async function* slowChunks(): AsyncGenerator<string> {
			yield "ordinary line\n";
			await new Promise(resolve => setTimeout(resolve, 500));
			yield "never reached\n";
		}
		const pulse = heartbeat();
		const startedAt = performance.now();
		let caught: unknown;
		try {
			await selectGateTextStream(slowChunks(), {
				mode: "grep",
				pattern: "never-present",
				deadlineAt: Date.now() + 200,
			});
		} catch (error) {
			caught = error;
		}
		const elapsed = performance.now() - startedAt;
		const maxLag = pulse.stop();
		expect(caught).toBeInstanceOf(GateInspectionRegexError);
		expect(caught).toMatchObject({ code: "GATE_INSPECT_REGEX_TIMEOUT", status: 408 });
		expect(elapsed).toBeLessThan(700);
		expect(maxLag).toBeLessThan(100);

		const healthy = await selectGateTextStream(chunks(["follow-up healthy"]), {
			mode: "grep",
			pattern: "healthy$",
		});
		expect(healthy).toMatchObject({ matchCount: 1, shownMatches: 1 });
	});
});
