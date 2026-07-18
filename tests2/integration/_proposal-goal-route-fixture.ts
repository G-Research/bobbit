import type { PersistedGoal } from "../../src/server/agent/goal-store.js";
import type { Workflow } from "../../src/server/agent/workflow-store.js";
import { prepareGoalProposalSeed } from "../../src/server/proposals/goal-proposal-seed.js";

export const VALIDATION_PROJECT_WORKFLOWS: readonly Workflow[] = [
	{
		id: "general",
		name: "General",
		description: "",
		createdAt: 0,
		updatedAt: 0,
		gates: [{
			id: "implementation",
			name: "Implementation",
			dependsOn: [],
			verify: [],
		}],
	},
	{
		id: "feature",
		name: "Feature",
		description: "",
		createdAt: 0,
		updatedAt: 0,
		gates: [{
			id: "implementation",
			name: "Implementation",
			dependsOn: [],
			verify: [{
				name: "QA testing",
				type: "agent-qa",
				role: "qa-tester",
				optional: true,
				optionalLabel: "Enable QA Testing",
				prompt: "QA test (skipped in tests).",
			}],
		}],
	},
];

interface ProposalSession {
	id: string;
	projectId: string;
	role?: string;
	teamGoalId?: string;
}

class InMemoryWorkflowStore {
	private readonly workflows = new Map<string, Workflow>();

	constructor(workflows: readonly Workflow[]) {
		for (const workflow of workflows) this.workflows.set(workflow.id, structuredClone(workflow));
	}

	getAll(): Workflow[] {
		return [...this.workflows.values()].map(workflow => structuredClone(workflow));
	}
}

interface InMemoryProjectContext {
	id: string;
	rootPath: string;
	workflowStore: InMemoryWorkflowStore;
	goalStore: Map<string, PersistedGoal>;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Route-shaped goal proposal seed fixture. Every mutable boundary consulted by
 * the production preparation core is owned by this instance: project contexts,
 * workflow stores, sessions, parents, preferences, and persisted drafts.
 */
export class GoalProposalRouteFixture {
	private readonly projects = new Map<string, InMemoryProjectContext>();
	private readonly sessions = new Map<string, ProposalSession>();
	private readonly preferences = new Map<string, unknown>();
	private readonly drafts = new Map<string, Record<string, unknown>>();
	private nextSession = 1;
	private nextParent = 1;

	registerProject(id: string, workflows: readonly Workflow[] = []): { id: string; rootPath: string } {
		const rootPath = `C:/suite/proposal-projects/${id}`;
		this.projects.set(id, {
			id,
			rootPath,
			workflowStore: new InMemoryWorkflowStore(workflows),
			goalStore: new Map(),
		});
		return { id, rootPath };
	}

	createSession(projectId: string): string {
		if (!this.projects.has(projectId)) throw new Error(`unknown fixture project: ${projectId}`);
		const id = `proposal-session-${this.nextSession++}`;
		this.sessions.set(id, { id, projectId });
		return id;
	}

	createParent(projectId: string, subgoalsAllowed?: boolean): PersistedGoal {
		const project = this.projects.get(projectId);
		if (!project) throw new Error(`unknown fixture project: ${projectId}`);
		const id = `proposal-parent-${this.nextParent++}`;
		const parent: PersistedGoal = {
			id,
			title: "Proposal parent",
			cwd: project.rootPath,
			state: "todo",
			spec: "Proposal parent fixture.",
			createdAt: 0,
			updatedAt: 0,
			projectId,
			team: true,
			setupStatus: "ready",
			rootGoalId: id,
			mergeTarget: "master",
			workflowId: "feature",
			...(subgoalsAllowed === undefined ? {} : { subgoalsAllowed }),
		};
		project.goalStore.set(id, parent);
		return parent;
	}

	setTeamLeadParent(sessionId: string, parentId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`unknown fixture session: ${sessionId}`);
		session.role = "team-lead";
		session.teamGoalId = parentId;
	}

	setPreference(key: string, value: unknown): void {
		this.preferences.set(key, value);
	}

	proposalFields(sessionId: string): Record<string, unknown> | undefined {
		const fields = this.drafts.get(sessionId);
		return fields ? structuredClone(fields) : undefined;
	}

	async fetch(requestPath: string, init: RequestInit = {}): Promise<Response> {
		const route = /^\/api\/sessions\/([^/]+)\/proposal\/goal\/seed$/.exec(requestPath);
		if (!route || (init.method ?? "GET").toUpperCase() !== "POST") {
			return json({ ok: false, code: "NOT_FOUND", message: "Route not found" }, 404);
		}
		const sessionId = decodeURIComponent(route[1]);
		const session = this.sessions.get(sessionId);
		if (!session) return json({ ok: false, code: "SESSION_NOT_FOUND", message: "Session not found" }, 404);

		const body = JSON.parse(String(init.body ?? "{}")) as { args?: unknown };
		if (!body.args || typeof body.args !== "object" || Array.isArray(body.args)) {
			return json({ ok: false, code: "INVALID_BODY", message: "args must be an object" }, 400);
		}
		const args = body.args as Record<string, unknown>;
		const explicitProjectId = typeof args.projectId === "string" && args.projectId.trim()
			? args.projectId.trim()
			: undefined;
		const targetProjectId = explicitProjectId ?? session.projectId;
		const target = this.projects.get(targetProjectId);
		if (!target) {
			return json({ ok: false, code: "UNKNOWN_PROJECT", message: `Unknown project: ${targetProjectId}` }, 422);
		}

		const prepared = prepareGoalProposalSeed({ ...args, projectId: targetProjectId }, {
			session,
			workflows: target.workflowStore.getAll(),
			getGoal: id => this.getGoal(id),
			getPreference: key => this.preferences.get(key),
		});
		if (!prepared.ok) return json(prepared.body, prepared.status);

		this.drafts.set(sessionId, structuredClone(prepared.args));
		return json({ ok: true }, prepared.status);
	}

	private getGoal(id: string): PersistedGoal | undefined {
		for (const project of this.projects.values()) {
			const goal = project.goalStore.get(id);
			if (goal) return goal;
		}
		return undefined;
	}
}
