import { afterEach, describe, expect, it } from "vitest";

import { selectGateTextStream } from "../../src/server/agent/gate-store-v2-persistence.js";
import { buildGateVerificationInspectionSnapshot } from "../../src/server/gate-verification-snapshot.js";
import {
	createGateInspectionRegexMatcher,
	GATE_INSPECTION_REGEX_MAX_QUEUE,
	GATE_INSPECTION_REGEX_MAX_WORKERS,
	GateInspectionRegexError,
	type GateInspectionRegexMatcher,
} from "../../src/server/gate-inspection-regex-worker.js";

const heldMatchers: GateInspectionRegexMatcher[] = [];

afterEach(async () => {
	await Promise.allSettled(heldMatchers.splice(0).map(matcher => matcher.dispose()));
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

	it("matches greedy patterns after several rolling windows without inventing line anchors", async () => {
		const matcher = await createGateInspectionRegexMatcher(".*MARKER|MARKER.*SUFFIX");
		heldMatchers.push(matcher);
		await expect(matcher.test("prefix MARKER and MARKER suffix SUFFIX", {
			lineStart: false,
			lineEnd: false,
		})).resolves.toBe(true);

		// Unicode line separators keep ordinary non-matches linear while the one
		// logical payload line still crosses several selector byte windows.
		const middle = `${"\u2028".repeat(48 * 1024)}MARKER${"y".repeat(256)}SUFFIX${"\u2028".repeat(20 * 1024)}`;
		const prefixGreedy = await selectGateTextStream(chunks([middle]), {
			mode: "grep",
			pattern: ".*MARKER",
			maxBytes: 4 * 1024,
		});
		expect(prefixGreedy).toMatchObject({ matchCount: 1, shownMatches: 1 });

		const suffixGreedy = await selectGateTextStream(chunks([middle]), {
			mode: "grep",
			pattern: "MARKER.*SUFFIX",
			maxBytes: 4 * 1024,
		});
		expect(suffixGreedy).toMatchObject({ matchCount: 1, shownMatches: 1 });

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

	it("shares one absolute deadline across every verification step and source", async () => {
		const pathological = `${"a".repeat(64 * 1024 - 1)}!`;
		const verification = {
			status: "failed" as const,
			steps: Array.from({ length: 12 }, (_unused, index) => ({
				name: `step-${index}`,
				type: "command" as const,
				status: "failed" as const,
				passed: false,
				output: pathological,
				duration_ms: 1,
			})),
		};
		const startedAt = performance.now();
		await expect(buildGateVerificationInspectionSnapshot({
			goalId: "goal",
			gateId: "gate",
			signalId: "signal",
			verification,
			selectionOptions: { mode: "grep", pattern: "(a+)+$" },
			v2Root: "/unused",
			inspectionDeadlineAt: Date.now() + 350,
		})).rejects.toMatchObject({ code: "GATE_INSPECT_REGEX_TIMEOUT", status: 408 });
		expect(performance.now() - startedAt).toBeLessThan(800);
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
