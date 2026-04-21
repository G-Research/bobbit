/**
 * Unit tests for the git-status retry-with-backoff core.
 *
 * Tests `runGitStatusRefresh` from `src/app/git-status-refresh.ts` in
 * isolation from the DOM / session-manager singletons, using a stub sleep
 * that resolves synchronously (so the 500/2000/5000 ms delays don't hang
 * the test runner).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runGitStatusRefresh, GIT_STATUS_BACKOFF_MS } from "../src/app/git-status-refresh.ts";
import type { GitStatusResult } from "../src/app/api.ts";

function stubSleep(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
	return Promise.resolve();
}

function okResult(branch = "main"): GitStatusResult {
	return {
		kind: "ok",
		data: {
			branch,
			primaryBranch: "master",
			isOnPrimary: false,
			summary: "",
			clean: true,
			hasUpstream: true,
			ahead: 0,
			behind: 0,
			aheadOfPrimary: 0,
			behindPrimary: 0,
			mergedIntoPrimary: false,
			unpushed: false,
			status: [],
		},
	};
}

describe("runGitStatusRefresh — tri-state", () => {
	it("stays 'unknown' while retrying, flips to 'yes' on success", async () => {
		let calls = 0;
		let state: "unknown" | "yes" | "no" = "unknown";
		let loadingCleared = false;
		const ctl = new AbortController();

		await runGitStatusRefresh(ctl.signal, {
			async fetch() {
				calls++;
				if (calls < 3) return { kind: "error", message: "boom" };
				return okResult("feature/foo");
			},
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => false,
			onOk: (data) => {
				// Tri-state must still be 'unknown' right before onOk — flipping to 'yes'
				// is the onOk handler's job (done by caller).
				assert.equal(state, "unknown");
				assert.equal((data as any).branch, "feature/foo");
				state = "yes";
			},
			onNotARepo: () => { state = "no"; },
			onFinally: () => { loadingCleared = true; },
		});

		assert.equal(calls, 3);
		assert.equal(state, "yes");
		assert.ok(loadingCleared);
	});

	it("flips to 'no' immediately on not-a-repo, no retries", async () => {
		let calls = 0;
		let state: "unknown" | "yes" | "no" = "unknown";
		const ctl = new AbortController();
		await runGitStatusRefresh(ctl.signal, {
			async fetch() { calls++; return { kind: "not-a-repo" }; },
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => false,
			onOk: () => { state = "yes"; },
			onNotARepo: () => { state = "no"; },
			onFinally: () => {},
		});
		assert.equal(calls, 1);
		assert.equal(state, "no");
	});

	it("stays 'unknown' after 4 failed attempts (all backoff slots)", async () => {
		let calls = 0;
		let state: "unknown" | "yes" | "no" = "unknown";
		const ctl = new AbortController();
		await runGitStatusRefresh(ctl.signal, {
			async fetch() { calls++; return { kind: "error", message: "nope" }; },
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => false,
			onOk: () => { state = "yes"; },
			onNotARepo: () => { state = "no"; },
			onFinally: () => {},
		});
		assert.equal(calls, GIT_STATUS_BACKOFF_MS.length, "four attempts fired");
		assert.equal(state, "unknown", "tri-state unchanged on terminal error");
	});

	it("aborts mid-retry when session switches away (isStale)", async () => {
		let calls = 0;
		let state: "unknown" | "yes" | "no" = "unknown";
		let active = true;
		const ctl = new AbortController();
		await runGitStatusRefresh(ctl.signal, {
			async fetch() {
				calls++;
				if (calls === 1) { active = false; return { kind: "error", message: "boom" }; }
				return okResult();
			},
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => !active,
			onOk: () => { state = "yes"; },
			onNotARepo: () => { state = "no"; },
			onFinally: () => {},
		});
		assert.equal(calls, 1, "no further fetches after isStale");
		assert.equal(state, "unknown");
	});

	it("external abort mid-loop halts retries", async () => {
		let calls = 0;
		const ctl = new AbortController();
		await runGitStatusRefresh(ctl.signal, {
			async fetch() {
				calls++;
				if (calls === 1) { ctl.abort(); return { kind: "error", message: "boom" }; }
				return okResult();
			},
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => false,
			onOk: () => {},
			onNotARepo: () => {},
			onFinally: () => {},
		});
		assert.equal(calls, 1);
	});

	it("calls onFinally exactly once even when aborted", async () => {
		let finallyCount = 0;
		const ctl = new AbortController();
		ctl.abort();
		await runGitStatusRefresh(ctl.signal, {
			async fetch() { return { kind: "error", message: "boom" }; },
			sleep: (_ms, signal) => stubSleep(signal),
			isStale: () => false,
			onOk: () => {},
			onNotARepo: () => {},
			onFinally: () => { finallyCount++; },
		});
		assert.equal(finallyCount, 1);
	});
});
