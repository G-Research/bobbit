import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packRoot = path.join(root, "market-packs/hindsight");
const routeSource = path.join(packRoot, "src/memory-routes.ts");
const toolSource = path.join(packRoot, "src/tools.ts");
const toolDir = path.join(packRoot, "tools/hindsight");
const implemented = fs.existsSync(routeSource) && fs.existsSync(toolSource);

function source(file: string): string {
	return fs.readFileSync(file, "utf8");
}

/** These tests deliberately inspect pack-owned adapters rather than a private
 * Hindsight client. Route integration supplies the EP-6 resolver at runtime. */
describe.skipIf(!implemented)("Hindsight typed memory routes and tool adapters", () => {
	it("uses every exact live EP-6 capability and never accepts caller-selected scope", () => {
		const text = source(routeSource);
		for (const capability of [
			"service.manage", "memory.read", "memory.write", "memory.reflect", "memory.invalidate", "memory.read.all",
		]) assert.match(text, new RegExp(`['\"]${capability.replace(".", "\\.")}['\"]`));

		assert.match(text, /scopeContext/, "routes must derive scope from the authoritative host context");
		assert.match(text, /project/, "project scope must be applied by the adapter");
		assert.match(text, /goal/, "goal scope must be applied by the adapter when supplied by the host");
		assert.match(text, /grant|required|denied|forbidden/i, "a missing or revoked grant must fail closed");
		assert.doesNotMatch(text, /(?:body|request)\s*\.\s*(?:projectId|scopeContext)/i,
			"request bodies must not be allowed to forge a project or scope context");
	});

	it("declares the complete typed route surface with bounded unavailable behavior", () => {
		const text = source(routeSource);
		for (const route of [
			"runtime-status", "runtime-control", "runtime-logs", "migration-plan", "migration-execute",
			"browse", "detail", "recall", "retain", "reflect", "invalidate", "retain-outcome",
		]) assert.match(text, new RegExp(`['\"]${route}['\"]`), `missing ${route} route`);
		assert.match(text, /ServiceRuntimeStatus/, "status responses must use the generic runtime status wire");
		assert.match(text, /AbortSignal|signal|deadline/i, "down or unhealthy calls must have a cancellation/deadline path");
		assert.match(text, /unavailable|degraded|blocked/i, "unavailable services must return a discriminated result, not wait for recovery");
	});

	it("ships exactly five thin tool adapters that do not own a client or lifecycle", () => {
		const text = source(toolSource);
		const names = ["hindsight_recall", "hindsight_retain", "hindsight_reflect", "hindsight_invalidate", "hindsight_retain_outcome"];
		for (const name of names) {
			assert.match(text, new RegExp(name));
			assert.ok(fs.existsSync(path.join(toolDir, `${name}.yaml`)), `missing ${name} descriptor`);
		}
		assert.equal(fs.readdirSync(toolDir).filter(file => file.endsWith(".yaml")).sort().join(","), names.map(name => `${name}.yaml`).sort().join(","));
		assert.doesNotMatch(text, /from\s+["'][^"']*(?:hindsight-client|docker|secret-store|extension-settings-store)[^"']*["']/i,
			"tools must delegate to typed routes rather than constructing a client, runtime, or settings owner");
		assert.match(text, /route|adapter|dispatch/i, "tools must call the shared typed-route adapter");
	});
});
