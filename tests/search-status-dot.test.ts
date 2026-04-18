// Unit tests for <search-status-dot>'s pure state machine + event bus.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	nextDotState,
	type DotState,
	type IndexEvent,
} from "../src/app/components/search-status-dot-state.js";

const idle: DotState = { kind: "idle" };

test("idle stays idle on incremental progress with tiny backlog", () => {
	const out = nextDotState(idle, {
		type: "index:progress",
		projectId: "p",
		phase: "incremental",
		total: 10,
		completed: 3,
		backlog: 7,
	} as IndexEvent);
	assert.equal(out.kind, "idle");
});

test("rebuild progress flips to indexing regardless of backlog", () => {
	const out = nextDotState(idle, {
		type: "index:progress",
		projectId: "p",
		phase: "rebuild",
		total: 100,
		completed: 10,
		backlog: 0,
	} as IndexEvent);
	assert.equal(out.kind, "indexing");
	if (out.kind === "indexing") {
		assert.equal(out.total, 100);
		assert.equal(out.completed, 10);
		assert.equal(out.phase, "rebuild");
	}
});

test("incremental progress with backlog > 50 flips to indexing", () => {
	const out = nextDotState(idle, {
		type: "index:progress",
		projectId: "p",
		phase: "incremental",
		total: 200,
		completed: 100,
		backlog: 75,
	} as IndexEvent);
	assert.equal(out.kind, "indexing");
});

test("incremental progress with backlog exactly 50 stays idle", () => {
	const out = nextDotState(idle, {
		type: "index:progress",
		projectId: "p",
		phase: "incremental",
		total: 200,
		completed: 100,
		backlog: 50,
	} as IndexEvent);
	assert.equal(out.kind, "idle");
});

test("index:complete returns to idle from indexing", () => {
	const indexing: DotState = { kind: "indexing", completed: 5, total: 10, backlog: 0, phase: "rebuild" };
	const out = nextDotState(indexing, {
		type: "index:complete",
		projectId: "p",
		phase: "rebuild",
		durationMs: 1234,
		rowsWritten: 10,
	} as IndexEvent);
	assert.equal(out.kind, "idle");
});

test("index:error produces error state with recoverable flag", () => {
	const out = nextDotState(idle, {
		type: "index:error",
		projectId: "p",
		message: "native binary missing",
		recoverable: false,
	} as IndexEvent);
	assert.equal(out.kind, "error");
	if (out.kind === "error") {
		assert.equal(out.message, "native binary missing");
		assert.equal(out.recoverable, false);
	}
});

test("error state persists through a small incremental progress event", () => {
	const err: DotState = { kind: "error", message: "x", recoverable: true };
	const out = nextDotState(err, {
		type: "index:progress",
		projectId: "p",
		phase: "incremental",
		total: 1,
		completed: 0,
		backlog: 0,
	} as IndexEvent);
	// Small incremental progress should not silently clear the error.
	assert.equal(out.kind, "error");
});

test("error state recovers on index:complete", () => {
	const err: DotState = { kind: "error", message: "x", recoverable: true };
	const out = nextDotState(err, {
		type: "index:complete",
		projectId: "p",
		phase: "rebuild",
		durationMs: 1,
		rowsWritten: 1,
	} as IndexEvent);
	assert.equal(out.kind, "idle");
});

test("sequence: idle \u2192 rebuild progress \u2192 more progress \u2192 complete \u2192 idle", () => {
	let s: DotState = idle;
	s = nextDotState(s, { type: "index:progress", projectId: "p", phase: "rebuild", total: 100, completed: 25, backlog: 0 });
	assert.equal(s.kind, "indexing");
	s = nextDotState(s, { type: "index:progress", projectId: "p", phase: "rebuild", total: 100, completed: 75, backlog: 0 });
	assert.equal(s.kind, "indexing");
	if (s.kind === "indexing") assert.equal(s.completed, 75);
	s = nextDotState(s, { type: "index:complete", projectId: "p", phase: "rebuild", durationMs: 5000, rowsWritten: 100 });
	assert.equal(s.kind, "idle");
});

test("sequence: error \u2192 retry kicks off rebuild progress", () => {
	let s: DotState = { kind: "error", message: "x", recoverable: true };
	s = nextDotState(s, { type: "index:progress", projectId: "p", phase: "rebuild", total: 10, completed: 0, backlog: 0 });
	assert.equal(s.kind, "indexing");
});
