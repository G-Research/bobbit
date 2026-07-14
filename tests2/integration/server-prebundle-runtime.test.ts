import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";
import { loadServerTestRuntime, serverRuntimeMode } from "../harness/server-runtime.js";

test("content-addressed server prebundle boots the real integration gateway", async () => {
	const runtime = await loadServerTestRuntime();
	expect(typeof runtime.server.createGateway).toBe("function");
	expect(typeof runtime.aigwManager.configureAigwRuntimeFlags).toBe("function");
	expect(typeof runtime.bobbitDir.setProjectRoot).toBe("function");
	if (process.env.BOBBIT_V2_SERVER_PREBUNDLE) expect(serverRuntimeMode()).toBe("bundle");

	const response = await apiFetch("/api/projects");
	expect(response.status).toBe(200);
	const body = await response.json();
	expect(Array.isArray(body.projects ?? body)).toBe(true);
});
