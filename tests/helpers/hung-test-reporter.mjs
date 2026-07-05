/**
 * node:test custom reporter — hung-test heartbeat.
 *
 * Purpose: when the unit-phase node runner (scripts/run-unit.mjs) hangs, the
 * wrapper's runner-timeout previously killed node and replayed only the raw
 * output tail, which does NOT name the file/test that never finished. This
 * reporter maintains a live "which test files are still in flight" heartbeat on
 * disk so the wrapper can name the hung file(s) in its timeout diagnostics — the
 * backstop for the primary `--test-timeout` guard (which fails and names an
 * individual hung test/hook, but cannot cover a leaked/detached child that
 * survives per-test timeouts).
 *
 * It is ADDITIVE: run-unit.mjs pairs it with the normal `tap` reporter, so human
 * output is unchanged. This reporter yields nothing (its --test-reporter-destination
 * sink stays empty); the real signal is the JSON heartbeat written to the path in
 * BOBBIT_UNIT_NODE_HEARTBEAT_FILE. When that env var is absent the reporter is a
 * no-op passthrough, so it is harmless if wired up without a destination path.
 *
 * The reporter runs in node's main test-runner process (one instance), receiving
 * merged events from every isolated file subprocess, each tagged with `file`.
 */
import { writeFileSync } from "node:fs";

/** Normalize path separators so file/name comparisons work on Windows and POSIX. */
function norm(p) {
	return String(p || "").replace(/\\/g, "/");
}

function basename(p) {
	const n = norm(p);
	const idx = n.lastIndexOf("/");
	return idx >= 0 ? n.slice(idx + 1) : n;
}

/**
 * A file-level test event is the synthetic top-level test node:test creates for
 * each test file. Its `name` is the CLI path (e.g. "tests/foo.test.ts") while
 * `file` is the absolute path; both resolve to the same basename and the file
 * path ends with the (normalized) name.
 */
function isFileLevelEvent(file, name) {
	if (!file || !name) return false;
	const nf = norm(file);
	const nn = norm(name);
	return nf.endsWith(nn) || basename(nf) === basename(nn);
}

export default async function* hungTestReporter(source) {
	const heartbeatFile = process.env.BOBBIT_UNIT_NODE_HEARTBEAT_FILE;
	if (!heartbeatFile) {
		// No sink configured — stay a silent passthrough.
		for await (const _ of source) { /* ignore */ }
		return;
	}

	/** file (absolute) -> startedAt ms; files dequeued but not yet completed. */
	const activeFiles = new Map();
	/** "file::name" -> { file, name, startedAt }; best-effort per-test tracking. */
	const runningTests = new Map();
	let completedFiles = 0;
	let lastEventAt = Date.now();
	let dirty = false;
	let flushTimer;

	const flush = () => {
		dirty = false;
		try {
			writeFileSync(
				heartbeatFile,
				JSON.stringify({
					schemaVersion: 1,
					pid: process.pid,
					lastEventAt,
					completedFiles,
					activeFiles: [...activeFiles.entries()]
						.map(([file, startedAt]) => ({ file, startedAt }))
						.sort((a, b) => a.startedAt - b.startedAt),
					runningTests: [...runningTests.values()].sort((a, b) => a.startedAt - b.startedAt),
				}),
			);
		} catch {
			/* best effort — never let heartbeat IO break the test run */
		}
	};

	// Coalesce write storms (~3.4k tests × several events each) behind a short,
	// unref'd timer so the heartbeat never keeps the process alive on its own.
	const schedule = () => {
		dirty = true;
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = undefined;
			if (dirty) flush();
		}, 200);
		flushTimer.unref?.();
	};

	for await (const event of source) {
		const type = event?.type;
		const data = event?.data || {};
		const file = data.file || "";
		const name = data.name || "";
		lastEventAt = Date.now();

		if (file) {
			const fileLevel = isFileLevelEvent(file, name);
			if (type === "test:dequeue" && fileLevel) {
				if (!activeFiles.has(file)) activeFiles.set(file, Date.now());
			} else if (type === "test:complete" && fileLevel) {
				if (activeFiles.delete(file)) completedFiles += 1;
				for (const key of [...runningTests.keys()]) {
					if (key.startsWith(`${file}::`)) runningTests.delete(key);
				}
			} else if (type === "test:start" && name && !fileLevel) {
				runningTests.set(`${file}::${name}`, { file, name, startedAt: Date.now() });
			} else if ((type === "test:pass" || type === "test:fail") && name && !fileLevel) {
				runningTests.delete(`${file}::${name}`);
			}
		}
		schedule();
	}

	// Final synchronous flush after the event stream ends (all files finished).
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = undefined;
	}
	flush();
}
