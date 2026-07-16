import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
	deleteProposalFile,
	parseProposalFile,
	type ProposalType,
} from "../../src/server/proposals/proposal-files.js";
import type { TestComponent, TestWorkflowsBlock } from "../../tests/e2e/seed-workflows.js";

interface ProposalProjectFixture {
	id: string;
	rootPath: string;
}

const MINIMAL_COMPONENTS: readonly TestComponent[] = Object.freeze([
	Object.freeze({ name: "test", repo: "." }),
]);

/**
 * The proposal suites only need two workflow ids and one optional step. Keeping
 * this frozen snapshot small avoids repeatedly cloning the full E2E workflow
 * catalogue while preserving every workflow/option validation boundary.
 */
export const MINIMAL_PROPOSAL_WORKFLOWS: TestWorkflowsBlock = Object.freeze({
	general: Object.freeze({
		id: "general",
		name: "General",
		gates: Object.freeze([
			Object.freeze({ id: "implementation", name: "Implementation", verify: Object.freeze([]) }),
		]),
	}),
	feature: Object.freeze({
		id: "feature",
		name: "Feature",
		gates: Object.freeze([
			Object.freeze({
				id: "implementation",
				name: "Implementation",
				verify: Object.freeze([
					Object.freeze({
						name: "QA testing",
						type: "agent-qa",
						role: "qa-tester",
						optional: true,
						label: "Enable QA Testing",
						prompt: "QA test (skipped in tests).",
					}),
				]),
			}),
		]),
	}),
}) as TestWorkflowsBlock;

export const TARGET_ONLY_WORKFLOWS: TestWorkflowsBlock = Object.freeze({
	"target-only": Object.freeze({
		id: "target-only",
		name: "Target Only",
		description: "Workflow present only in the cross-project target.",
		gates: Object.freeze([
			Object.freeze({ id: "implementation", name: "Implementation", verify: Object.freeze([]) }),
		]),
	}),
}) as TestWorkflowsBlock;

const projectsByGateway = new WeakMap<object, Map<string, ProposalProjectFixture>>();
const sessionsByGateway = new WeakMap<object, Map<string, Promise<string>>>();

/**
 * Registers one immutable proposal-test project per gateway/key. Its root lives
 * under the gateway fixture, so gateway shutdown owns cleanup and context close.
 */
export function registerProposalProject(
	gateway: any,
	opts: {
		key: string;
		workflows?: TestWorkflowsBlock | Record<string, Record<string, unknown>>;
		components?: readonly TestComponent[];
	},
): ProposalProjectFixture {
	let projects = projectsByGateway.get(gateway);
	if (!projects) {
		projects = new Map();
		projectsByGateway.set(gateway, projects);
	}
	const existing = projects.get(opts.key);
	if (existing) return existing;

	const rootPath = path.join(gateway.bobbitDir, "proposal-projects", opts.key);
	fs.mkdirSync(rootPath, { recursive: true });
	fs.writeFileSync(path.join(rootPath, "README.md"), `# ${opts.key}\n`);

	const contexts = gateway.projectContextManager;
	const registry = contexts.getRegistry();
	const project = registry.register(`proposal-${opts.key}`, rootPath, { acceptCanonical: true });
	const context = contexts.getOrCreate(project.id);
	if (!context) throw new Error(`proposal fixture failed to open project ${project.id}`);
	context.projectConfigStore.setComponents(structuredClone(opts.components ?? MINIMAL_COMPONENTS));
	if (opts.workflows) context.projectConfigStore.setWorkflows(structuredClone(opts.workflows));

	const fixture = { id: project.id, rootPath: project.rootPath };
	projects.set(opts.key, fixture);
	return fixture;
}

/** One real session per immutable project, reused across proposal declarations. */
export function sharedProposalSession(
	gateway: any,
	projectId: string,
	create: () => Promise<string>,
): Promise<string> {
	let sessions = sessionsByGateway.get(gateway);
	if (!sessions) {
		sessions = new Map();
		sessionsByGateway.set(gateway, sessions);
	}
	let session = sessions.get(projectId);
	if (!session) {
		session = create();
		sessions.set(projectId, session);
	}
	return session;
}

export async function releaseSharedProposalSession(
	gateway: any,
	projectId: string,
	dispose: (sessionId: string) => Promise<void>,
): Promise<void> {
	const sessions = sessionsByGateway.get(gateway);
	const session = sessions?.get(projectId);
	if (!session) return;
	sessions!.delete(projectId);
	await dispose(await session);
}

function proposalStateDir(gateway: any): string {
	return path.join(gateway.bobbitDir, "state");
}

/** Read the persisted draft directly; transport is covered by the seed call. */
export async function proposalFields(
	gateway: any,
	sessionId: string,
	type: ProposalType,
): Promise<Record<string, unknown> | undefined> {
	const parsed = await parseProposalFile(proposalStateDir(gateway), sessionId, type);
	return parsed.ok ? parsed.value.fields : undefined;
}

/** Reset only the draft slots owned by the next declaration. */
export async function clearProposalDrafts(
	gateway: any,
	sessionId: string,
	...types: ProposalType[]
): Promise<void> {
	await Promise.all(types.map(type => deleteProposalFile(proposalStateDir(gateway), sessionId, type)));
}

/**
 * Scope live-session mutations without re-provisioning or reloading the session.
 * Seed routing reads this object directly, so restoring the captured fields is
 * both faster and more precise than creating an equivalent throwaway session.
 */
export async function withProposalSessionSnapshot<T>(
	gateway: any,
	sessionId: string,
	patch: Record<string, unknown>,
	run: () => Promise<T>,
): Promise<T> {
	const session = gateway.sessionManager.getSession(sessionId);
	if (!session) throw new Error(`proposal fixture session ${sessionId} is not live`);
	const snapshot = new Map<string, { present: boolean; value: unknown }>();
	for (const [key, value] of Object.entries(patch)) {
		snapshot.set(key, { present: Object.prototype.hasOwnProperty.call(session, key), value: session[key] });
		session[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const [key, entry] of snapshot) {
			if (entry.present) session[key] = entry.value;
			else delete session[key];
		}
	}
}

/** Scope a preference mutation through the in-memory store, with exact reset. */
export async function withProposalPreferenceSnapshot<T>(
	gateway: any,
	key: string,
	value: unknown,
	run: () => Promise<T>,
): Promise<T> {
	const store = gateway.sessionManager.preferencesStore;
	if (!store) throw new Error("proposal fixture could not resolve preferences store");
	const all = store.getAll();
	const present = Object.prototype.hasOwnProperty.call(all, key);
	const original = all[key];
	if (!present || original !== value) store.set(key, value);
	try {
		return await run();
	} finally {
		if (present) {
			if (store.get(key) !== original) store.set(key, original);
		} else if (store.get(key) !== undefined) {
			store.remove(key);
		}
	}
}

/** Seed the minimal parent record needed by proposal parent-injection policy. */
export function createProposalParent(
	gateway: any,
	project: ProposalProjectFixture,
): { id: string; record: any; remove(): void } {
	const context = gateway.projectContextManager.getOrCreate(project.id);
	if (!context) throw new Error(`proposal fixture missing project context ${project.id}`);
	const now = Date.now();
	const id = randomUUID();
	const record = {
		id,
		title: "Proposal parent",
		cwd: project.rootPath,
		state: "todo",
		spec: "Proposal parent fixture.",
		createdAt: now,
		updatedAt: now,
		projectId: project.id,
		team: true,
		setupStatus: "ready",
		rootGoalId: id,
		mergeTarget: "master",
		workflowId: "feature",
	};
	context.goalStore.put(record);
	return { id, record, remove: () => context.goalStore.remove(id) };
}
