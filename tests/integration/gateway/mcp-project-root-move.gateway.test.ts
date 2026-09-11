import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { ProjectConfigStore } from "../../../src/server/agent/project-config-store.js";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	startRecordingMcpServer,
	writeProjectMcpConfig,
	type RecordingMcpServer,
} from "../../support/mcp-approval/gateway-mcp-fixtures.js";

type ServerStatus = {
	name: string;
	status: string;
	toolCount: number;
	approval: { state: string; fingerprint?: string };
	source: { sourceId: string; projectId?: string; file: string };
};

async function statuses(gateway: any, projectId: string): Promise<ServerStatus[]> {
	const response = await gateway.api(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
	expect(response.status).toBe(200);
	return response.json();
}

function named(all: ServerStatus[], serverName: string): ServerStatus {
	const status = all.find(entry => entry.name === serverName);
	expect(status, `missing MCP status for ${serverName}`).toBeDefined();
	return status!;
}

async function decide(gateway: any, projectId: string, status: ServerStatus): Promise<Response> {
	return gateway.api(`/api/mcp-servers/${encodeURIComponent(status.name)}/approval?projectId=${encodeURIComponent(projectId)}`, {
		method: "POST",
		body: JSON.stringify({
			decision: "approved",
			fingerprint: status.approval.fingerprint,
			sourceProjectId: status.source.projectId,
			sourceId: status.source.sourceId,
		}),
	});
}

function requestCount(server: RecordingMcpServer, method: string): number {
	return server.requests.filter(request => request.method === method).length;
}

test.describe("project root MCP lifecycle", () => {
	test("disconnects the old root before discovering the replacement root and its custom directories", async ({ gateway }) => {
		const fixtureRoot = path.join(gateway.bobbitDir, `.mcp-root-move-${randomUUID()}`);
		const rootA = path.join(fixtureRoot, "root-a");
		const rootB = path.join(fixtureRoot, "root-b");
		const customB = path.join(fixtureRoot, "root-b-custom-mcp");
		mkdirSync(rootA, { recursive: true });
		mkdirSync(rootB, { recursive: true });
		mkdirSync(customB, { recursive: true });
		const oldServer = await startRecordingMcpServer("old_probe");
		const replacementServer = await startRecordingMcpServer("replacement_probe");
		const customServer = await startRecordingMcpServer("custom_probe");
		let projectId: string | undefined;
		try {
			const serverName = `root-move-${randomUUID().slice(0, 8)}`;
			const customName = `root-move-custom-${randomUUID().slice(0, 8)}`;
			writeProjectMcpConfig(rootA, serverName, { url: oldServer.url });
			writeProjectMcpConfig(rootB, serverName, { url: replacementServer.url });
			writeProjectMcpConfig(customB, customName, { url: customServer.url });
			const rootBConfig = new ProjectConfigStore(path.join(rootB, ".bobbit", "config"));
			rootBConfig.setConfigDirectories([{ path: customB, types: ["mcp"] }]);

			const createdResponse = await gateway.api("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `mcp-root-move-${randomUUID().slice(0, 8)}`, rootPath: rootA, acceptCanonical: true }),
			});
			expect(createdResponse.status).toBe(201);
			projectId = (await createdResponse.json()).id;

			let current = named(await statuses(gateway, projectId!), serverName);
			expect(current.approval.state).toBe("pending");
			let response = await decide(gateway, projectId!, current);
			expect(response.status).toBe(200);
			current = (await response.json()).server;
			expect(current).toMatchObject({ status: "connected", toolCount: 1, approval: { state: "approved" } });
			expect(requestCount(oldServer, "initialize")).toBeGreaterThan(0);

			const sessionManager = gateway.sessionManager as any;
			const oldManager = sessionManager.getMcpManager({ projectId });
			const oldClient = oldManager.clients.get(serverName);
			const oldRequestCount = oldServer.requests.length;

			response = await gateway.api(`/api/projects/${encodeURIComponent(projectId!)}`, {
				method: "PUT",
				body: JSON.stringify({ rootPath: rootB }),
			});
			expect(response.status).toBe(200);
			expect(path.resolve((await response.json()).rootPath)).toBe(path.resolve(rootB));
			expect(oldClient.connected).toBe(false);
			expect(oldManager.getToolRouteSnapshots().some((route: any) => route.runtimeServerKey === serverName)).toBe(false);

			const movedStatuses = await statuses(gateway, projectId!);
			const moved = named(movedStatuses, serverName);
			expect(moved).toMatchObject({ status: "disconnected", toolCount: 0, approval: { state: "changed" } });
			expect(moved.source).toMatchObject({ projectId, file: ".mcp.json" });
			expect(named(movedStatuses, customName)).toMatchObject({
				status: "disconnected",
				toolCount: 0,
				approval: { state: "pending" },
				source: { projectId },
			});
			expect(replacementServer.requests).toHaveLength(0);
			expect(customServer.requests).toHaveLength(0);
			expect(oldServer.requests).toHaveLength(oldRequestCount);
			expect(path.resolve(sessionManager.getMcpManager({ projectId }).getDiscoveryScope().cwd)).toBe(path.resolve(rootB));

			response = await decide(gateway, projectId!, moved);
			expect(response.status).toBe(200);
			expect((await response.json()).server).toMatchObject({ status: "connected", approval: { state: "approved" } });
			expect(requestCount(replacementServer, "initialize")).toBeGreaterThan(0);
			expect(customServer.requests).toHaveLength(0);
		} finally {
			if (projectId) await gateway.api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
			await Promise.allSettled([oldServer.close(), replacementServer.close(), customServer.close()]);
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});
});
