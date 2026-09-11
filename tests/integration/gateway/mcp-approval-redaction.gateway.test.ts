import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import { apiFetch } from "../../support/harnesses/integration/gateway/e2e-setup.js";

const SENTINELS = [
	"gateway-command-auth-sentinel",
	"gateway-command-cookie-sentinel",
	"gateway-command-proxy-sentinel",
	"gateway-separated-header-sentinel",
	"gateway-equals-header-sentinel",
	"gateway-short-header-sentinel",
	"gateway-short-equals-header-sentinel",
	"gateway-attached-header-sentinel",
	"gateway-proxy-header-sentinel",
	"gateway-proxy-equals-header-sentinel",
	"gateway-authorization-sentinel",
	"gateway-proxy-authorization-sentinel",
	"gateway-cookie-sentinel",
	"gateway-env-sentinel",
	"gateway-configured-header-sentinel",
] as const;

const SERVER_NAME = "mcp-redaction-gateway";

type ServerStatus = {
	name: string;
	approval: { state: string; fingerprint: string };
	source: { sourceId: string; projectId: string };
	reviewConfig: { command: string; args: string[]; env: Record<string, string>; headers: Record<string, string> };
};

function config(generation: string): Record<string, unknown> {
	return {
		command: "node relay.js --header \"Authorization: Bearer gateway-command-auth-sentinel\" -H'Cookie: gateway-command-cookie-sentinel' --proxy-header=gateway-command-proxy-sentinel --label prefix-gateway-env-sentinel-suffix",
		args: [
			"--header", "Authorization: Bearer gateway-separated-header-sentinel",
			"--header=X-Api-Key: gateway-equals-header-sentinel",
			"-H", "Cookie: gateway-short-header-sentinel",
			"-H=Cookie: gateway-short-equals-header-sentinel",
			"-HProxy-Authorization: Basic gateway-attached-header-sentinel",
			"--proxy-header", "gateway-proxy-header-sentinel",
			"--proxy-header=Proxy-Authorization: Basic gateway-proxy-equals-header-sentinel",
			"Authorization: Bearer gateway-authorization-sentinel",
			"Proxy-Authorization: Basic gateway-proxy-authorization-sentinel",
			"Cookie: session=gateway-cookie-sentinel",
			"prefix-gateway-env-sentinel-suffix",
			"prefix-gateway-configured-header-sentinel-suffix",
			"--generation", generation,
		],
		env: { API_TOKEN: "gateway-env-sentinel" },
		headers: { "X-Configured-Secret": "gateway-configured-header-sentinel" },
	};
}

function writeConfig(root: string, generation: string): void {
	writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
		mcpServers: { [SERVER_NAME]: config(generation) },
	}, null, 2), "utf8");
}

function assertSafeDto(value: unknown, generation: string): ServerStatus {
	const serialized = JSON.stringify(value);
	for (const sentinel of SENTINELS) expect(serialized).not.toContain(sentinel);
	const statuses = Array.isArray(value) ? value : [(value as { server: unknown }).server];
	const status = statuses.find((entry: ServerStatus) => entry.name === SERVER_NAME) as ServerStatus | undefined;
	expect(status).toBeDefined();
	expect(status!.reviewConfig).toMatchObject({
		command: "node relay.js --header \"Authorization: [redacted]\" -H'[redacted]' --proxy-header=[redacted] --label prefix-[redacted]-suffix",
		env: { API_TOKEN: "[redacted]" },
		headers: { "X-Configured-Secret": "[redacted]" },
	});
	expect(status!.reviewConfig.args).toEqual([
		"--header", "Authorization: [redacted]",
		"--header=[redacted]",
		"-H", "Cookie: [redacted]",
		"-H=[redacted]",
		"-H[redacted]",
		"--proxy-header", "[redacted]",
		"--proxy-header=[redacted]",
		"Authorization: [redacted]",
		"Proxy-Authorization: [redacted]",
		"Cookie: [redacted]",
		"prefix-[redacted]-suffix",
		"prefix-[redacted]-suffix",
		"--generation", generation,
	]);
	return status!;
}

test.describe("MCP approval API CLI redaction", () => {
	test("status and stale-decision DTOs preserve review structure without exposing credentials", async ({ gateway }) => {
		const root = path.join(gateway.bobbitDir, `.mcp-redaction-${randomUUID()}`);
		mkdirSync(root, { recursive: true });
		writeConfig(root, "one");
		let projectId = "";

		try {
			const create = await gateway.api("/api/projects", {
				method: "POST",
				body: JSON.stringify({ name: `MCP redaction ${randomUUID()}`, rootPath: root, acceptCanonical: true }),
			});
			expect(create.status).toBe(201);
			projectId = ((await create.json()) as { id: string }).id;

			const getResponse = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
			expect(getResponse.status).toBe(200);
			const pending = assertSafeDto(await getResponse.json(), "one");
			expect(pending.approval.state).toBe("pending");

			writeConfig(root, "two");
			const staleResponse = await apiFetch(`/api/mcp-servers/${encodeURIComponent(SERVER_NAME)}/approval?projectId=${encodeURIComponent(projectId)}`, {
				method: "POST",
				body: JSON.stringify({
					decision: "approved",
					fingerprint: pending.approval.fingerprint,
					sourceProjectId: pending.source.projectId,
					sourceId: pending.source.sourceId,
				}),
			});
			expect(staleResponse.status).toBe(409);
			const staleBody = await staleResponse.json();
			expect(staleBody).toMatchObject({ code: "MCP_APPROVAL_STALE", server: { approval: { state: "pending" } } });
			assertSafeDto(staleBody, "two");
		} finally {
			if (projectId) await gateway.api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	});
});
