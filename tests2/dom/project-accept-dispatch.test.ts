import { beforeAll as __syncBeforeAll } from "vitest";
import { syncCustomElements as __syncCE } from "./_setup/custom-elements.js";
__syncBeforeAll(() => __syncCE());

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PanelWorkspaceTab } from "../../src/app/panel-workspace.js";
import { state } from "../../src/app/state.js";
import {
	acceptProjectProposalFromPanel,
	proposalPanelContent,
	resetProjectProposalPanel,
} from "../../src/app/proposal-panels.js";

const PROP_SESSION = "proposal-session";
const JSON_HEADERS = { "Content-Type": "application/json" } as const;

type Call = {
	path: string;
	method: string;
	body: Record<string, unknown> | undefined;
};

let calls: Call[];
let registryProjects: any[];
let configFailuresRemaining: number;
let createdSequence: number;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function proposalTab(): PanelWorkspaceTab {
	return {
		id: `proposal:project:${PROP_SESSION}`,
		kind: "proposal",
		title: "Project Proposal",
		label: "Project",
		legacyTab: "project",
		source: { type: "proposal", proposalType: "project", sessionId: PROP_SESSION },
	};
}

function installFetchStub(): void {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
		const path = new URL(String(input), "http://localhost").pathname;
		const method = init.method ?? "GET";
		let body: Record<string, unknown> | undefined;
		if (typeof init.body === "string" && init.body) body = JSON.parse(init.body);
		calls.push({ path, method, body });

		if (path === "/api/projects" && method === "POST") {
			createdSequence += 1;
			const created = {
				id: `created-${createdSequence}`,
				name: body?.name,
				rootPath: body?.rootPath,
				provisional: false,
			};
			registryProjects.push(created);
			return jsonResponse(created, 201);
		}
		if (path === "/api/projects" && method === "GET") {
			return jsonResponse(registryProjects);
		}
		if (path === "/api/sessions" && method === "GET") {
			return jsonResponse({ sessions: [], generation: 1 });
		}
		if (path === "/api/goals" && method === "GET") {
			return jsonResponse({ goals: [], generation: 1 });
		}
		if (/\/api\/projects\/[^/]+\/config$/.test(path) && method === "PUT" && configFailuresRemaining > 0) {
			configFailuresRemaining -= 1;
			return jsonResponse({ error: "config failed", code: "CONFIG_FAILED" }, 500);
		}
		return jsonResponse({ ok: true });
	});
}

beforeEach(() => {
	calls = [];
	configFailuresRemaining = 0;
	createdSequence = 0;
	registryProjects = [
		{ id: "headquarters", name: "Headquarters", rootPath: "C:/hq", provisional: false },
		{ id: "registered-source", name: "Source", rootPath: "C:/source", provisional: false },
		{ id: "provisional-source", name: "Pending", rootPath: "C:/pending", provisional: true },
		{ id: "registered-target", name: "Existing", rootPath: "C:/existing", provisional: false },
		{ id: "provisional-target", name: "Pending target", rootPath: "C:/pending-target", provisional: true },
	];
	state.projects = [...registryProjects] as any;
	state.gatewaySessions.length = 0;
	state.activeProposals.project = undefined;
	state.assistantHasProposal = false;
	state.assistantType = null;
	state.sessionsGeneration = -1;
	state.goalsGeneration = -1;
	resetProjectProposalPanel();
	installFetchStub();
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	state.projects = [];
	state.gatewaySessions.length = 0;
	state.activeProposals.project = undefined;
	state.assistantHasProposal = false;
	state.assistantType = null;
	resetProjectProposalPanel();
	document.body.innerHTML = "";
});

function seedProposal(options: {
	sourceProjectId: string;
	fields?: Record<string, unknown>;
	mode?: "create" | "provisional" | "registered" | "invalid";
	assistantType?: string;
}): NonNullable<typeof state.activeProposals.project> {
	state.gatewaySessions.push({
		id: PROP_SESSION,
		projectId: options.sourceProjectId,
		assistantType: options.assistantType,
	} as any);
	const proposal = {
		sessionId: PROP_SESSION,
		fields: {
			name: "Target",
			root_path: "C:/new-project",
			test_command: "npm test",
			...options.fields,
		},
		streaming: false,
		rev: 1,
		mode: options.mode ?? "create",
		sourceProjectId: options.sourceProjectId,
	} as NonNullable<typeof state.activeProposals.project>;
	state.activeProposals.project = proposal;
	state.assistantHasProposal = true;
	return proposal;
}

function projectMutations(): Call[] {
	return calls.filter(call => call.path.startsWith("/api/projects") && call.method !== "GET");
}

function exactCalls(path: string, method: string): Call[] {
	return calls.filter(call => call.path === path && call.method === method);
}

function expectDirectCreateChain(sourceProjectId: string): void {
	const creates = exactCalls("/api/projects", "POST");
	expect(creates).toHaveLength(1);
	expect(creates[0]!.body).toEqual({ name: "Target", rootPath: "C:/new-project" });
	expect(exactCalls("/api/projects/created-1/config", "PUT")).toHaveLength(1);
	expect(projectMutations().some(call => call.path.startsWith(`/api/projects/${sourceProjectId}`))).toBe(false);
}

describe("acceptProjectProposalFromPanel target dispatch", () => {
	it("creates a distinct project for an ordinary registered source with no projectId", async () => {
		seedProposal({ sourceProjectId: "registered-source", mode: "registered" });

		expect(await acceptProjectProposalFromPanel()).toBe(true);

		expectDirectCreateChain("registered-source");
		expect(state.activeProposals.project).toBeUndefined();
		expect(state.gatewaySessions.some(session => session.id === PROP_SESSION)).toBe(true);
	});

	it("creates from Headquarters without attempting any protected Headquarters mutation", async () => {
		seedProposal({ sourceProjectId: "headquarters", mode: "registered" });

		expect(await acceptProjectProposalFromPanel()).toBe(true);

		expectDirectCreateChain("headquarters");
		expect(projectMutations().filter(call => call.path.startsWith("/api/projects/headquarters"))).toEqual([]);
		expect(state.activeProposals.project).toBeUndefined();
	});

	it("edits an explicit registered target and never dispatches create", async () => {
		seedProposal({
			sourceProjectId: "registered-source",
			fields: { projectId: "registered-target" },
			mode: "create",
		});

		expect(await acceptProjectProposalFromPanel()).toBe(true);

		expect(exactCalls("/api/projects", "POST")).toHaveLength(0);
		expect(exactCalls("/api/projects/registered-target", "PUT")).toHaveLength(1);
		expect(exactCalls("/api/projects/registered-target/config", "PUT")).toHaveLength(1);
		expect(projectMutations().some(call => call.path.includes("registered-source"))).toBe(false);
	});

	it("rejects an explicit unknown target with no request and retains the editable draft", async () => {
		const proposal = seedProposal({
			sourceProjectId: "registered-source",
			fields: { projectId: "missing-project" },
			mode: "registered",
		});

		expect(await acceptProjectProposalFromPanel()).toBe(false);

		expect(projectMutations()).toEqual([]);
		expect(state.activeProposals.project).toBe(proposal);
		expect(state.activeProposals.project?.fields).toEqual(proposal.fields);

		const host = document.createElement("div");
		document.body.append(host);
		render(proposalPanelContent(proposalTab(), () => null), host);
		const error = host.querySelector('[data-testid="project-proposal-accept-error"]');
		expect(error).not.toBeNull();
		expect(error!.textContent).toContain("Project proposal accept failed");
		expect(error!.textContent).toContain("missing-project");
		expect(error!.textContent).toMatch(/omit|without/i);
	});

	it("completes the provisional Add Project promotion flow for absent-id create intent", async () => {
		seedProposal({
			sourceProjectId: "provisional-source",
			assistantType: "project",
			mode: "create",
		});

		expect(await acceptProjectProposalFromPanel()).toBe(true);

		expect(exactCalls("/api/projects", "POST")).toHaveLength(0);
		expect(exactCalls("/api/projects/provisional-source/promote", "POST")).toHaveLength(1);
		expect(exactCalls("/api/projects/provisional-source/config", "PUT")).toHaveLength(1);
		expect(exactCalls(`/api/sessions/${PROP_SESSION}`, "DELETE")).toHaveLength(1);
		expect(exactCalls("/api/sessions", "GET")).not.toHaveLength(0);
		expect(exactCalls("/api/projects", "GET")).not.toHaveLength(0);
		expect(state.activeProposals.project).toBeUndefined();
		expect(state.gatewaySessions.some(session => session.id === PROP_SESSION)).toBe(false);
	});

	it("recomputes stale stored mode from current explicit provisional fields", async () => {
		configFailuresRemaining = 1;
		seedProposal({
			sourceProjectId: "registered-source",
			fields: { projectId: "provisional-target" },
			mode: "registered",
		});

		expect(await acceptProjectProposalFromPanel()).toBe(false);

		expect(exactCalls("/api/projects", "POST")).toHaveLength(0);
		expect(exactCalls("/api/projects/provisional-target/promote", "POST")).toHaveLength(1);
		expect(exactCalls("/api/projects/provisional-target/config", "PUT")).toHaveLength(1);
	});

	it("retries config from the partial-create checkpoint without registering twice", async () => {
		configFailuresRemaining = 1;
		const proposal = seedProposal({ sourceProjectId: "registered-source" });

		expect(await acceptProjectProposalFromPanel()).toBe(false);
		expect(state.activeProposals.project).toBe(proposal);
		expect(state.activeProposals.project?.createdProjectId).toBe("created-1");
		expect(exactCalls("/api/projects", "POST")).toHaveLength(1);
		expect(exactCalls("/api/projects/created-1/config", "PUT")).toHaveLength(1);

		expect(await acceptProjectProposalFromPanel()).toBe(true);
		expect(exactCalls("/api/projects", "POST")).toHaveLength(1);
		expect(exactCalls("/api/projects/created-1/config", "PUT")).toHaveLength(2);
		expect(state.activeProposals.project).toBeUndefined();
	});
});
