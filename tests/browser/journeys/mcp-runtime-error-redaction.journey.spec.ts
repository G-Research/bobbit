import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	apiFetch,
	createSession,
	deleteSession,
	expect,
	navigateToHash,
	openApp,
	registerProject,
	test,
} from "../../support/helpers/browser/journeys/journey-fixture.js";

test.use({ enableMcp: true, gatewayStateGroup: "mcp-runtime-error-redaction" });
test.describe.configure({ mode: "serial" });

test("MCP transport failures stay actionable without rendering configured secrets", async ({ page, gateway }) => {
	test.setTimeout(90_000);
	const runRoot = process.env.BOBBIT_E2E_TMP_ROOT;
	if (!runRoot) throw new Error("BOBBIT_E2E_TMP_ROOT must identify the browser run root");
	const root = mkdtempSync(join(runRoot, "mcp-runtime-redaction-"));
	const secrets = {
		body: "browser-response-body-secret-sentinel",
		rpc: "browser-json-rpc-secret-sentinel",
	};
	const remote = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const mode = new URL(req.url ?? "/", "http://fixture").searchParams.get("mode");
			if (mode === "body") {
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
	const names = {
		body: "runtime-body-redaction-browser",
		rpc: "runtime-rpc-redaction-browser",
	};
	writeFileSync(join(root, ".mcp.json"), JSON.stringify({
		mcpServers: {
			[names.body]: {
				url: `http://127.0.0.1:${address.port}/mcp?mode=body`,
				headers: { Authorization: `Bearer ${secrets.body}` },
			},
			[names.rpc]: {
				url: `http://127.0.0.1:${address.port}/mcp?mode=rpc`,
				headers: { Authorization: `Bearer ${secrets.rpc}` },
			},
		},
	}, null, 2), "utf8");

	let projectId = "";
	let sessionId = "";
	try {
		projectId = (await registerProject({
			name: `MCP runtime redaction ${Date.now()}`,
			rootPath: root,
			seedWorkflows: false,
		})).id;
		sessionId = await createSession({ projectId, cwd: root });
		const pairingCode = gateway.createMcpOperatorPairingCode().code;

		await openApp(page);
		await navigateToHash(page, `#/session/${sessionId}`);
		const banner = page.locator('[data-testid="mcp-approval-banner"]');
		await expect(banner).toBeVisible({ timeout: 20_000 });
		await banner.locator('[data-testid="mcp-review-servers"]').click();

		const pairing = page.locator('[data-testid="mcp-pairing-callout"]');
		await pairing.locator('[data-testid="mcp-pairing-code"]').fill(pairingCode);
		await pairing.locator('[data-testid="mcp-pair-browser"]').click();
		await expect(pairing.locator('[data-testid="mcp-pairing-notice"]')).toBeVisible();

		for (const [mode, name] of Object.entries(names) as Array<[keyof typeof names, string]>) {
			const row = page.locator(`[data-testid="mcp-server-row"][data-server-name="${name}"]`);
			await row.locator('[data-testid="mcp-approve-server"]').click();
			await expect(row.locator('[data-testid="mcp-approval-status"]')).toHaveText("Approved", { timeout: 20_000 });
			await expect(row.locator('[data-testid="mcp-server-status"]')).toHaveText("error");
			const healthError = row.locator('[data-testid="mcp-server-error"]');
			await expect(healthError).toContainText(mode === "body" ? "HTTP 401 for initialize" : "Initialize failed: initialize rejected");
			await expect(healthError).not.toContainText(secrets[mode]);
		}

		const statusResponse = await apiFetch(`/api/mcp-servers?projectId=${encodeURIComponent(projectId)}&ensure=true`);
		expect(statusResponse.status).toBe(200);
		const statusText = await statusResponse.text();
		expect(statusText).toContain("HTTP 401 for initialize");
		expect(statusText).toContain("Initialize failed: initialize rejected");
		expect(statusText).not.toContain(secrets.body);
		expect(statusText).not.toContain(secrets.rpc);
		expect(statusText).not.toContain("remote echoed");
		const rendered = await page.content();
		expect(rendered).not.toContain(secrets.body);
		expect(rendered).not.toContain(secrets.rpc);
	} finally {
		if (sessionId) await deleteSession(sessionId);
		if (projectId) await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" }).catch(() => undefined);
		await new Promise<void>((resolve) => remote.close(() => resolve()));
		rmSync(root, { recursive: true, force: true });
	}
});
