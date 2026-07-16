import { realCommandRunner as directlyImportedCommandRunner } from "../../src/server/server.js";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { loadServerTestRuntime, serverRuntimeMode } from "../harness/server-runtime.js";

test("content-addressed server prebundle boots the real integration gateway", async () => {
	const runtimePromise = loadServerTestRuntime();
	const runtime = await runtimePromise;
	expect(loadServerTestRuntime()).toBe(runtimePromise);
	expect(typeof runtime.server.createGateway).toBe("function");
	expect(typeof runtime.gatewayDeps.realCommandRunner.execFile).toBe("function");
	expect(runtime.gatewayDeps.realCommandRunner).toBe(runtime.server.realCommandRunner);
	expect(directlyImportedCommandRunner).toBe(runtime.server.realCommandRunner);
	expect(typeof runtime.aigwManager.configureAigwRuntimeFlags).toBe("function");
	expect(typeof runtime.bobbitDir.setProjectRoot).toBe("function");
	if (process.env.BOBBIT_V2_SERVER_PREBUNDLE) expect(serverRuntimeMode()).toBe("bundle");

	const response = await apiFetch("/api/projects");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(Array.isArray(body.projects ?? body)).toBe(true);
});
