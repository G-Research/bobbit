import type { TestComponent, TestWorkflowsBlock } from "../../tests/e2e/seed-workflows.js";

interface ProposalProjectFixture {
	id: string;
	rootPath: string;
}

/**
 * Registers a proposal-test project directly with the fork-local registry.
 * The production project-create route performs git/base-ref/worktree probes that
 * proposal validation does not exercise; bypassing those probes keeps this
 * fixture deterministic while still creating a real, isolated ProjectContext.
 */
export function registerProposalProject(
	gateway: any,
	opts: {
		name: string;
		rootPath: string;
		components: TestComponent[];
		workflows?: TestWorkflowsBlock | Record<string, Record<string, unknown>>;
	},
): ProposalProjectFixture {
	const contexts = gateway.projectContextManager;
	const registry = contexts.getRegistry();
	const project = registry.register(opts.name, opts.rootPath, { acceptCanonical: true });
	const context = contexts.getOrCreate(project.id);
	if (!context) throw new Error(`proposal fixture failed to open project ${project.id}`);
	context.projectConfigStore.setComponents(opts.components);
	if (opts.workflows) context.projectConfigStore.setWorkflows(opts.workflows);
	return { id: project.id, rootPath: project.rootPath };
}

/** Remove a fixture after its sessions/goals have been deleted. */
export async function removeProposalProject(gateway: any, projectId: string): Promise<void> {
	const contexts = gateway.projectContextManager;
	const registry = contexts.getRegistry();
	const context = [...contexts.all()].find((candidate: any) => candidate?.project?.id === projectId);
	if (context) await context.close();
	contexts.remove(projectId);
	if (registry.get(projectId)) registry.remove(projectId);
}
