import { describe, expect, it } from "vitest";
import { SessionManager } from "../../../../src/server/agent/session-manager.ts";

interface RuntimeState {
	clientConnected: boolean;
	routeRegistered: boolean;
	formerEndpointCalls: number;
}

function reloadResult(overrides: Record<string, unknown> = {}) {
	return {
		status: "ok" as const,
		connected: [],
		disconnected: [],
		unchanged: [],
		skippedErrored: [],
		failed: [],
		statuses: [],
		...overrides,
	};
}

describe("project Marketplace MCP cross-manager reload", () => {
	it("awaits every active manager teardown without creating an inactive project manager", async () => {
		const runtime: RuntimeState = {
			clientConnected: true,
			routeRegistered: true,
			formerEndpointCalls: 0,
		};
		const callFormerRoute = () => {
			if (!runtime.routeRegistered) throw new Error("MCP route is unavailable");
			runtime.formerEndpointCalls += 1;
		};
		callFormerRoute();

		let releaseProjectB!: () => void;
		const projectBReloadMayFinish = new Promise<void>((resolve) => { releaseProjectB = resolve; });
		const reloadOptions: Array<{ manager: string; options: unknown }> = [];
		const additionalSources = new Map<string, string[]>();
		let projectAStatuses: any[] = [{ name: "local-a", status: "connected" }];
		let projectBStatuses: any[] = [{
			name: "project-a-marketplace",
			status: "connected",
			source: { projectId: "project-a" },
		}];

		const projectAManager = {
			getScopeKey: () => "project:project-a",
			getDiscoveryScope: () => ({ projectId: "project-a", cwd: "/repos/a" }),
			getServerStatuses: () => projectAStatuses,
			setAdditionalProjects: (projects: Array<{ projectId: string }>) => {
				additionalSources.set("project-a", projects.map(project => project.projectId));
			},
			reloadDiscoveredServers: async (options: unknown) => {
				reloadOptions.push({ manager: "project-a", options });
				projectAStatuses = [{ name: "replacement-a", status: "connected" }];
				return reloadResult({ connected: ["replacement-a"], statuses: projectAStatuses });
			},
		};
		const projectBManager = {
			getScopeKey: () => "project:project-b",
			getDiscoveryScope: () => ({ projectId: "project-b", cwd: "/repos/b" }),
			getServerStatuses: () => projectBStatuses,
			setAdditionalProjects: (projects: Array<{ projectId: string }>) => {
				additionalSources.set("project-b", projects.map(project => project.projectId));
			},
			reloadDiscoveredServers: async (options: unknown) => {
				reloadOptions.push({ manager: "project-b", options });
				await projectBReloadMayFinish;
				runtime.routeRegistered = false;
				runtime.clientConnected = false;
				projectBStatuses = [];
				return reloadResult({ disconnected: ["project-a-marketplace"], statuses: projectBStatuses });
			},
		};

		const manager = Object.create(SessionManager.prototype) as any;
		manager.mcpManager = projectAManager;
		manager.scopedMcpManagers = new Map([["project:project-b", projectBManager]]);
		manager.suspendedMcpProjects = new Set();
		manager.projectContextManager = {
			all: () => [
				{ project: { id: "project-a", name: "A", rootPath: "/repos/a" }, projectConfigStore: {} },
				{ project: { id: "project-b", name: "B", rootPath: "/repos/b" }, projectConfigStore: {} },
				{ project: { id: "inactive-project", name: "Inactive", rootPath: "/repos/inactive" }, projectConfigStore: {} },
			],
		};
		manager.ensureMcpManager = () => {
			throw new Error("project Marketplace reload must not create an inactive manager");
		};
		let refreshCount = 0;
		manager.refreshExternalMcpToolRegistrations = () => {
			expect(runtime.clientConnected).toBe(false);
			expect(runtime.routeRegistered).toBe(false);
			refreshCount += 1;
		};
		const approvalEvents: string[][] = [];
		manager.publishMcpApprovalsChanged = (projectIds: string[]) => {
			expect(runtime.clientConnected).toBe(false);
			expect(runtime.routeRegistered).toBe(false);
			approvalEvents.push(projectIds);
		};

		let returned = false;
		const mutation = manager.reloadMcpAfterMarketplaceMutation("project", "project-a")
			.then((result: unknown) => {
				returned = true;
				return result;
			});
		await new Promise(resolve => setImmediate(resolve));
		expect(returned).toBe(false);
		expect(runtime.clientConnected).toBe(true);
		expect(runtime.routeRegistered).toBe(true);

		releaseProjectB();
		const result = await mutation;

		expect(result).toMatchObject({
			status: "ok",
			connected: ["replacement-a"],
			disconnected: ["project-a-marketplace"],
		});
		expect(additionalSources.get("project-a")).toEqual(["project-b", "inactive-project"]);
		expect(additionalSources.get("project-b")).toEqual(["project-a", "inactive-project"]);
		expect(reloadOptions).toEqual([
			{ manager: "project-a", options: { force: undefined, queueIfInFlight: true, timeoutMs: 0 } },
			{ manager: "project-b", options: { force: undefined, queueIfInFlight: true, timeoutMs: 0 } },
		]);
		expect(refreshCount).toBe(1);
		expect(approvalEvents).toHaveLength(1);
		expect(new Set(approvalEvents[0])).toEqual(new Set(["project-a", "project-b"]));

		expect(() => callFormerRoute()).toThrow("MCP route is unavailable");
		expect(runtime.formerEndpointCalls).toBe(1);
	});
});
