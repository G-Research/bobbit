import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());
// PR #1005 review (Greptile P1, "Mode Stays Stale"): acceptProjectProposalFromPanel
// must recompute the registered-vs-provisional branch from the CURRENT
// fields.projectId at dispatch time, NOT from the stored proposal.mode. The accept
// sub-functions re-resolve the target from fields.projectId, which the user can edit
// in the panel after the slot was created; dispatching on the stale mode could skip
// the required promote step (a registered-mode slot re-targeted to a provisional
// project) or wrongly promote a registered target.
//
// These tests drive the real acceptProjectProposalFromPanel against a stubbed fetch
// and assert which endpoint chain runs:
//   - provisional branch → POST /api/projects/:id/promote
//   - registered branch  → PUT  /api/projects/:id (rename), never /promote
// We abort each flow at the config write (500) so the downstream fetchProjects /
// terminate / render side-effects never run — the branch decision is already
// observable by then.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { state } from "../../src/app/state.js";
import { acceptProjectProposalFromPanel } from "../../src/app/proposal-panels.js";

const PROP_SESSION = "coder-1";
let calls: Array<{ url: string; method: string }>;

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

beforeEach(() => {
	calls = [];
	state.projects = [
		{ id: "registered-src", provisional: false } as any,
		{ id: "provisional-target", provisional: true } as any,
		{ id: "registered-target", provisional: false } as any,
	];
	state.gatewaySessions.length = 0;
	state.gatewaySessions.push({ id: PROP_SESSION, projectId: "registered-src" } as any);
	state.activeProposals.project = undefined;

	vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
		const u = String(url);
		const method = init?.method ?? "GET";
		calls.push({ url: u, method });
		// Abort the accept flow at the config write so downstream side-effects
		// (fetchProjects / terminate / render) never run. The branch decision —
		// whether /promote was hit — is already observable at this point.
		if (/\/config$/.test(u) && method === "PUT") {
			return new Response(JSON.stringify({ error: "boom" }), { status: 500, headers: JSON_HEADERS });
		}
		return new Response("[]", { status: 200, headers: JSON_HEADERS });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	state.projects = [];
	state.gatewaySessions.length = 0;
	state.activeProposals.project = undefined;
	document.body.innerHTML = "";
});

function seedProposal(mode: "registered" | "provisional", projectId: string): void {
	state.activeProposals.project = {
		sessionId: PROP_SESSION,
		fields: { projectId, name: "Target", test_command: "echo hi" },
		streaming: false,
		rev: 1,
		mode,
	} as any;
}

function promoteCalls(): Array<{ url: string; method: string }> {
	return calls.filter(c => /\/promote$/.test(c.url) && c.method === "POST");
}

describe("acceptProjectProposalFromPanel — mode recomputed at dispatch", () => {
	it("FIX: STALE 'registered' mode targeting a PROVISIONAL project takes the promote branch", async () => {
		// Slot was created as 'registered', but fields.projectId now names a provisional
		// project (as if the user edited it after the slot was created).
		seedProposal("registered", "provisional-target");

		const ok = await acceptProjectProposalFromPanel();
		expect(ok).toBe(false); // aborted at the config write

		const promotes = promoteCalls();
		expect(promotes).toHaveLength(1);
		expect(promotes[0].url).toContain("/api/projects/provisional-target/promote");
	});

	it("STALE 'provisional' mode targeting a REGISTERED project takes the EDIT branch (no promote)", async () => {
		seedProposal("provisional", "registered-target");

		const ok = await acceptProjectProposalFromPanel();
		expect(ok).toBe(false); // aborted at the config write

		expect(promoteCalls()).toHaveLength(0);
		// Registered branch renames via PUT /api/projects/:id before the config write.
		const rename = calls.find(c => c.method === "PUT" && /\/api\/projects\/registered-target$/.test(c.url));
		expect(rename).toBeTruthy();
	});

	it("correct 'provisional' mode + provisional target still promotes", async () => {
		seedProposal("provisional", "provisional-target");

		await acceptProjectProposalFromPanel();

		const promotes = promoteCalls();
		expect(promotes).toHaveLength(1);
		expect(promotes[0].url).toContain("/api/projects/provisional-target/promote");
	});
});
