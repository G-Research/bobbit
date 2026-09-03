import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { observeChildProfileLifecycle } from "../../../scripts/testing-v2/child-process-profile-preload.mjs";
import {
	buildE2EProfileManifest,
	categoryForE2EProfileStep,
	E2E_PROFILE_BUILD_CACHE_LABELS,
	refreshE2EProfileManifest,
} from "../../../scripts/testing-v2/e2e-profile-reporter.mjs";
import { validateE2EProfileManifest, validateE2ESampleManifest } from "../../../scripts/testing-v2/e2e-qualification-manifest.mjs";
import { measureSubtree } from "../../../scripts/testing-v2/measure-subtree.mjs";
import { e2eProfileIneligibilityReasons } from "../../../scripts/testing-v2/run-e2e-v2.mjs";

const roots: string[] = [];
const SHA = "a".repeat(40);
const BASELINE_SHA = "3a90cf55ab5226249529b00ecb874be4a79d5e54";
const emptyAttribution = () => ({
	fixtureSetup: 0,
	testBody: 1,
	teardown: 0,
	buildCache: 0,
	subprocess: 0,
	filesystem: 0,
	gateway: 0,
	browser: 0,
});

function tempRoot(name: string): string {
	const root = mkdtempSync(join(tmpdir(), `${name}-`));
	roots.push(root);
	return root;
}

function writeLines(path: string, records: object[]): void {
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function attempt() {
	return {
		file: "tests/e2e/api/example.api-e2e.spec.ts",
		title: "example",
		status: "passed",
		retry: 0,
		startedAt: 1_000,
		endedAt: 2_000,
		durationMs: 1_000,
		attributionMs: emptyAttribution(),
	};
}

function buildProfile(root: string) {
	return buildE2EProfileManifest({
		group: "B",
		sha: SHA,
		productBaselineSha: BASELINE_SHA,
		instrumentationSha: SHA,
		distState: "cold",
		platform: "linux",
		arch: "x64",
		node: process.version,
		status: "passed",
		tests: [attempt()],
		childProfileDir: join(root, "processes"),
		hookProfileDir: join(root, "hooks"),
		createdAt: "2026-01-01T00:00:00.000Z",
	});
}

function attachOwnedProcess(profile: any) {
	return {
		...profile,
		ownedProcess: {
			cpuMs: 10,
			peakProcesses: 1,
			processes: [{ pid: 10, creation: 900 }],
			accounting: { authority: "diagnostic", boundary: "e2e-runner-group-subtree", method: "pid-creation-subtree" },
		},
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("E2E profiling completeness", () => {
	it("rebuilds process and gateway overlays after every owner has flushed", () => {
		const root = tempRoot("e2e-profile-refresh");
		const childFile = join(root, "processes", "process-10.jsonl");
		const hookFile = join(root, "hooks", "gateway-api-10.jsonl");
		writeLines(childFile, [{ type: "start", id: "10:1", api: "spawn", executable: "git", ownerPid: 10, startedAt: 1_100 }]);
		writeLines(hookFile, [{ type: "gateway_api", id: "10:1", ownerPid: 10, startedAt: 1_300, endedAt: 1_325, durationMs: 25, method: "GET", path: "/api/health", status: 200 }]);

		const provisional = buildProfile(root);
		expect(provisional.processActivity.incomplete).toBe(1);
		expect(provisional.hookActivity.incompleteOwners).toBe(1);

		appendFileSync(childFile, `${JSON.stringify({ type: "end", id: "10:1", api: "spawn", executable: "git", ownerPid: 10, startedAt: 1_100, endedAt: 1_200, durationMs: 100, outcome: "ok" })}\n${JSON.stringify({ type: "owner_end", ownerPid: 10, endedAt: 2_100 })}\n`);
		appendFileSync(hookFile, `${JSON.stringify({ type: "owner_end", ownerPid: 10, endedAt: 2_100 })}\n`);
		const refreshed = attachOwnedProcess(refreshE2EProfileManifest(provisional, {
			childProfileDir: join(root, "processes"),
			hookProfileDir: join(root, "hooks"),
		}));

		expect(refreshed.processActivity).toMatchObject({ starts: 1, completed: 1, incomplete: 0 });
		expect(refreshed.hookActivity).toMatchObject({ records: 1, incompleteOwners: 0 });
		expect(refreshed.attributionMs.subprocess).toBe(100);
		expect(refreshed.attributionMs.gateway).toBe(25);
		expect(validateE2EProfileManifest(refreshed)).toEqual([]);
	});

	it("rejects unmatched children and absent or unflushed gateway hooks", () => {
		const root = tempRoot("e2e-profile-incomplete");
		writeLines(join(root, "processes", "process-10.jsonl"), [
			{ type: "start", id: "10:1", api: "spawn", executable: "git", ownerPid: 10, startedAt: 1_100 },
			{ type: "owner_end", ownerPid: 10, endedAt: 2_100 },
		]);
		const profile = attachOwnedProcess(buildProfile(root));
		const errors = validateE2EProfileManifest(profile);
		expect(errors).toContain("profile child-process telemetry must be complete");
		expect(errors).toContain("profile gateway hook records are required");
		expect(errors).toContain("profile gateway hook artifacts are required");
		expect(profile.processActivity.incompleteRecords[0]).toMatchObject({ id: "10:1", ownerEnded: true });
	});

	it("makes runner eligibility fail closed for flush gaps and missing B/C refs", () => {
		const complete = { group: "B", missing: false, retries: 0, failures: 0, incompleteProcesses: 0, incompleteHookOwners: 0, hookRecords: 4 };
		expect(e2eProfileIneligibilityReasons({
			profile: {}, only: null, retryCount: 0,
			profileRefs: [complete, { ...complete, group: "C" }],
			results: [{ code: 0 }],
		})).toEqual([]);
		expect(e2eProfileIneligibilityReasons({
			profile: {}, only: null, retryCount: 0,
			profileRefs: [{ ...complete, incompleteProcesses: 1 }, { ...complete, group: "C", incompleteHookOwners: 1, hookRecords: 0 }],
			results: [{ code: 0 }],
		})).toEqual(expect.arrayContaining([
			"child-process telemetry did not flush completely",
			"gateway hook telemetry did not flush completely",
			"gateway hook telemetry is missing",
		]));
	});

	it("pins explicit build/cache labels for both packaged npm phases", () => {
		expect(categoryForE2EProfileStep({ title: E2E_PROFILE_BUILD_CACHE_LABELS.packagedNpmLockOnly })).toBe("buildCache");
		expect(categoryForE2EProfileStep({ title: E2E_PROFILE_BUILD_CACHE_LABELS.packagedNpmCi })).toBe("buildCache");
		expect(categoryForE2EProfileStep({ title: "npm package-lock-only --offline" })).toBe("buildCache");
	});

	it("settles child intervals on exit or error without waiting for stdio close", () => {
		const exited = new EventEmitter();
		const exitResults: any[] = [];
		observeChildProfileLifecycle(exited, (result: any) => exitResults.push(result));
		exited.emit("exit", 0, null);
		exited.emit("close", 0, null);
		expect(exitResults).toEqual([{ outcome: "ok", exitCode: 0, signal: undefined }]);

		const errored = new EventEmitter();
		const errorResults: any[] = [];
		observeChildProfileLifecycle(errored, (result: any) => errorResults.push(result));
		const error = Object.assign(new Error("missing"), { code: "ENOENT" });
		errored.emit("error", error);
		errored.emit("close", -1, null);
		expect(errorResults).toEqual([{ outcome: "error", errorCode: "ENOENT" }]);

		const timedOut = new EventEmitter();
		const timeoutResults: any[] = [];
		observeChildProfileLifecycle(timedOut, (result: any) => timeoutResults.push(result), 100);
		timedOut.emit("exit", null, "SIGTERM");
		expect(timeoutResults).toEqual([{ outcome: "timeout", exitCode: null, signal: "SIGTERM" }]);
	});

	it("marks only outer PID+creation meters authoritative", async () => {
		const root = tempRoot("e2e-profile-meter");
		class FakeChild extends EventEmitter {
			pid = 42;
			stdout = { pipe: () => undefined };
			stderr = { pipe: () => undefined };
		}
		const child = new FakeChild();
		const reportPromise = measureSubtree({ label: "exact-command", outPath: join(root, "meter.json"), command: ["npm", "run", "test:e2e"] }, {
			platform: "linux",
			spawnProcess: () => {
				queueMicrotask(() => child.emit("close", 0, null));
				return child as any;
			},
			createSampler: () => ({
				stop: () => ({ cpuMs: 120, peakProcesses: 2, samples: 2, trackedProcesses: 1, processes: [{ pid: 42, ppid: 1, creation: 1_000, firstSeenAt: 1_000, lastSeenAt: 2_000, cpuMs: 120 }] }),
			}),
		});
		const report = await reportPromise;
		expect(report).toMatchObject({
			schema: 3,
			kind: "subtree-measurement",
			accounting: { authority: "outer", boundary: "spawned-command-subtree", method: "pid-creation-subtree", identity: "pid+creation" },
			rootProcess: { pid: 42, creation: 1_000 },
		});
		const sampleErrors = validateE2ESampleManifest({ schema: 2, kind: "e2e-qualification-sample", timing: {
			combined: { wallMs: 1, cpuMs: 1, peakProcesses: 1 },
			prewarm: { wallMs: 1, cpuMs: 1, peakProcesses: 1, rootProcess: { pid: 42, creation: 1_000 }, processes: report.processes, accounting: { authority: "diagnostic", boundary: "e2e-runner-process-subtree", method: "pid-creation-subtree" } },
			exactCommand: { ...report },
		} });
		expect(sampleErrors).toContain("sample.timing.prewarm must use authoritative outer accounting");
		expect(sampleErrors).toContain("sample.timing.combined must use authoritative outer accounting");
	});
});
