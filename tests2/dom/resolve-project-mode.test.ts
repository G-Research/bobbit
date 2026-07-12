import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// Focused unit coverage for src/app/session-manager.ts::resolveProjectMode.
//
// PR #1005 review (Greptile P1): a project proposal carrying an explicit
// `fields.projectId` that names an EXISTING project must derive its mode from
// THAT target, not the source session. Prior code returned "registered" only
// when the target was non-provisional and otherwise fell through to the source
// session — so a cross-project proposal from a REGISTERED source targeting a
// PROVISIONAL project wrongly resolved "registered" and skipped the promote,
// leaving the target provisional. The fix derives mode from the known target:
// provisional target → "provisional" (promote/provision), registered target →
// "registered" (EDIT). Only an unknown target falls through to the source
// session; an absent projectId keeps the new-project flow (source session mode).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { state } from "../../src/app/state.js";
import { resolveProjectMode } from "../../src/app/session-manager.js";

const SESSION_ID = "coder-1";

beforeEach(() => {
	state.projects = [
		{ id: "registered-src", provisional: false } as any,
		{ id: "provisional-src", provisional: true } as any,
		{ id: "registered-target", provisional: false } as any,
		{ id: "provisional-target", provisional: true } as any,
	];
	state.gatewaySessions.length = 0;
});

afterEach(() => {
	state.projects = [];
	state.gatewaySessions.length = 0;
});

function bindSession(projectId: string): void {
	state.gatewaySessions.push({ id: SESSION_ID, projectId } as any);
}

describe("resolveProjectMode — explicit target drives mode", () => {
	it("FIX: registered source targeting a PROVISIONAL project resolves 'provisional' (promote path)", () => {
		bindSession("registered-src");
		expect(
			resolveProjectMode(SESSION_ID, { projectId: "provisional-target" }),
		).toBe("provisional");
	});

	it("explicit REGISTERED target still resolves 'registered' (EDIT path)", () => {
		bindSession("registered-src");
		expect(
			resolveProjectMode(SESSION_ID, { projectId: "registered-target" }),
		).toBe("registered");
	});

	it("provisional source targeting a REGISTERED project resolves 'registered' (target wins)", () => {
		bindSession("provisional-src");
		expect(
			resolveProjectMode(SESSION_ID, { projectId: "registered-target" }),
		).toBe("registered");
	});
});

describe("resolveProjectMode — fallthrough to source session", () => {
	it("UNKNOWN explicit target falls through to a registered source session", () => {
		bindSession("registered-src");
		expect(
			resolveProjectMode(SESSION_ID, { projectId: "does-not-exist" }),
		).toBe("registered");
	});

	it("UNKNOWN explicit target falls through to a provisional source session", () => {
		bindSession("provisional-src");
		expect(
			resolveProjectMode(SESSION_ID, { projectId: "does-not-exist" }),
		).toBe("provisional");
	});

	it("ABSENT projectId uses the source session (registered → registered)", () => {
		bindSession("registered-src");
		expect(resolveProjectMode(SESSION_ID)).toBe("registered");
		expect(resolveProjectMode(SESSION_ID, {})).toBe("registered");
	});

	it("ABSENT projectId uses the source session (provisional → provisional)", () => {
		bindSession("provisional-src");
		expect(resolveProjectMode(SESSION_ID, { projectId: "   " })).toBe("provisional");
	});

	it("no matching source session resolves 'registered' (no project found)", () => {
		expect(resolveProjectMode(SESSION_ID, { projectId: "does-not-exist" })).toBe("registered");
	});
});
