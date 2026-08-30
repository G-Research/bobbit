import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";

test.describe("app info API", () => {
	test("reports the running Bobbit package version and build provenance", async () => {
		const resp = await apiFetch("/api/app-info");
		expect(resp.status).toBe(200);
		const info = await resp.json();
		const packageVersion = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf-8")).version;
		const expectedBuildType = existsSync(path.join(process.cwd(), ".git")) ? "source" : "installed";

		expect(info).toMatchObject({ version: packageVersion, buildType: expectedBuildType });
		if (expectedBuildType === "source") expect(info.commitSha).toMatch(/^[0-9a-f]{7}$/);
		else expect(info).not.toHaveProperty("commitSha");
	});
});
