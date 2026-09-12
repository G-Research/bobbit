import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { vi } from "vitest";
import { test, expect } from "../../support/harnesses/integration/gateway/in-process-harness.js";
import {
	authenticatedMcpOperatorHeaders,
	apiFetch,
} from "../../support/harnesses/integration/gateway/e2e-setup.js";

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
	"gateway-command-private-key-sentinel",
	"gateway-command-access-key-sentinel",
	"gateway-command-signing-key-sentinel",
	"gateway-arg-private-key-sentinel",
	"gateway-arg-access-key-sentinel",
	"gateway-arg-signing-key-sentinel",
	"gateway-header-private-key-sentinel",
	"gateway-url-user-sentinel",
	"gateway-url-password-sentinel",
	"gateway-url-query-sentinel",
	"gateway-url-fragment-sentinel",
	"gateway-option-user-sentinel",
	"gateway-option-password-sentinel",
	"gateway-option-query-sentinel",
	"gateway-option-fragment-sentinel",
] as const;

const SERVER_NAME = "mcp-redaction-gateway";

type SafeConfig = { command: string; args: string[]; env: Record<string, string>; headers: Record<string, string> };
type ServerStatus = {
	name: string;
	status?: string;
	error?: string;
	approval: { state: string; fingerprint: string };
	source: { sourceId: string; projectId: string };
	config: SafeConfig;
	reviewConfig: SafeConfig;
	ownerContributions: Array<{ config: SafeConfig }>;
};

const WHOLE_URL = "https://gateway-url-user-sentinel:gateway-url-password-sentinel@mcp.example.test/bridge?access_token=gateway-url-query-sentinel#gateway-url-fragment-sentinel";
const OPTION_URL = "https://gateway-option-user-sentinel:gateway-option-password-sentinel@mcp.example.test/option?access_token=gateway-option-query-sentinel#gateway-option-fragment-sentinel";

function config(generation: string): Record<string, unknown> {
	return {
		command: `node relay.js --header "Authorization: Bearer gateway-command-auth-sentinel" -H'Cookie: gateway-command-cookie-sentinel' --proxy-header=gateway-command-proxy-sentinel --private-key gateway-command-private-key-sentinel --access_key=gateway-command-access-key-sentinel --signing-key gateway-command-signing-key-sentinel --monkey command-visible --label prefix-gateway-env-sentinel-suffix ${WHOLE_URL} --endpoint=${OPTION_URL}`,
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
			"--private-key", "gateway-arg-private-key-sentinel",
			"--access_key=gateway-arg-access-key-sentinel",
			"--signing-key", "gateway-arg-signing-key-sentinel",
			"X-Private-Key: gateway-header-private-key-sentinel",
			"--monkey", "argument-visible",
			WHOLE_URL,
			`--endpoint=${OPTION_URL}`,
			"--generation", generation,
		],
		env: { API_TOKEN: "gateway-env-sentinel" },
		headers: {
			"X-Configured-Secret": "gateway-configured-header-sentinel",
			"X-Private-Key": "gateway-header-private-key-sentinel",
		},
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
	const expectedCommand = "node relay.js --header \"Authorization: [redacted]\" -H'[redacted]' --proxy-header=[redacted] --private-key [redacted] --access_key=[redacted] --signing-key [redacted] --monkey command-visible --label prefix-[redacted]-suffix https://mcp.example.test/bridge --endpoint=https://mcp.example.test/option";
	const expectedArgs = [
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
		"--private-key", "[redacted]",
		"--access_key=[redacted]",
		"--signing-key", "[redacted]",
		"X-Private-Key: [redacted]",
		"--monkey", "argument-visible",
		"https://mcp.example.test/bridge",
		"--endpoint=https://mcp.example.test/option",
		"--generation", generation,
	];
	const expectedConfig = {
		command: expectedCommand,
		args: expectedArgs,
		env: { API_TOKEN: "[redacted]" },
		headers: { "X-Configured-Secret": "[redacted]", "X-Private-Key": "[redacted]" },
	};
	expect(status).toBeDefined();
	expect(status!.config).toEqual(expect.objectContaining(expectedConfig));
	expect(status!.reviewConfig).toEqual(expect.objectContaining(expectedConfig));
	expect(status!.ownerContributions).not.toHaveLength(0);
	for (const contribution of status!.ownerContributions) {
		expect(contribution.config).toEqual(expect.objectContaining(expectedConfig));
	}
	return status!;
}

test.describe("MCP approval API CLI redaction", () => {
	test("approved HTTP response bodies and JSON-RPC errors cannot disclose configured secrets", async ({ gateway }) => {
		for (const failure of ["response-body", "json-rpc"] as const) {
			const serverName = `mcp-runtime-${failure}-${randomUUID()}`;
			const secret = `runtime-${failure}-secret-${randomUUID()}`;
			let receivedConfiguredHeader = false;
			const remote = createServer((req, res) => {
				const chunks: Buffer[] = [];
				req.on("data", (chunk: Buffer) => chunks.push(chunk));
				req.on("end", () => {
					receivedConfiguredHeader ||= req.headers.authorization === `Bearer ${secret}`;
					if (failure === "response-body") {
						res.writeHead(401, { "Content-Type": "text/plain" });
						res.end(`remote echoed ${req.headers.authorization}`);
						return;
					}
					const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number };
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						error: { code: -32000, message: `initialize rejected ${req.headers.authorization}` },
					}));
				});
			});
			await new Promise<void>((resolve, reject) => {
				remote.once("error", reject);
				remote.listen(0, "127.0.0.1", resolve);
			});
			const address = remote.address();
			if (!address || typeof address === "string") throw new Error("HTTP MCP fixture did not bind a TCP port");

			const root = path.join(gateway.bobbitDir, `.mcp-runtime-redaction-${randomUUID()}`);
			mkdirSync(root, { recursive: true });
			writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({
				mcpServers: {
					[serverName]: {
						url: `http://127.0.0.1:${address.port}/mcp`,
						headers: { Authorization: `Bearer ${secret}` },
					},
				},
			}), "utf8");
			let projectId = "";
			const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

			try {
				const create = await gateway.api("/api/projects", {
					method: "POST",
					body: JSON.stringify({ name: `MCP runtime redaction ${randomUUID()}`, rootPath: root, acceptCanonical: true }),
				});
				expect(create.status).toBe(201);
				projectId = ((await create.json()) as { id: string }).id;

				const pendingResponse = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
				expect(pendingResponse.status).toBe(200);
				const pending = ((await pendingResponse.json()) as ServerStatus[]).find((entry) => entry.name === serverName);
				expect(pending?.approval.state).toBe("pending");

				const approvalResponse = await apiFetch(`/api/mcp-servers/${encodeURIComponent(serverName)}/approval?projectId=${encodeURIComponent(projectId)}`, {
					method: "POST",
					headers: await authenticatedMcpOperatorHeaders(),
					body: JSON.stringify({
						decision: "approved",
						fingerprint: pending!.approval.fingerprint,
						sourceProjectId: pending!.source.projectId,
						sourceId: pending!.source.sourceId,
					}),
				});
				expect(approvalResponse.status).toBe(200);
				const approvalBody = await approvalResponse.json();
				const statusResponse = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
				expect(statusResponse.status).toBe(200);
				const statusBody = await statusResponse.json();
				const status = (statusBody as ServerStatus[]).find((entry) => entry.name === serverName);

				expect(receivedConfiguredHeader).toBe(true);
				expect(status).toMatchObject({ status: "error", approval: { state: "approved" } });
				expect(status?.error).toContain(failure === "response-body" ? "HTTP 401 for initialize" : "Initialize failed: initialize rejected");
				if (failure === "response-body") expect(JSON.stringify([approvalBody, statusBody, errorLog.mock.calls])).not.toContain("remote echoed");
				for (const surface of [approvalBody, statusBody, errorLog.mock.calls]) {
					expect(JSON.stringify(surface)).not.toContain(secret);
				}
			} finally {
				errorLog.mockRestore();
				if (projectId) await gateway.api(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
				await new Promise<void>((resolve) => remote.close(() => resolve()));
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

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
				headers: await authenticatedMcpOperatorHeaders(),
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
