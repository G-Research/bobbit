import fs from "node:fs";
import path from "node:path";

/** Test-only market pack that creates an ordered successful/error provider trace. */
export const CONTEXT_TRACE_FIXTURE_PACK = "context-trace-browser-fixture";
export const RAW_CONTEXT_PAYLOAD = "CONTEXT_PAYLOAD_MUST_NOT_RENDER";
export const RAW_PROVIDER_DIAGNOSTIC = "RAW_PROVIDER_TOKEN_7f3c /private/context-trace-secret";
export const RAW_OUTCOME_SECRET = "RAW_OUTCOME_TOKEN_9e31 /private/extension-secret";
export const OLDER_TRACE_SENTINEL = "older-trace-sentinel";
export const NEWEST_TRACE_SENTINEL = "newest-trace-sentinel";

export function installContextTraceFixturePack(gateway: { bobbitDir: string }): string {
	const packDir = path.join(gateway.bobbitDir, "config", "market-packs", CONTEXT_TRACE_FIXTURE_PACK);
	fs.rmSync(packDir, { recursive: true, force: true });
	fs.mkdirSync(path.join(packDir, "providers"), { recursive: true });
	fs.mkdirSync(path.join(packDir, "lib"), { recursive: true });

	fs.writeFileSync(path.join(packDir, ".pack-meta.yaml"), [
		"sourceUrl: e2e",
		"sourceRef: local",
		"commit: test",
		`packName: ${CONTEXT_TRACE_FIXTURE_PACK}`,
		"version: 1.0.0",
		"installedAt: '2026-01-01T00:00:00.000Z'",
		"updatedAt: '2026-01-01T00:00:00.000Z'",
		"scope: server",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "pack.yaml"), [
		`name: ${CONTEXT_TRACE_FIXTURE_PACK}`,
		"description: Context trace browser fixture.",
		"version: 1.0.0",
		"schema: 2",
		"contents:",
		"  roles: []",
		"  tools: []",
		"  skills: []",
		"  entrypoints: []",
		"  providers: [alpha-provider, beta-provider]",
		"  hooks: []",
		"  mcp: []",
		"  pi-extensions: []",
		"  runtimes: []",
		"  workflows: []",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "providers", "alpha-provider.yaml"), [
		"id: alpha-provider",
		"kind: generic",
		"module: ../lib/alpha-provider.mjs",
		"hooks: [sessionSetup, beforePrompt]",
		"budget: { maxTokens: 512, timeoutMs: 1000 }",
		"defaultEnabled: true",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "providers", "beta-provider.yaml"), [
		"id: beta-provider",
		"kind: generic",
		"module: ../lib/beta-provider.mjs",
		"hooks: [sessionSetup, beforePrompt]",
		"budget: { maxTokens: 512, timeoutMs: 1000 }",
		"defaultEnabled: true",
	].join("\n") + "\n");
	fs.writeFileSync(path.join(packDir, "lib", "alpha-provider.mjs"), `
const block = {
	id: "alpha:context",
	title: "Alpha context",
	authority: "generic",
	priority: 1,
	reason: "fixture",
	content: ${JSON.stringify(RAW_CONTEXT_PAYLOAD)},
};
export default {
	sessionSetup() { return { blocks: [block] }; },
	beforePrompt() { return { blocks: [block] }; },
};
`);
	fs.writeFileSync(path.join(packDir, "lib", "beta-provider.mjs"), `
export default {
	sessionSetup() { throw new Error(${JSON.stringify(RAW_PROVIDER_DIAGNOSTIC)}); },
	beforePrompt() { throw new Error(${JSON.stringify(RAW_PROVIDER_DIAGNOSTIC)}); },
};
`);
	return packDir;
}

/**
 * Seed durable trace rows without introducing a test-only extension producer.
 * The UI must treat even old/proxied JSONL as untrusted and retain outcomes with
 * their event as the controller grows from 100 to 200 lifecycle records.
 */
export function appendContextTraceFixtureEntries(bobbitDir: string, sessionId: string): void {
	const traceDir = path.join(bobbitDir, "state", "session-context-trace");
	fs.mkdirSync(traceDir, { recursive: true });
	const traceFile = path.join(traceDir, `${sessionId}.jsonl`);
	const base = Date.now() + 1_000;
	const entries = Array.from({ length: 102 }, (_, index) => ({
		ts: base + index,
		hook: "beforePrompt",
		sessionId,
		providers: [{
			id: index === 0 ? OLDER_TRACE_SENTINEL : index === 101 ? NEWEST_TRACE_SENTINEL : "alpha-provider",
			ms: 3,
			blocks: 1,
			omitted: 0,
		}],
		...(index === 101 ? {
			outcomes: [
				{ kind: "decision", hookId: "grant-check", event: "beforePrompt", outcome: "denied", reason: "Grant required", value: RAW_OUTCOME_SECRET },
				{ kind: "advisory", hookId: "proposal", event: "beforePrompt", outcome: "dropped", reason: "Malformed result", value: RAW_OUTCOME_SECRET },
				{ kind: "audit", hookId: "selected-model", event: "beforePrompt", outcome: "applied", reason: RAW_OUTCOME_SECRET, value: "safe-model.2", ms: 7 },
				{ kind: "audit", hookId: "../../unsafe", event: "beforePrompt", outcome: "denied", reason: RAW_OUTCOME_SECRET },
			],
		} : {}),
	}));
	fs.appendFileSync(traceFile, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

export function removeContextTraceFixturePack(packDir: string | undefined): void {
	if (packDir) fs.rmSync(packDir, { recursive: true, force: true });
}
