// Declarative ownership for shipped inputs that are consumed through filesystem
// discovery rather than JavaScript/TypeScript imports. Graph construction turns
// each rule into ordinary dependency edges (owner/canary -> input), so selection
// and per-test cache hashing share exactly the same dependency model.

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const posix = (value) => String(value).replace(/\\/g, "/").replace(/^\.\//, "");
const frozen = (values) => Object.freeze(values);

/**
 * Stable, data-first shipped-input rules. Every owner is the production module
 * that discovers/loads the input; canaries directly validate the shipped bytes,
 * loader contract, prompt budget, or cascade behavior.
 */
export const IMPACT_RULES = Object.freeze([
	{
		id: "builtin-roles",
		matches: (path) => /^defaults\/roles\/.*\.ya?ml$/i.test(path),
		owners: frozen([
			"src/server/agent/assistant-registry.ts",
			"src/server/agent/builtin-config.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/config-cascade.ts",
		]),
		canaries: frozen([
			"tests2/core/comparative-design-prompts.test.ts",
			"tests2/core/default-role-policy.test.ts",
			"tests2/core/enforce-headless-qa.test.ts",
			"tests2/core/local-only-role-prompts.test.ts",
			"tests2/core/pr-walkthrough-role-tools-policy.test.ts",
			"tests2/core/prompt-conditionals.test.ts",
			"tests2/core/reviewer-cannot-team-delegate.test.ts",
			"tests2/core/reviewer-diff-scope-prompts.test.ts",
			"tests2/core/reviewer-read-session-policy.test.ts",
			"tests2/core/role-bobbit-tools-policy.test.ts",
			"tests2/core/role-children-tools-policy.test.ts",
			"tests2/core/role-gate-signal-policy.test.ts",
			"tests2/core/role-prompt.test.ts",
			"tests2/core/role-team-tools-policy.test.ts",
		]),
	},
	{
		id: "builtin-tools",
		matches: (path) => path === "defaults/tool-group-policies.yaml" || path.startsWith("defaults/tools/"),
		owners: frozen([
			"src/server/agent/builtin-config.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/tool-manager.ts",
			"src/server/agent/config-cascade.ts",
		]),
		canaries: frozen([
			"tests2/core/bobbit-tool-tiers.test.ts",
			"tests2/core/enforce-headless-qa.test.ts",
			"tests2/core/market-tool-runtime.test.ts",
			"tests2/core/marketplace-activation-tool-catalogue.test.ts",
			"tests2/core/pr-walkthrough-role-tools-policy.test.ts",
			"tests2/core/reviewer-cannot-team-delegate.test.ts",
			"tests2/core/reviewer-read-session-policy.test.ts",
			"tests2/core/role-bobbit-tools-policy.test.ts",
			"tests2/core/role-children-tools-policy.test.ts",
			"tests2/core/role-team-tools-policy.test.ts",
			"tests2/core/tool-description-budget.test.ts",
			"tests2/core/tool-docs-prompt.test.ts",
			"tests2/core/tool-policy-resolution.test.ts",
			"tests2/dom/grep-dash-pattern.test.ts",
		]),
	},
	{
		id: "shipped-skills",
		matches: (path) => path.startsWith("defaults/skills/") || path.startsWith(".claude/skills/"),
		owners: frozen([
			"src/server/skills/slash-skills.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/pack-list.ts",
		]),
		canaries: frozen([
			"tests2/core/pack-marketplace.test.ts",
			"tests2/core/skill-manifest.test.ts",
			"tests2/core/slash-skills-activation.test.ts",
			"tests2/core/system-prompt-skills-budget.test.ts",
			"tests2/core/validate-skill-discovery.test.ts",
		]),
	},
	{
		id: "prompt-and-authoring-inputs",
		matches: (path) => path === "AGENTS.md"
			|| path === "defaults/system-prompt.md"
			|| path === "defaults/workflow-authoring-guide.md"
			|| path.startsWith("defaults/docs/"),
		owners: frozen([
			"src/server/agent/system-prompt.ts",
			"src/server/agent/project-assistant.ts",
		]),
		canaries: frozen([
			"tests2/core/agents-md-budget.test.ts",
			"tests2/core/comparative-design-prompts.test.ts",
			"tests2/core/project-assistant-prompt.test.ts",
			"tests2/core/system-prompt-merged-branch.test.ts",
			"tests2/core/system-prompt-skills-budget.test.ts",
			"tests2/core/system-prompt.test.ts",
		]),
	},
	{
		id: "market-packs",
		matches: (path) => path.startsWith("market-packs/"),
		owners: frozen([
			"src/server/agent/builtin-packs.ts",
			"src/server/agent/pack-list.ts",
			"src/server/agent/pack-manifest.ts",
			"src/server/agent/pack-resolver.ts",
			"src/server/agent/pack-contributions.ts",
		]),
		canaries: frozen([
			"tests2/core/builtin-packs.test.ts",
			"tests2/core/extension-host-terminal.test.ts",
			"tests2/core/pack-contributions.test.ts",
			"tests2/core/pack-marketplace.test.ts",
			"tests2/core/pack-pi-extensions-loader.test.ts",
			"tests2/core/pack-providers-loader.test.ts",
			"tests2/core/pr-walkthrough-bundle-tool-metadata.test.ts",
			"tests2/core/pr-walkthrough-pack-boundary.test.ts",
			"tests2/core/pr-walkthrough-role-tools-policy.test.ts",
			"tests2/core/pr-walkthrough-tool-metadata.test.ts",
			"tests2/core/reviewer-diff-scope-prompts.test.ts",
			"tests2/core/reviewer-read-session-policy.test.ts",
			"tests2/core/tool-description-budget.test.ts",
		]),
	},
	{
		id: "workflow-templates",
		matches: (path) => /^workflows\/.*\.ya?ml$/i.test(path),
		owners: frozen([
			"src/server/agent/workflow-store.ts",
			"src/server/agent/workflow-validator.ts",
			"src/server/state-migration/seed-default-workflows.ts",
		]),
		canaries: frozen([
			"tests2/core/seed-default-workflows.test.ts",
			"tests2/core/workflow-store.test.ts",
			"tests2/core/workflow-validator.test.ts",
		]),
	},
	{
		id: "committed-config-cascade",
		matches: (path) => path.startsWith(".bobbit/config/"),
		owners: frozen([
			"src/server/agent/project-config-store.ts",
			"src/server/agent/config-cascade.ts",
			"src/server/agent/workflow-store.ts",
		]),
		canaries: frozen([
			"tests2/core/comparative-design-prompts.test.ts",
			"tests2/core/config-cascade.test.ts",
			"tests2/core/project-config-store-native-yaml.test.ts",
			"tests2/core/reviewer-read-session-policy.test.ts",
			"tests2/core/seed-default-workflows.test.ts",
		]),
	},
	{
		// Scripts and publication metadata do not alter the dependency/runtime
		// projection, but these tests read the manifest bytes directly.
		id: "package-metadata",
		matches: (path) => path === "package.json",
		owners: frozen([]),
		canaries: frozen([
			"tests2/core/aigw-headers.test.ts",
			"tests2/core/aigw-startup-refresh.test.ts",
			"tests2/core/aigw-user-agent.test.ts",
			"tests2/core/node-modules-ring-fence.test.ts",
			"tests2/core/package-files.test.ts",
			"tests2/core/pi-published-shrinkwrap-security.test.ts",
			"tests2/core/release-skill-preflight-order.test.ts",
			"tests2/core/support-packaging.test.ts",
			"tests2/core/unit-file-budget-reporter.test.ts",
			"tests2/core/unit-lanes-scheduling.test.ts",
			"tests2/integration/aigw-configure.test.ts",
			"tests2/integration/aigw-title-generator.test.ts",
			"tests2/integration/app-info-api.test.ts",
		]),
	},
]);

/** Families are independent from the rule matchers so inventory coverage can
 * detect a new qualifying file that no rule claims. */
export const SHIPPED_INPUT_FAMILIES = Object.freeze([
	{ id: "builtin-roles", qualifies: (path) => /^defaults\/roles\/.*\.ya?ml$/i.test(path) },
	{ id: "builtin-tools", qualifies: (path) => path === "defaults/tool-group-policies.yaml" || path.startsWith("defaults/tools/") },
	{ id: "shipped-skills", qualifies: (path) => path.startsWith("defaults/skills/") || path.startsWith(".claude/skills/") },
	{ id: "prompt-and-authoring-inputs", qualifies: (path) => path === "AGENTS.md" || path === "defaults/system-prompt.md" || path === "defaults/workflow-authoring-guide.md" || path.startsWith("defaults/docs/") },
	{ id: "market-packs", qualifies: (path) => path.startsWith("market-packs/") },
	{ id: "workflow-templates", qualifies: (path) => /^workflows\/.*\.ya?ml$/i.test(path) },
	{ id: "committed-config-cascade", qualifies: (path) => path.startsWith(".bobbit/config/") },
]);

const REPOSITORY_EXECUTABLE_RE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx)$/i;

/**
 * Computed repository scans cannot be recovered from a single readFile call.
 * Keep those broad-but-bounded ownership edges data-first and independently
 * enumerable so a newly added file under a declared root cannot be missed.
 */
export const REPOSITORY_SCAN_RULES = Object.freeze([
	{
		id: "client-source-guards",
		roots: frozen(["src/app", "src/ui"]),
		matches: (path) => (path.startsWith("src/app/") || path.startsWith("src/ui/"))
			&& REPOSITORY_EXECUTABLE_RE.test(path),
		consumers: frozen([
			"tests2/core/base-path-source-guards.test.ts",
			"tests2/core/clean-build-warnings-regression.test.ts",
		]),
	},
	{
		id: "server-typescript-source-guards",
		roots: frozen(["src/server"]),
		matches: (path) => path.startsWith("src/server/") && /\.tsx?$/i.test(path),
		consumers: frozen([
			"tests2/core/bobbit-archive-allowlist.test.ts",
			"tests2/core/gateway-nondelete-push-boundary.test.ts",
			"tests2/core/perm-frame-late-joiner-seq-gap.test.ts",
			"tests2/core/spawn-node-execpath-invariant.test.ts",
			"tests2/integration/extension-host-surface-token.test.ts",
		]),
	},
	{
		id: "async-background-cleanup-source-guard",
		roots: frozen(["src/server", "src/shared"]),
		matches: (path) => (path.startsWith("src/server/") || path.startsWith("src/shared/"))
			&& /\.ts$/i.test(path),
		consumers: frozen(["tests2/core/async-background-cleanup-static.test.ts"]),
	},
	{
		id: "metadata-retirement-source-guard",
		roots: frozen(["src"]),
		matches: (path) => path.startsWith("src/") && /\.ts$/i.test(path),
		consumers: frozen(["tests2/core/openai-model-additions-merge.test.ts"]),
	},
	{
		id: "search-worker-main-thread-boundary",
		roots: frozen(["src/server/search"]),
		matches: (path) => path.startsWith("src/server/search/") && /\.ts$/i.test(path),
		consumers: frozen(["tests2/core/session-connect-timeout-main-thread-repro.test.ts"]),
	},
	{
		id: "preview-cookie-server-source-guard",
		roots: frozen(["src/server"]),
		matches: (path) => path.startsWith("src/server/") && /\.[cm]?[jt]s$/i.test(path),
		consumers: frozen(["tests2/core/preview-cookie.test.ts"]),
	},
	{
		id: "worktree-setup-source-guard",
		roots: frozen(["src"]),
		matches: (path) => path.startsWith("src/") && /\.ts$/i.test(path),
		consumers: frozen(["tests2/core/worktree-setup-fallback.test.ts"]),
	},
	{
		id: "workflow-default-source-guard",
		roots: frozen(["src/server/agent", "src/app"]),
		matches: (path) => (path.startsWith("src/server/agent/") || path.startsWith("src/app/"))
			&& REPOSITORY_EXECUTABLE_RE.test(path),
		consumers: frozen(["tests2/core/no-general-workflow-default.test.ts"]),
	},
	{
		id: "unit-test-dist-import-guard",
		roots: frozen(["tests2/core"]),
		matches: (path) => path.startsWith("tests2/core/")
			&& /\.(?:test|spec)\.ts$/i.test(path)
			&& path !== "tests2/core/no-dist-imports.test.ts",
		consumers: frozen(["tests2/core/no-dist-imports.test.ts"]),
	},
	{
		id: "v2-test-inventory-guard",
		roots: frozen(["tests2/core", "tests2/dom", "tests2/integration"]),
		matches: (path) => /^tests2\/(?:core|dom|integration)\/.*\.(?:test|spec)\.ts$/i.test(path),
		consumers: frozen(["tests2/core/guard-v2.test.ts"]),
	},
	{
		id: "unit-runtime-closure-guard",
		roots: frozen(["tests2/harness"]),
		matches: (path) => path.startsWith("tests2/harness/") && REPOSITORY_EXECUTABLE_RE.test(path),
		consumers: frozen(["tests2/core/unit-lanes-scheduling.test.ts"]),
	},
	{
		id: "affected-runner-no-escape-guard",
		roots: frozen(["tests2/core"]),
		matches: (path) => (path.startsWith("tests2/core/affected-runner-")
			&& path.endsWith(".test.ts")
			&& path !== "tests2/core/affected-runner-no-escape.test.ts")
			|| (path.startsWith("tests2/core/helpers/affected-runner-")
				&& REPOSITORY_EXECUTABLE_RE.test(path)),
		consumers: frozen(["tests2/core/affected-runner-no-escape.test.ts"]),
	},
	{
		id: "pi-browser-fixture-guard",
		roots: frozen(["tests/fixtures"]),
		matches: (path) => path.startsWith("tests/fixtures/") && /\.tsx?$/i.test(path) && !path.endsWith(".d.ts"),
		consumers: frozen(["tests2/core/pi-ai-browser-boundary.test.ts"]),
	},
	{
		id: "pr-walkthrough-pack-boundary",
		roots: frozen(["market-packs/pr-walkthrough/src"]),
		matches: (path) => path.startsWith("market-packs/pr-walkthrough/src/")
			&& REPOSITORY_EXECUTABLE_RE.test(path),
		consumers: frozen(["tests2/core/pr-walkthrough-pack-boundary.test.ts"]),
	},
	{
		id: "hindsight-external-pack-fixture",
		roots: frozen(["market-packs/hindsight"]),
		matches: (path) => path.startsWith("market-packs/hindsight/"),
		consumers: frozen(["tests2/integration/hindsight-external.test.ts"]),
	},
	{
		id: "pr-walkthrough-proof-removal-guard",
		roots: frozen(["src", "defaults"]),
		matches: (path) => (path.startsWith("src/") || path.startsWith("defaults/"))
			&& /\.(?:ts|tsx|js|mjs|cjs|json|ya?ml)$/i.test(path),
		consumers: frozen(["tests2/core/pr-walkthrough-no-submit-proof.test.ts"]),
	},
	{
		id: "extension-capability-residual-guard",
		// The test also scans docs, but affected execution deliberately retains the
		// suite-wide docs skip contract. Executable/pack/test inputs remain modeled.
		roots: frozen(["src", "tests", "market-packs"]),
		matches: (path) => (path.startsWith("src/")
				|| path.startsWith("tests/")
				|| path.startsWith("market-packs/"))
			&& /\.(?:ts|tsx|js|mjs|cjs|json|md|ya?ml|txt|html|css)$/i.test(path)
			&& path !== "tests/extension-host-no-capability-sandbox-residual.test.ts",
		consumers: frozen(["tests2/core/extension-host-no-capability-sandbox-residual.test.ts"]),
	},
]);

/**
 * Exact repository reads hidden behind local helpers or data tables. Keep this
 * registry deliberately narrow: general computed scans belong above, while
 * statically evaluable readFile operands are discovered in graph.mjs.
 */
export const INDIRECT_REPOSITORY_READ_RULES = Object.freeze([
	{
		id: "reviewer-archive-metadata",
		consumer: "tests2/core/reviewer-archive-metadata.test.ts",
		inputs: frozen([
			"src/server/agent/session-manager.ts",
			"src/server/agent/session-setup.ts",
			"src/server/agent/verification-harness.ts",
		]),
	},
	{
		id: "error-modal-call-sites",
		consumer: "tests2/core/error-modal-call-sites.test.ts",
		inputs: frozen([
			"src/app/dialogs.ts",
			"src/app/proposal-panels.ts",
			"src/app/role-manager-page.ts",
			"src/app/session-manager.ts",
			"src/app/tool-manager-page.ts",
		]),
	},
	{
		id: "source-pin-merge-invariants",
		consumer: "tests2/core/source-pin-merge-invariants.test.ts",
		inputs: frozen([
			"src/app/api.ts",
			"src/app/proposal-panels.ts",
			"src/server/server.ts",
		]),
	},
	{
		id: "accessory-rendering-contracts",
		consumer: "tests2/core/headset-accessory.test.ts",
		inputs: frozen([
			"src/ui/app.css",
			"src/ui/bobbit-render.ts",
			"src/ui/components/StreamingMessageContainer.ts",
			"src/app/role-manager.css",
		]),
	},
	{
		id: "ponytail-rendering-contracts",
		consumer: "tests2/core/ponytail-accessory.test.ts",
		inputs: frozen([
			"src/ui/app.css",
			"src/ui/bobbit-render.ts",
			"src/ui/components/StreamingMessageContainer.ts",
			"src/app/role-manager.css",
		]),
	},
	{
		id: "nurse-cap-rendering-contracts",
		consumer: "tests2/core/nurse-cap-accessory.test.ts",
		inputs: frozen([
			"src/ui/app.css",
			"src/ui/bobbit-render.ts",
			"src/ui/components/StreamingMessageContainer.ts",
			"src/app/role-manager.css",
		]),
	},
	{
		id: "delegate-helper-policy-plumbing",
		consumer: "tests2/core/delegate-helper-policy-plumbing.test.ts",
		inputs: frozen([
			"src/server/agent/session-store.ts",
			"src/server/agent/session-setup.ts",
			"src/server/skills/git.ts",
		]),
	},
	{
		id: "base-path-preview-contract",
		consumer: "tests2/core/base-path-preview-contract.test.ts",
		inputs: frozen([
			"src/server/preview/mount.ts",
			"src/server/preview/artifacts.ts",
			"src/app/panel-workspace.ts",
			"src/app/side-panel-workspace.ts",
		]),
	},
	{
		id: "headless-qa-mcp-config",
		consumer: "tests2/core/enforce-headless-qa.test.ts",
		inputs: frozen([".claude/.mcp.json"]),
	},
	{
		id: "affected-classification-source",
		consumer: "tests2/core/affected-test-classification.test.ts",
		inputs: frozen(["scripts/testing-v2/test-map-execution.mjs"]),
	},
	{
		id: "native-ci-workflow-contracts",
		consumer: "tests2/core/build-unit-gate-ci.test.ts",
		inputs: frozen([
			".github/workflows/build-unit-gate.yml",
			".github/workflows/codeql.yml",
		]),
	},
	{
		id: "bobbit-dir-config-module-fallback",
		consumer: "tests2/core/bobbit-dir-agent-dir.test.ts",
		inputs: frozen([
			"src/server/agent-dir-config.ts",
			"src/server/bobbit-dir.ts",
		]),
	},
	{
		id: "extension-host-channel-modules",
		consumer: "tests2/core/extension-host-channel-substrate.test.ts",
		inputs: frozen([
			"src/server/extension-host/channel-open-permits.ts",
			"src/server/extension-host/channel-registry.ts",
			"src/server/extension-host/channel-types.ts",
		]),
	},
	{
		id: "file-mentions-esbuild-entry",
		// This Vitest file is E2E-owned, so the edge is advisory rather than part
		// of the unit execution inventory. Keeping it in the same graph still
		// makes its non-import entry and transitive closure explicit and auditable.
		consumer: "tests2/core/file-mentions-authenticated-boundary.test.ts",
		inputs: frozen(["src/server/skills/resolve-file-mentions.ts"]),
	},
	{
		id: "hindsight-external-stub-module",
		consumer: "tests2/integration/hindsight-external.test.ts",
		inputs: frozen(["tests/e2e/hindsight-stub.mjs"]),
	},
	{
		id: "hung-test-reporter-module",
		consumer: "tests2/core/hung-test-reporter.test.ts",
		inputs: frozen(["tests2/core/helpers/hung-test-reporter.mjs"]),
	},
	{
		id: "image-generate-extension-module",
		consumer: "tests2/core/image-generate-no-model-param.test.ts",
		inputs: frozen(["defaults/tools/images/extension.ts"]),
	},
	{
		id: "ledger-child-module",
		consumer: "tests2/core/ledger-lease-bridge-interop.test.ts",
		inputs: frozen(["scripts/testing-v2/ledger.mjs"]),
	},
	{
		id: "qa-seed-module",
		consumer: "tests2/core/qa-seed.test.ts",
		inputs: frozen(["scripts/qa-seed/seed.mjs"]),
	},
	{
		id: "run-unit-heartbeat-module",
		consumer: "tests2/core/run-unit-heartbeat-diagnostics.test.ts",
		inputs: frozen(["scripts/lib/unit-heartbeat.mjs"]),
	},
	{
		id: "team-agent-gateway-module",
		consumer: "tests2/core/team-extension-dismiss-gateway.test.ts",
		inputs: frozen(["defaults/tools/agent/gateway.js"]),
	},
	{
		id: "run-isolation-playwright-configs",
		consumer: "tests2/core/run-isolation.test.ts",
		inputs: frozen([
			"playwright-e2e.config.ts",
			"playwright-v2.config.ts",
		]),
	},
	{
		id: "sentinel-restart-source-contract",
		consumer: "tests2/core/node-modules-ring-fence.test.ts",
		inputs: frozen([
			"src/server/harness.ts",
			"scripts/dev-nord.mjs",
			"scripts/harness-bootstrap.mjs",
		]),
	},
	{
		id: "published-shrinkwrap-fixtures",
		consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts",
		inputs: frozen([
			"package.json",
			"package-lock.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/advisory-floor.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/wrapper/package.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/wrapper/package-lock.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/consumer/package.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/consumer/package-lock.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/packages/protobufjs-vulnerable/package.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/packages/protobufjs-fixed/package.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/packages/published-agent/package.json",
			"tests2/core/fixtures/pi-published-shrinkwrap-security/packages/published-agent/npm-shrinkwrap.json",
		]),
	},
]);

const declaredExecutableOperation = (kind, expression, declarations, count = 1) => Object.freeze({
	kind,
	expression,
	count,
	declarations: frozen(declarations),
});
const allowedExecutableOperation = (kind, expression, allowReason, count = 1) => Object.freeze({
	kind,
	expression,
	count,
	allowReason,
});

/**
 * Exact audit of executable repository consumers that ordinary import/readFile
 * extraction cannot see. Operations either cite the live impact/scan/indirect
 * edge that owns their repository input or explain why the operand is generated,
 * external, or already covered by a normal static import. The graph validates
 * kind, normalized operand, and count, so a new nonliteral import, compiler
 * root, eager glob, recursive scan, worker, embedded import, or directory copy
 * is a deliberate inventory change rather than a silent selection blind spot.
 */
export const DYNAMIC_EXECUTABLE_CONSUMER_AUDIT = Object.freeze([
	{
		consumer: "tests2/core/pi-installed-contract.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "pathToFileURL(adapterPath).href", "installed Pi JSON event adapter selected by the pinned package contract"),
		]),
	},
	{
		consumer: "tests2/core/aigw-wellknown-dns-guard.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "`${pathToFileURL(extension!).href}?test=${Date.now()}`", "test-owned generated AIGW guard extension"),
		]),
	},
	{
		consumer: "tests2/core/anthropic-oauth-persistence.test.ts",
		operations: frozen([
			allowedExecutableOperation("worker-entry", "<inline-worker-source>", "inline worker reads only test-owned credential output"),
		]),
	},
	{
		consumer: "tests2/core/async-background-cleanup-static.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "productionTypeScriptFiles", ["scan:async-background-cleanup-source-guard"]),
			declaredExecutableOperation("typescript-program", "rootNames", ["scan:async-background-cleanup-source-guard"]),
			allowedExecutableOperation("typescript-program", "[fileName]", "in-memory TypeScript canary source"),
		]),
	},
	{
		consumer: "tests2/core/base-path-source-guards.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "sourceFiles", ["scan:client-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/bobbit-archive-allowlist.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "walkTs", ["scan:server-typescript-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/bobbit-dir-agent-dir.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "specifier", ["indirect:bobbit-dir-config-module-fallback"]),
			allowedExecutableOperation("recursive-directory-scan", "walk", "test-owned agent-directory snapshot tree"),
		]),
	},
	{
		consumer: "tests2/core/clean-build-warnings-regression.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "walkTsFiles", ["scan:client-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/extension-host-channel-substrate.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "modulePath", ["indirect:extension-host-channel-modules"]),
		]),
	},
	{
		consumer: "tests2/core/extension-host-module-isolation.test.ts",
		operations: frozen([
			allowedExecutableOperation("embedded-dynamic-import", "\"node:child_process\"", "inline module imports a Node builtin"),
			allowedExecutableOperation("embedded-dynamic-import", "\"node:fs\"", "inline module imports a Node builtin"),
			allowedExecutableOperation("embedded-dynamic-import", "<template-substitution>", "inline module imports a test-owned secret fixture"),
		]),
	},
	{
		consumer: "tests2/core/extension-host-no-capability-sandbox-residual.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "visit", ["scan:extension-capability-residual-guard"]),
		]),
	},
	{
		consumer: "tests2/core/file-mentions-authenticated-boundary.test.ts",
		operations: frozen([
			declaredExecutableOperation("esbuild-entry-points", "[path.resolve(\"src/server/skills/resolve-file-mentions.ts\")]", ["indirect:file-mentions-esbuild-entry"]),
		]),
	},
	{
		consumer: "tests2/core/gateway-nondelete-push-boundary.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "sourceFiles", ["scan:server-typescript-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/google-code-assist-provider-extension.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "pathToFileURL(file).href", "test-owned transpiled provider extension", 6),
		]),
	},
	{
		consumer: "tests2/core/guard-v2.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "walk", ["scan:v2-test-inventory-guard"]),
		]),
	},
	{
		consumer: "tests2/core/hung-test-reporter.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "reporterUrl", ["indirect:hung-test-reporter-module"]),
		]),
	},
	{
		consumer: "tests2/core/image-generate-no-model-param.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "pathToFileURL(file).href", ["indirect:image-generate-extension-module"]),
		]),
	},
	{
		consumer: "tests2/core/ledger-lease-bridge-interop.test.ts",
		operations: frozen([
			declaredExecutableOperation("embedded-dynamic-import", "process.env.BOBBIT_TEST_LEDGER_MODULE_URL", ["indirect:ledger-child-module"]),
			allowedExecutableOperation("embedded-dynamic-import", "\"node:os\"", "inline child imports a Node builtin"),
		]),
	},
	{
		consumer: "tests2/core/node-modules-ring-fence.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "`${pathToFileURL(liveCli).href}?restored=${Date.now()}`", "test-owned restored CLI interruption fixture"),
			allowedExecutableOperation("dynamic-import", "`${pathToFileURL(liveCandidateCli).href}?candidate=${Date.now()}`", "test-owned promoted CLI interruption fixture"),
		]),
	},
	{
		consumer: "tests2/core/no-dist-imports.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "collect", ["scan:unit-test-dist-import-guard"]),
		]),
	},
	{
		consumer: "tests2/core/openai-model-additions-merge.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "productionTypeScriptFiles", ["scan:metadata-retirement-source-guard"]),
		]),
	},
	{
		consumer: "tests2/core/no-general-workflow-default.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "listSourceFiles", ["scan:workflow-default-source-guard"]),
		]),
	},
	{
		consumer: "tests2/core/perm-frame-late-joiner-seq-gap.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "walk", ["scan:server-typescript-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/pi-ai-browser-boundary.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "resolved", "resolved external Pi package export"),
			declaredExecutableOperation("recursive-directory-scan", "walkTsFiles", ["scan:pi-browser-fixture-guard"]),
		]),
	},
	{
		consumer: "tests2/core/pi-rpc-thinking-levels.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "pathToFileURL(nestedCoreEntry).href", "resolved external nested package runtime"),
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-no-submit-proof.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "collectFiles", ["scan:pr-walkthrough-proof-removal-guard"]),
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-pack-boundary.test.ts",
		operations: frozen([
			allowedExecutableOperation("embedded-dynamic-import", "<template-substitution>", "diagnostic text names a forbidden import; it is not executable"),
			declaredExecutableOperation("recursive-directory-scan", "walkSourceFiles", ["scan:pr-walkthrough-pack-boundary"]),
		]),
	},
	{
		consumer: "tests2/core/preview-cookie.test.ts",
		operations: frozen([
			allowedExecutableOperation("embedded-dynamic-import", "pathToFileURL(signingKeyModule).href", "child imports the same module as an ordinary top-level static import"),
			allowedExecutableOperation("embedded-dynamic-import", "pathToFileURL(cookieModule).href", "child imports the same module as an ordinary top-level static import"),
			declaredExecutableOperation("recursive-directory-scan", "productionServerSourceFiles", ["scan:preview-cookie-server-source-guard"]),
			allowedExecutableOperation("worker-entry", "launcherPath", "test-owned launcher for the declared static production modules"),
		]),
	},
	{
		consumer: "tests2/core/preview-mount.test.ts",
		operations: frozen([
			allowedExecutableOperation("recursive-directory-scan", "walk", "test-owned preview mount tree"),
		]),
	},
	{
		consumer: "tests2/core/prompt-conditionals.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "listYaml", ["impact:builtin-roles"]),
		]),
	},
	{
		consumer: "tests2/core/provider-bridge-extension.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "pathToFileURL(file).href", "test-owned transpiled provider bridge"),
		]),
	},
	{
		consumer: "tests2/core/qa-seed.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "`${pathToFileURL(SEED_SCRIPT).href}?unit=${++seedRun}`", ["indirect:qa-seed-module"]),
		]),
	},
	{
		consumer: "tests2/core/run-unit-heartbeat-diagnostics.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "new URL(\"../../scripts/lib/unit-heartbeat.mjs\", import.meta.url).href", ["indirect:run-unit-heartbeat-module"]),
		]),
	},
	{
		consumer: "tests2/core/session-connect-timeout-main-thread-repro.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "searchSourceFiles", ["scan:search-worker-main-thread-boundary"]),
		]),
	},
	{
		consumer: "tests2/core/spawn-node-execpath-invariant.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "collectTsFiles", ["scan:server-typescript-source-guards"]),
		]),
	},
	{
		consumer: "tests2/core/team-extension-dismiss-gateway.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "\"../../defaults/tools/agent/gateway\" + \".js\"", ["indirect:team-agent-gateway-module"]),
		]),
	},
	{
		consumer: "tests2/core/tool-description-budget.test.ts",
		operations: frozen([
			declaredExecutableOperation("import-meta-glob", "\"../../defaults/tools/{agent,ask,bobbit,browser,html,images,inbox,mcp,proposals,review,shell,skills,tasks,team,web}/extension.ts\"", ["impact:builtin-tools"]),
		]),
	},
	{
		consumer: "tests2/core/tool-result-error-bridge-extension.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "`${pathToFileURL(filePath).href}?nonce=${Date.now()}-${Math.random()}`", "test-owned generated error bridge extension"),
		]),
	},
	{
		consumer: "tests2/core/worktree-setup-fallback.test.ts",
		operations: frozen([
			declaredExecutableOperation("recursive-directory-scan", "walk", ["scan:worktree-setup-source-guard"]),
		]),
	},
	{
		consumer: "tests2/integration/agent-dir-settings.test.ts",
		operations: frozen([
			allowedExecutableOperation("repository-directory-copy", "target", "test-owned snapshot of isolated agent-directory fixture state"),
			allowedExecutableOperation("repository-directory-copy", "snapshot.backup", "test-owned agent-directory fixture restored from its temporary snapshot"),
		]),
	},
	{
		consumer: "tests2/integration/history-fork-api.test.ts",
		operations: frozen([
			allowedExecutableOperation("recursive-directory-scan", "transcriptFilesForSession", "test-owned isolated agent-session transcript tree"),
		]),
	},
	{
		consumer: "tests2/integration/hindsight-external.test.ts",
		operations: frozen([
			declaredExecutableOperation("dynamic-import", "STUB_PATH as string", ["indirect:hindsight-external-stub-module"]),
			declaredExecutableOperation("repository-directory-copy", "PACK_SRC", ["scan:hindsight-external-pack-fixture"]),
		]),
	},
	{
		consumer: "tests2/integration/sandbox-security.test.ts",
		operations: frozen([
			allowedExecutableOperation("recursive-directory-scan", "readAllFiles", "isolated sandbox fixture tree"),
		]),
	},
	{
		consumer: "tests2/integration/search-preview-api.test.ts",
		operations: frozen([
			allowedExecutableOperation("repository-directory-copy", "previewArtifacts.artifactDir(sessionId, mounted.artifactId)", "test-owned mounted preview artifact tree"),
		]),
	},
	{
		consumer: "tests2/integration/server-prebundle-runtime.test.ts",
		operations: frozen([
			allowedExecutableOperation("dynamic-import", "pathToFileURL(join(cacheDir, ...emittedServer.split(\"/\"))).href", "content-addressed generated server prebundle"),
		]),
	},
	{
		consumer: "tests2/integration/staff-goal-triggers.test.ts",
		operations: frozen([
			allowedExecutableOperation("repository-directory-copy", "join(publisher, \".git\")", "test-owned Git-template clone copied into a temporary bare remote"),
			allowedExecutableOperation("repository-directory-copy", "join(origin, \"objects\", objectRelativePath)", "test-owned temporary bare-remote object copied into a writable Git-template clone"),
		]),
	},
]);

/**
 * Exact audit of every unresolved read expression in the authoritative unit
 * inventory. Repository reads cite the declaration that supplies graph/hash
 * edges; only test-owned generated paths carry an allow reason. Counts make a
 * second read through an existing expression an intentional review event too.
 */
export const UNRESOLVED_REPOSITORY_READ_AUDIT = Object.freeze([
	{
		consumer: "tests2/core/pi-installed-contract.test.ts",
		allowReason: "installed pinned Pi dependency package metadata and adapter paths",
		reads: frozen([
			{ expression: "candidate", count: 1 },
			{ expression: "path.join(installedPackageRoot(packageName), \"package.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/borrowed-sandbox-worktree-ownership.test.ts",
		allowReason: "test-owned persisted sandbox transcript used to prove byte preservation across reload and termination",
		reads: frozen([
			{ expression: "fixture.restored.agentSessionFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/focused-tool-contract-refresh.test.ts",
		allowReason: "test-owned generated system prompt and the tool detail document path it points to",
		reads: frozen([
			{ expression: "spawnedOptions.systemPromptPath", count: 1 },
			{ expression: "agentDocsPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/session-fs-sandbox-publication.test.ts",
		allowReason: "isolated test-owned sandbox filesystem transcript, canary, and staging artifacts",
		reads: frozen([
			{ expression: "hostDestination", count: 1 },
			{ expression: "path.join(sentinel, \"sentinel.txt\")", count: 1 },
			{ expression: "filesystem.hostPath(destination)", count: 2 },
			{ expression: "hostCanary", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/extension-host-surface-token.test.ts",
		declarations: frozen(["scan:server-typescript-source-guards"]),
		reads: frozen([
			{ expression: "sourcePath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/verification-restart-resignal.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "persistPath", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/tools-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "abs", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/tool-guard-ask-policy.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "guardFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/system-prompt-customise.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "userPromptPath()", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/stateless-cookie-regression.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/stateless-cookie-behavior.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "join(runtime.bobbitDir.serverSecretsDir(), COOKIE_SIGNING_KEY_FILE)", count: 1 },
			{ expression: "file", count: 1 },
			{ expression: "registryFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/staff-goal-triggers.test.ts",
		allowReason: "test-owned temporary Git-template clones, bare remote, refs, and loose objects",
		reads: frozen([
			{ expression: "refPath(repo, ref)", count: 1 },
			{ expression: "join(origin, \"refs\", \"heads\", \"main\")", count: 1 },
			{ expression: "join(publisher, \".git\", \"objects\", baselineSha.slice(0, 2), baselineSha.slice(2))", count: 1 },
			{ expression: "join(origin, \"objects\", remoteSha.slice(0, 2), remoteSha.slice(2))", count: 1 },
			{ expression: "join(watched, \".git\", \"objects\", remoteSha.slice(0, 2), remoteSha.slice(2))", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/staff-accessory-persistence.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "staffJsonPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/sidebar-actions-fork-github-link.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "jsonlPath", count: 1 },
			{ expression: "file", count: 1 },
			{ expression: "destJsonl", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/session-store-real-fs.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "storeFile", count: 5 },
			{ expression: "bak1", count: 1 },
			{ expression: "bak2", count: 1 },
			{ expression: "`${storeFile}.bak.1`", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/server-prebundle-runtime.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "join(cacheDir, \"manifest.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/search-preview-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "cloneMetadataPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/review-payload-api-hardening.test.ts",
		allowReason: "isolated integration gateway review-annotation state",
		reads: frozen([
			{ expression: "annotationPath", count: 7 },
		]),
	},
	{
		consumer: "tests2/integration/sandbox-security.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "fullPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/proposal-edit-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "p", count: 1 },
			{ expression: "fp", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/projects-no-default-workflows.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "p", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/project-reorder-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "join(gateway.bobbitDir, \"state\", \"projects.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/project-config-route-persistence-failure.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "path.join(rootPath, \".bobbit\", \"config\", \"project.yaml\")", count: 1 },
			{ expression: "path.join(rootPath, \".bobbit\", \"state\", \"secrets.json\")", count: 1 },
			{ expression: "configFile", count: 8 },
			{ expression: "secretsFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/project-config-native-yaml.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "projectYamlPath(rootPath)", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/project-config-component-config.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "sharedProjectYamlPath()", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/orchestrate-restart.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "promptPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/oauth-google-logout.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "p", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/multi-repo-project.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "path.join(root, \".bobbit\", \"config\", \"project.yaml\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/message-author-extension-projection.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "seeded.transcriptFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/history-fork-api.test.ts",
		allowReason: "isolated integration gateway and test-owned transcript, proposal, and worktree artifacts",
		reads: frozen([
			{ expression: "seeded.file", count: 5 },
			{ expression: "sandboxFixture.filesystem.hostPath(persisted.agentSessionFile)", count: 1 },
			{ expression: "stagedFile", count: 1 },
			{ expression: "forkPersisted.agentSessionFile", count: 4 },
			{ expression: "path.join(proposalFork, \"goal.md\")", count: 1 },
			{ expression: "path.join(proposalFork, \"goal.history\", \"0001.md\")", count: 1 },
			{ expression: "sentinel", count: 1 },
			{ expression: "sourceTranscript.file", count: 2 },
			{ expression: "trusted", count: 2 },
			{ expression: "attackerFile", count: 3 },
			{ expression: "sourceHostPath", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/hindsight-external.test.ts",
		allowReason: "isolated installed-pack provider configuration",
		reads: frozen([
			{ expression: "providerYaml", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/harness-restart-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "sentinel", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/gateway-fixture-leak.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "outPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/gate-inspect-slicing.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "artifact.path", count: 1 },
			{ expression: "retainedArtifact.path", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/dev-boot-timing-api.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/cost-tracker-real-fs.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "storeFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/continue-archived.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "target", count: 1 },
			{ expression: "command.sessionPath", count: 1 },
			{ expression: "sourceTranscript", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/continue-archived-assistant.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "a", count: 1 },
			{ expression: "b", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/base-path-gateway-routes.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "join(running.root, \"state\", \"gateway-url\")", count: 3 },
		]),
	},
	{
		consumer: "tests2/integration/base-path-gateway-root.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "join(running.staticDir, \"index.html\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/integration/aigw-session-header.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "modelsPath", count: 1 },
			{ expression: "getModelsJsonPath()", count: 3 },
		]),
	},
	{
		consumer: "tests2/integration/agent-tools-e2e.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "testFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/integration/agent-dir-settings.test.ts",
		allowReason: "isolated integration gateway, project, or harness-owned output",
		reads: frozen([
			{ expression: "preferencesPath", count: 2 },
			{ expression: "path.join(bobbitDir(), \"state\", \"preferences.json\")", count: 1 },
			{ expression: "path.join(active, \"auth.json\")", count: 1 },
			{ expression: "path.join(pending, \"sessions\", \"session-a\", \"transcript.jsonl\")", count: 1 },
			{ expression: "path.join(pending, \"bin\", \"rg\")", count: 1 },
			{ expression: "path.join(pending, \"auth.json\")", count: 2 },
		]),
	},
	{
		consumer: "tests2/dom/search/indexer.test.ts",
		allowReason: "test-owned temporary search index mirror output",
		reads: frozen([
			{ expression: "docsPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/dom/search/index-source-contract.test.ts",
		allowReason: "test-owned temporary search source stream",
		reads: frozen([
			{ expression: "streamPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/dom/search/flex-store.test.ts",
		allowReason: "test-owned temporary search index mirror output",
		reads: frozen([
			{ expression: "path.join(dir, \"index\", \"__docs__.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/dom/search/flex-store-close-teardown.test.ts",
		allowReason: "test-owned temporary search mirror and journal output",
		reads: frozen([
			{ expression: "path.join(indexDir, \"__docs__.json\")", count: 2 },
			{ expression: "path.join(indexDir, \"__docs__.journal\")", count: 3 },
		]),
	},
	{
		consumer: "tests2/dom/grep-dash-pattern.test.ts",
		declarations: frozen(["impact:builtin-tools"]),
		reads: frozen([
			{ expression: "join(groupPath, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/worktree-setup-fallback.test.ts",
		declarations: frozen(["scan:worktree-setup-source-guard"]),
		reads: frozen([
			{ expression: "file", count: 4 },
		]),
	},
	{
		consumer: "tests2/core/workflow-store.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(configDir, \"project.yaml\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/verification-sandbox-exec.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "result.diagnostics.stdout.path", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/verification-harness-timeout.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "(harness as any)._persistPath", count: 4 },
		]),
	},
	{
		consumer: "tests2/core/verification-harness-restart.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "persistPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/unit-lanes-scheduling.test.ts",
		declarations: frozen(["scan:unit-runtime-closure-guard"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-oauth-credential-store.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "authPath", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/transcript-sanitizer.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "outside", count: 2 },
			{ expression: "realTarget", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/transcript-sanitizer-agent-dir.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "outside", count: 2 },
			{ expression: "target", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/transcript-host-absolute-context.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "transcript", count: 1 },
			{ expression: "dst", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/tool-startup-resilience.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "extensionPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/tool-result-error-bridge-extension.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "secondPath!", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/tool-docs-prompt.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(stateDir, \"tool-docs\", \"shell.md\")", count: 1 },
			{ expression: "path.join(stateDir, \"tool-docs\", \"filesystem.md\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/tool-activation-pi-extension.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "guardPath!", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/token-dir.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(dirA, \"token\")", count: 2 },
			{ expression: "path.join(dirB, \"token\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/team-recovery-checkpoint.test.ts",
		allowReason: "checkpoint marker inside the test-owned temporary state directory",
		reads: frozen([
			{ expression: "marker", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/team-manager-ghost-workers.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "TEAM_STORE_FILE", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/system-prompt.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "result", count: 12 },
		]),
	},
	{
		consumer: "tests2/core/system-prompt-order.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "p", count: 12 },
		]),
	},
	{
		consumer: "tests2/core/system-prompt-cwd.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "promptPath", count: 4 },
		]),
	},
	{
		consumer: "tests2/core/staff-accessory-store.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(dir, \"staff.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/spawn-tree-process-cleanup.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "probe.sentinelFile", count: 1 },
			{ expression: "path.join(stateDir, \"active-verifications.json\")", count: 4 },
		]),
	},
	{
		consumer: "tests2/core/spawn-node-execpath-invariant.test.ts",
		declarations: frozen(["scan:server-typescript-source-guards"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/source-pin-merge-invariants.test.ts",
		declarations: frozen(["indirect:source-pin-merge-invariants"]),
		reads: frozen([
			{ expression: "path.join(REPO_ROOT, p)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/session-manager-delegate-restore.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "promptPath!", count: 1 },
			{ expression: "promptPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/session-connect-timeout-main-thread-repro.test.ts",
		declarations: frozen(["scan:search-worker-main-thread-boundary"]),
		reads: frozen([
			{ expression: "file", count: 3 },
		]),
	},
	{
		consumer: "tests2/core/server-prebundle-cache.test.ts",
		allowReason: "generated build or content-addressed cache output",
		reads: frozen([
			{ expression: "join(artifactDir, \"manifest.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/scaffold-agent-gitignore.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(projectRoot, \".bobbit\", \".gitignore\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/sandbox-google-auth.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "sandboxAgentAuthPath(\"google-project\")", count: 1 },
			{ expression: "sandboxAgentAuthPath(\"excluded-project\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/sandbox-codex-auth.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 2 },
			{ expression: "sandboxAgentAuthPath(\"excluded-project\")", count: 1 },
			{ expression: "sandboxAgentAuthPath(\"allowed-project\")", count: 1 },
			{ expression: "sandboxAgentAuthPath(\"pref-project\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/run-isolation.test.ts",
		declarations: frozen(["indirect:run-isolation-playwright-configs"]),
		reads: frozen([
			{ expression: "config", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/role-team-tools-policy.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools"]),
		reads: frozen([
			{ expression: "path.join(ROLES_DIR, `${name}.yaml`)", count: 1 },
			{ expression: "path.join(dirPath, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/role-store.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "yamlPath", count: 1 },
			{ expression: "path.join(dir, \"roles\", \"coder.yaml\")", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/role-gate-signal-policy.test.ts",
		declarations: frozen(["impact:builtin-roles"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/role-children-tools-policy.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools"]),
		reads: frozen([
			{ expression: "path.join(ROLES_DIR, `${name}.yaml`)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/role-bobbit-tools-policy.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools"]),
		reads: frozen([
			{ expression: "path.join(ROLES_DIR, `${name}.yaml`)", count: 1 },
			{ expression: "path.join(BOBBIT_TOOLS_DIR, `${toolName}.yaml`)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/reviewer-read-session-policy.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools","impact:committed-config-cascade","impact:market-packs"]),
		reads: frozen([
			{ expression: "path.join(repoRoot, relativePath)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/reviewer-diff-scope-prompts.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:market-packs"]),
		reads: frozen([
			{ expression: "path.join(repoRoot, relativePath)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/reviewer-cannot-team-delegate.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools"]),
		reads: frozen([
			{ expression: "path.join(ROLES_DIR, `${name}.yaml`)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/reviewer-archive-metadata.test.ts",
		declarations: frozen(["indirect:reviewer-archive-metadata"]),
		reads: frozen([
			{ expression: "path.join(SRC_ROOT, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/release-skill-preflight-order.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "options.env.npm_config_userconfig", count: 2 },
			{ expression: "options.env.npm_config_globalconfig", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/qa-testing-config.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(tmpDir, \"project.yaml\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/qa-seed.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(stateDir, filename)", count: 1 },
			{ expression: "path.join(serverStateDir, filename)", count: 1 },
			{ expression: "filePath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pwtest-cache-publish.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "join(run, \"a.js\")", count: 5 },
			{ expression: "join(run, \"sub\", \"b.js\")", count: 1 },
			{ expression: "join(latest, \"a.js\")", count: 4 },
			{ expression: "join(latest, \"new.js\")", count: 1 },
			{ expression: "join(latest, \"winner.js\")", count: 1 },
			{ expression: "join(nextRun, \"a.js\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/proposal-rehydrate.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "fp", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/prompt-conditionals.test.ts",
		declarations: frozen(["impact:builtin-roles"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/project-registry-provisional-dedupe.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(stateDir, \"projects.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/project-registry-order.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(stateDir, \"projects.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/project-config-store-native-yaml.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "yamlPath()", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/project-config-store-durability.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "configFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/preview-root-identity-races.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(root, \"EXTERNAL.txt\")", count: 1 },
			{ expression: "path.join(source, \"EXTERNAL.txt\")", count: 1 },
			{ expression: "path.join(detached, \"inside.txt\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/preview-cookie.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "keyPath", count: 4 },
			{ expression: "path.join(secretsDir, COOKIE_SIGNING_KEY_FILE)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-tool-metadata.test.ts",
		declarations: frozen(["impact:market-packs"]),
		reads: frozen([
			{ expression: "path.join(groupDir, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-role-tools-policy.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools","impact:market-packs"]),
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "filePath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-pack-boundary.test.ts",
		declarations: frozen(["impact:market-packs","scan:pr-walkthrough-pack-boundary"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-no-submit-proof.test.ts",
		declarations: frozen(["scan:pr-walkthrough-proof-removal-guard"]),
		reads: frozen([
			{ expression: "abs", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pr-walkthrough-bundle-tool-metadata.test.ts",
		declarations: frozen(["impact:market-packs"]),
		reads: frozen([
			{ expression: "path.join(groupDir, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pi-published-shrinkwrap-security.test.ts",
		declarations: frozen(["indirect:published-shrinkwrap-fixtures"]),
		reads: frozen([
			{ expression: "path.join(FIXTURE_ROOT, relativePath)", count: 1 },
			{ expression: "path.join(REPOSITORY_ROOT, relativePath)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/pi-ai-browser-boundary.test.ts",
		declarations: frozen(["scan:pi-browser-fixture-guard"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/openai-model-additions-merge.test.ts",
		declarations: frozen(["scan:metadata-retirement-source-guard"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/oauth-google.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "authPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/oauth-external-callbacks.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "authPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/nurse-cap-accessory.test.ts",
		declarations: frozen(["indirect:nurse-cap-rendering-contracts"]),
		reads: frozen([
			{ expression: "path.join(root, rel)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/node-modules-ring-fence.test.ts",
		declarations: frozen([
			"impact:package-metadata",
			"indirect:sentinel-restart-source-contract",
		]),
		policyExemption: "remaining operands are test-owned temporary staged-build and sentinel fixture outputs",
		reads: frozen([
			{ expression: "sentinel", count: 2 },
			{ expression: "file", count: 1 },
			{ expression: "path.join(repositoryRoot, relativePath)", count: 1 },
			{ expression: "path.join(repositoryRoot, \"package.json\")", count: 2 },
			{ expression: "liveCli", count: 4 },
			{ expression: "liveUi", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/no-general-workflow-default.test.ts",
		declarations: frozen(["scan:workflow-default-source-guard"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/no-dist-imports.test.ts",
		declarations: frozen(["scan:unit-test-dist-import-guard"]),
		reads: frozen([
			{ expression: "f", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/multi-project.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 2 },
			{ expression: "path.join(stateDir, backups[0])", count: 1 },
			{ expression: "path.join(stateDir, \"projects.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/migrate-project-yaml.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "yamlFile", count: 10 },
		]),
	},
	{
		consumer: "tests2/core/mcp-meta-policy.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "extensionPaths[0]", count: 3 },
		]),
	},
	{
		consumer: "tests2/core/mcp-doc-cache.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "cacheFile", count: 7 },
			{ expression: "mdFile", count: 6 },
			{ expression: "aFile", count: 1 },
			{ expression: "bFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/marketplace-source-store-gateway.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(tmpDir, \"marketplace-sources.yaml\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/marketplace-source-builtin.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/marketplace-mcp-gateway.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(dest, \"pack.yaml\")", count: 1 },
			{ expression: "path.join(dest, \"mcp\", \"jira.yaml\")", count: 1 },
			{ expression: "path.join(dest, \"mcp\", \"jira-write.yaml\")", count: 1 },
			{ expression: "path.join(dest, \".pack-meta.yaml\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/manual-test-model-seeding.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/local-only-role-prompts.test.ts",
		declarations: frozen(["impact:builtin-roles"]),
		reads: frozen([
			{ expression: "path.join(repoRoot, \"defaults\", \"roles\", `${role}.yaml`)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/lifecycle-hub.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "markerPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/inline-html-theme-bridge-repro.test.ts",
		declarations: frozen(["static:src/ui/tools/renderers/HtmlRenderer.ts"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/hung-test-reporter.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "heartbeatFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/headset-accessory.test.ts",
		declarations: frozen(["indirect:accessory-rendering-contracts"]),
		reads: frozen([
			{ expression: "path.join(root, rel)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/ponytail-accessory.test.ts",
		declarations: frozen(["indirect:ponytail-rendering-contracts"]),
		reads: frozen([
			{ expression: "path.join(root, rel)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/headquarters-state-migration.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "filePath", count: 1 },
			{ expression: "path.join(dirs.headquartersConfigDir, \"project.yaml\")", count: 1 },
			{ expression: "file", count: 2 },
			{ expression: "marker", count: 2 },
			{ expression: "diagnostics", count: 2 },
			{ expression: "copiedPreview", count: 2 },
			{ expression: "path.join(dirs.headquartersStateDir, \"gateway-url\")", count: 2 },
			{ expression: "sessionsFile", count: 2 },
			{ expression: "secretsToken", count: 2 },
			{ expression: "path.join(secretsDir, \"sandbox-agent-auth\")", count: 1 },
			{ expression: "path.join(secretsDir, \"tls\", \"cert.pem\")", count: 1 },
			{ expression: "path.join(secretsDir, \"token\")", count: 3 },
			{ expression: "path.join(dirs.headquartersStateDir, \"migration-quarantine\", \"config\", \"legacy-server-bobbit-config\", \"project.yaml\")", count: 1 },
			{ expression: "path.join(overrideConfig, \"project.yaml\")", count: 1 },
			{ expression: "normalStaffFile", count: 2 },
			{ expression: "hqStaffFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/team-manager-async-recovery.test.ts",
		allowReason: "test-owned temporary sidecar output used to prove retry after publication failure",
		reads: frozen([
			{ expression: "targetSidecar", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/google-code-assist-provider-extension.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "p", count: 3 },
			{ expression: "before", count: 2 },
			{ expression: "after!", count: 2 },
			{ expression: "p2!", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/goal-metadata-second-review-fixes.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "p", count: 3 },
		]),
	},
	{
		consumer: "tests2/core/goal-metadata-edges.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "withDisable!", count: 1 },
			{ expression: "first!", count: 1 },
			{ expression: "p", count: 2 },
			{ expression: "markerKeep", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/git-template-copy.test.ts",
		allowReason: "coordinator-owned template and test-owned writable copies",
		reads: frozen([
			{ expression: "join(first.path, \".git\", \"HEAD\")", count: 1 },
			{ expression: "join(first.path, \".git\", \"config\")", count: 1 },
			{ expression: "join(first.path, \"README.md\")", count: 1 },
			{ expression: "join(copies[0], \"README.md\")", count: 1 },
			{ expression: "join(copies[1], \"README.md\")", count: 1 },
			{ expression: "join(copies[2], \"README.md\")", count: 1 },
			{ expression: "join(source.path, \"README.md\")", count: 1 },
			{ expression: "join(copies[2], \".git\", \"HEAD\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/gateway-nondelete-push-boundary.test.ts",
		declarations: frozen(["scan:server-typescript-source-guards"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/gate-store-sqlite.test.ts",
		allowReason: "test-owned temporary GateStore state and retirement fixtures",
		reads: frozen([
			{ expression: "recoveryFile", count: 1 },
			{ expression: "invalidFile", count: 1 },
			{ expression: "duplicateFile", count: 1 },
			{ expression: "sourceFile", count: 2 },
			{ expression: "livePreferred", count: 1 },
			{ expression: "recoveryPreferred", count: 1 },
			{ expression: "`${livePreferred}.1`", count: 1 },
			{ expression: "`${recoveryPreferred}.1`", count: 1 },
			{ expression: "`${livePreferred}.2`", count: 1 },
			{ expression: "`${recoveryPreferred}.2`", count: 1 },
			{ expression: "preferred", count: 2 },
			{ expression: "retryTarget", count: 1 },
			{ expression: "`${preferred}.2`", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/goal-store-sqlite.test.ts",
		allowReason: "test-owned temporary GoalStore state, migration, and retirement fixtures",
		reads: frozen([
			{ expression: "`${liveFile}.sqlite-retired`", count: 1 },
			{ expression: "`${liveFile}.pre-migration-recovered`", count: 1 },
			{ expression: "`${legacyFile}.sqlite-retired`", count: 1 },
			{ expression: "tombstoneFile", count: 1 },
			{ expression: "preferred", count: 1 },
			{ expression: "`${preferred}.1`", count: 1 },
			{ expression: "`${preferred}.2`", count: 1 },
			{ expression: "malformedFile", count: 1 },
			{ expression: "duplicateFile", count: 1 },
			{ expression: "failedFile", count: 1 },
			{ expression: "sourceFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/goal-task-store-lifecycle.test.ts",
		allowReason: "test-owned temporary pre-migration recovery and native-handle release fixtures",
		reads: frozen([
			{ expression: "goalRecovery", count: 1 },
			{ expression: "taskRecovery", count: 1 },
			{ expression: "tombstoneFile", count: 1 },
			{ expression: "path.join(stateDir, \"sessions.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/task-store-sqlite.test.ts",
		allowReason: "test-owned temporary TaskStore state, migration, and retirement fixtures",
		reads: frozen([
			{ expression: "`${liveFile}.sqlite-retired`", count: 1 },
			{ expression: "`${liveFile}.sqlite-retired.1`", count: 1 },
			{ expression: "`${recoveryFile}-recovered`", count: 1 },
			{ expression: "`${recoveryFile}-recovered.1`", count: 1 },
			{ expression: "path.join(stateDir, \".deletion-tombstones.json\")", count: 1 },
			{ expression: "preferredBackup", count: 1 },
			{ expression: "`${preferredBackup}.1`", count: 1 },
			{ expression: "malformedFile", count: 1 },
			{ expression: "duplicateFile", count: 1 },
			{ expression: "failedFile", count: 1 },
			{ expression: "recoveryFile", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/extension-host-terminal.test.ts",
		declarations: frozen(["impact:market-packs"]),
		reads: frozen([
			{ expression: "path.join(root, \"pack.yaml\")", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/extension-host-pack-store.test.ts",
		allowReason: "test-owned temporary pack-store data and bounded recovery slots",
		reads: frozen([
			{ expression: "`${file}.corrupt`", count: 5 },
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/extension-host-no-capability-sandbox-residual.test.ts",
		declarations: frozen(["scan:extension-capability-residual-guard"]),
		policyExemption: "docs/** operands retain the affected runner's explicit docs-only skip contract",
		reads: frozen([
			{ expression: "abs", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/error-modal-call-sites.test.ts",
		declarations: frozen(["indirect:error-modal-call-sites"]),
		reads: frozen([
			{ expression: "abs", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/ensure-dist-build-key.test.ts",
		allowReason: "generated build or content-addressed cache output",
		reads: frozen([
			{ expression: "file", count: 1 },
			{ expression: "join(root, \"build-count\")", count: 1 },
			{ expression: "join(repoRoot, \"dist\", \"server\", \"cli.js\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/enforce-headless-qa.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:builtin-tools","indirect:headless-qa-mcp-config"]),
		reads: frozen([
			{ expression: "p", count: 4 },
		]),
	},
	{
		consumer: "tests2/core/dev-boot-timing.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "written!", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/delegate-helper-policy-plumbing.test.ts",
		declarations: frozen(["indirect:delegate-helper-policy-plumbing"]),
		reads: frozen([
			{ expression: "path.join(SRC_ROOT, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/default-role-policy.test.ts",
		declarations: frozen(["impact:builtin-roles"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/cpu-diagnostics.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "file", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/comparative-design-prompts.test.ts",
		declarations: frozen(["impact:builtin-roles","impact:committed-config-cascade","impact:prompt-and-authoring-inputs"]),
		reads: frozen([
			{ expression: "path.join(repoRoot, relativePath)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/clean-build-warnings-regression.test.ts",
		declarations: frozen(["scan:client-source-guards"]),
		reads: frozen([
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bundle-size.test.ts",
		allowReason: "generated build or content-addressed cache output",
		reads: frozen([
			{ expression: "MANIFEST_PATH", count: 1 },
			{ expression: "file", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/build-unit-gate-ci.test.ts",
		declarations: frozen(["indirect:native-ci-workflow-contracts"]),
		reads: frozen([
			{ expression: "path", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/browser-screenshot-no-bloat.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "filePath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bounded-tree-quarantine-races.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(nested, \"victim.txt\")", count: 1 },
			{ expression: "sentinel", count: 1 },
			{ expression: "path.join(racedPath, \"EXTERNAL.txt\")", count: 3 },
			{ expression: "path.join(detached, \"inside.txt\")", count: 2 },
			{ expression: "path.join(root, \"EXTERNAL.txt\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bounded-tree-quarantine-errors.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(root, \"EXTERNAL.txt\")", count: 1 },
			{ expression: "path.join(quarantine, \"inside.txt\")", count: 1 },
			{ expression: "retained[0]!", count: 1 },
			{ expression: "path.join(quarantine, \"KEEP.txt\")", count: 1 },
			{ expression: "path.join(detachedOwned, \"inside.txt\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bounded-tree-parent-identity.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(fixture.nested, \"EXTERNAL.txt\")", count: 3 },
			{ expression: "path.join(fixture.nested, \"overflow.txt\")", count: 1 },
			{ expression: "fixture.sentinel", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bobbit-tool-tiers.test.ts",
		declarations: frozen(["impact:builtin-tools"]),
		reads: frozen([
			{ expression: "path.join(YAML_DIR, expected.file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bobbit-dir-agent-dir.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(stateDir, \"preferences.json\")", count: 1 },
			{ expression: "abs", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bobbit-archive.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(res.archiveDir, \"MANIFEST.json\")", count: 1 },
			{ expression: "manifestPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bobbit-archive-allowlist.test.ts",
		declarations: frozen(["scan:server-typescript-source-guards"]),
		reads: frozen([
			{ expression: "f", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/binaries-resolver.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(first.binDir!, `fd${ext}`)", count: 1 },
			{ expression: "path.join(first.binDir!, `rg${ext}`)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/bg-process-persistence.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(h.stateDir, \"bg-processes.json\")", count: 1 },
			{ expression: "path.join(h2.stateDir, \"bg-processes.json\")", count: 1 },
			{ expression: "rec.logFile", count: 1 },
			{ expression: "opts.pidFile", count: 1 },
			{ expression: "opts.statusFile", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/base-path-vite-proxy.test.ts",
		allowReason: "generated build or content-addressed cache output",
		reads: frozen([
			{ expression: "path.join(assetsDir, file)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/base-path-source-guards.test.ts",
		declarations: frozen(["scan:client-source-guards"]),
		reads: frozen([
			{ expression: "file", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/base-path-preview-contract.test.ts",
		declarations: frozen(["indirect:base-path-preview-contract"]),
		reads: frozen([
			{ expression: "path.resolve(relative)", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/author-sidecar.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "sidecarPath(sessionId)", count: 2 },
			{ expression: "ledger", count: 1 },
			{ expression: "file", count: 1 },
			{ expression: "sidecarPath(\"legacy-session\", privateRoot)", count: 1 },
			{ expression: "sidecarPath(\"legacy-v2-session\", privateRoot)", count: 1 },
			{ expression: "sidecarPath(sessionId, privateRoot)", count: 1 },
			{ expression: "sidecarPath(\"copy-destination\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-sandbox-handoff-regression.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "sandboxAgentAuthPath(\"project-test\")", count: 5 },
			{ expression: "path.join(agentDir!, \"auth.json\")", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-oauth-persistence.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "authPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-oauth-pi-callback-contract-repro.test.ts",
		allowReason: "installed external Pi package source pinned by dependency metadata",
		reads: frozen([
			{ expression: "path.join(path.dirname(piProvidersEntry), \"..\", \"auth\", \"oauth\", \"anthropic.js\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-oauth-adapter.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "authPath", count: 17 },
		]),
	},
	{
		consumer: "tests2/core/anthropic-model-probe-regression.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(agentDir!, \"auth.json\")", count: 6 },
		]),
	},
	{
		consumer: "tests2/core/aigw-wellknown-persistence.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(tmpAgentDir, \"models.json\")", count: 1 },
			{ expression: "modelsPath", count: 5 },
		]),
	},
	{
		consumer: "tests2/core/aigw-startup-refresh.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "f", count: 1 },
			{ expression: "path.join(tmp, \"models.json\")", count: 4 },
			{ expression: "modelsPath", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/aigw-retained-catalog-on-discovery-failure.test.ts",
		allowReason: "test-owned temporary agent models.json fixture used to verify byte preservation",
		reads: frozen([
			{ expression: "path.join(agentDir, \"models.json\")", count: 7 },
		]),
	},
	{
		consumer: "tests2/core/aigw-pricing.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "path.join(agentDir, \"models.json\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/aigw-headers.test.ts",
		allowReason: "test-owned temporary, generated, cache, or in-memory fixture output",
		reads: frozen([
			{ expression: "f", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/affected-test-classification.test.ts",
		declarations: frozen(["indirect:affected-classification-source"]),
		reads: frozen([
			{ expression: "resolve(REPO_ROOT, \"scripts/testing-v2/test-map-execution.mjs\")", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/affected-runner-cli.test.ts",
		allowReason: "test-owned temporary affected-runner fixture files",
		reads: frozen([
			{ expression: "packagePath", count: 1 },
			{ expression: "target", count: 1 },
		]),
	},
	{
		consumer: "tests2/core/affected-runner-no-escape.test.ts",
		declarations: frozen(["scan:affected-runner-no-escape-guard"]),
		reads: frozen([
			{ expression: "file", count: 2 },
		]),
	},
	{
		consumer: "tests2/core/affected-correctness-harness.test.ts",
		allowReason: "invocation-owned temporary fake Vitest report under qualification root",
		reads: frozen([
			{ expression: "reportPath", count: 1 },
		]),
	},
]);

function normalizedDeclaredPath(value) {
	const path = posix(value);
	if (!path
		|| path.startsWith("/")
		|| /^[A-Za-z]:\//.test(path)
		|| path === ".."
		|| path.startsWith("../")
		|| path.includes("/../")) return undefined;
	return path.split("/").filter((segment) => segment && segment !== ".").join("/");
}

function normalizedTombstones(values = []) {
	const tombstones = new Map();
	for (const value of values ?? []) {
		const path = normalizedDeclaredPath(value);
		if (path) tombstones.set(path.toLowerCase(), path);
	}
	return tombstones;
}

function isTombstoned(tombstones, pathValue) {
	const path = normalizedDeclaredPath(pathValue);
	return Boolean(path && tombstones.has(path.toLowerCase()));
}

export function impactRulesForPath(pathValue) {
	const path = posix(pathValue);
	return IMPACT_RULES.filter((rule) => rule.matches(path));
}

export function repositoryScanRulesForPath(pathValue) {
	const path = posix(pathValue);
	return REPOSITORY_SCAN_RULES.filter((rule) => rule.matches(path));
}

function walkFiles(repoRoot, relativeRoot, out) {
	const absoluteRoot = join(repoRoot, ...relativeRoot.split("/"));
	if (!existsSync(absoluteRoot)) return;
	const visit = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === ".git") continue;
			const absolute = join(dir, entry.name);
			if (entry.isDirectory()) visit(absolute);
			else out.push(posix(relative(repoRoot, absolute)));
		}
	};
	visit(absoluteRoot);
}

/** Enumerate shipped inputs plus exact deleted/renamed inputs claimed by a family. */
export function inventoryShippedInputs(repoRoot, tombstoneValues = []) {
	const candidates = [];
	for (const root of ["defaults", "market-packs", "workflows", ".claude/skills", ".bobbit/config"]) {
		walkFiles(repoRoot, root, candidates);
	}
	if (existsSync(join(repoRoot, "AGENTS.md"))) candidates.push("AGENTS.md");
	for (const path of normalizedTombstones(tombstoneValues).values()) {
		const family = SHIPPED_INPUT_FAMILIES.find((candidate) => candidate.qualifies(path));
		if (family && impactRulesForPath(path).some((rule) => rule.id === family.id)) candidates.push(path);
	}
	// Current files remain independent from rule matchers so a new family cannot
	// hide. Only absent paths explicitly supplied by the current Git change are
	// admitted through an already-declared family.
	return [...new Set(candidates)].sort();
}

/** Enumerate every current or tombstoned executable input covered by a scan. */
export function inventoryRepositoryScanInputs(repoRoot, tombstoneValues = []) {
	const candidates = [];
	for (const rule of REPOSITORY_SCAN_RULES) {
		for (const root of rule.roots) walkFiles(repoRoot, root, candidates);
	}
	for (const path of normalizedTombstones(tombstoneValues).values()) {
		if (repositoryScanRulesForPath(path).length > 0) candidates.push(path);
	}
	return [...new Set(candidates)]
		.filter((path) => repositoryScanRulesForPath(path).length > 0)
		.sort();
}

/** Validate declared scans independently from static read extraction. */
export function validateRepositoryScanInventory(repoRoot, unitTests, tombstoneValues = []) {
	const testSet = unitTests instanceof Set ? unitTests : new Set(unitTests);
	const tombstones = normalizedTombstones(tombstoneValues);
	const inputs = inventoryRepositoryScanInputs(repoRoot, tombstones.values());
	const issues = [];
	for (const rule of REPOSITORY_SCAN_RULES) {
		const owned = inputs.filter((path) => rule.matches(path));
		if (owned.length === 0) issues.push(`${rule.id}: computed repository scan is empty`);
		for (const root of rule.roots) {
			const rootPrefix = `${posix(root).replace(/\/$/, "")}/`;
			if (!owned.some((path) => path.startsWith(rootPrefix))) {
				issues.push(`${rule.id}: computed repository scan root is empty: ${root}`);
			}
		}
		for (const consumer of rule.consumers) {
			if (!testSet.has(consumer) && !isTombstoned(tombstones, consumer)) {
				issues.push(`${rule.id}: unit consumer is missing or not unit-owned: ${consumer}`);
			}
		}
	}
	return { inputs, issues };
}

/** Validate exact indirect reads before graph construction trusts the registry. */
export function validateIndirectRepositoryReadRegistry(
	repoRoot,
	unitTests,
	rules = INDIRECT_REPOSITORY_READ_RULES,
	tombstoneValues = [],
) {
	const testSet = new Set([...unitTests].map(posix));
	const tombstones = normalizedTombstones(tombstoneValues);
	const pairs = [];
	const issues = [];
	const ids = new Set();
	for (const rule of rules) {
		if (!rule?.id || ids.has(rule.id)) {
			issues.push(`${rule?.id || "(missing-id)"}: indirect repository read rule id is missing or duplicated`);
		} else {
			ids.add(rule.id);
		}
		const consumer = normalizedDeclaredPath(rule?.consumer);
		if (!consumer || (!testSet.has(consumer) && !isTombstoned(tombstones, consumer))) {
			issues.push(`${rule?.id || "(missing-id)"}: unit consumer is missing or not unit-owned: ${rule?.consumer}`);
		}
		if (!Array.isArray(rule?.inputs) || rule.inputs.length === 0) {
			issues.push(`${rule?.id || "(missing-id)"}: indirect repository input list is empty`);
			continue;
		}
		const seenInputs = new Set();
		for (const declaredInput of rule.inputs) {
			const input = normalizedDeclaredPath(declaredInput);
			if (!input) {
				issues.push(`${rule.id}: repository input is not a safe relative path: ${declaredInput}`);
				continue;
			}
			if (seenInputs.has(input)) {
				issues.push(`${rule.id}: duplicate repository input: ${input}`);
				continue;
			}
			seenInputs.add(input);
			if (!existsSync(join(repoRoot, ...input.split("/"))) && !isTombstoned(tombstones, input)) {
				issues.push(`${rule.id}: repository input is missing: ${input}`);
			}
			if (consumer) pairs.push({ ruleId: rule.id, consumer, input });
		}
	}
	return { pairs, issues };
}

const executableOperationKey = (kind, expression) => `${kind}\0${expression}`;

function executableOperationCounts(operations) {
	const counts = new Map();
	for (const operation of operations ?? []) {
		if (typeof operation?.kind !== "string" || typeof operation?.expression !== "string") continue;
		const key = executableOperationKey(operation.kind, operation.expression);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return counts;
}

/** Require every dynamically executable unit/E2E test operand to be reviewed. */
export function validateDynamicExecutableConsumerAudit(
	dynamicExecutableOperations,
	knownTests,
	declarationsByConsumer,
	audit = DYNAMIC_EXECUTABLE_CONSUMER_AUDIT,
) {
	const testSet = new Set([...knownTests].map(posix));
	const actual = new Map();
	for (const [consumerValue, operations] of dynamicExecutableOperations ?? []) {
		const consumer = posix(consumerValue);
		if (!testSet.has(consumer)) continue;
		const counts = executableOperationCounts(operations);
		if (counts.size > 0) actual.set(consumer, counts);
	}
	const issues = [];
	const auditedConsumers = new Set();
	for (const entry of audit) {
		const consumer = normalizedDeclaredPath(entry?.consumer);
		if (!consumer || !testSet.has(consumer)) {
			issues.push(`dynamic-executable audit consumer is missing or not Vitest-owned: ${entry?.consumer}`);
			continue;
		}
		if (auditedConsumers.has(consumer)) {
			issues.push(`${consumer}: duplicate dynamic-executable audit consumer`);
			continue;
		}
		auditedConsumers.add(consumer);
		const expected = new Map();
		for (const operation of entry?.operations ?? []) {
			const kind = typeof operation?.kind === "string" ? operation.kind : "";
			const expression = typeof operation?.expression === "string" ? operation.expression : "";
			const count = operation?.count;
			const declarations = Array.isArray(operation?.declarations) ? operation.declarations : [];
			const allowReason = typeof operation?.allowReason === "string" ? operation.allowReason.trim() : "";
			const key = executableOperationKey(kind, expression);
			if (!kind || !expression || !Number.isInteger(count) || count < 1 || expected.has(key)) {
				issues.push(`${consumer}: invalid or duplicate dynamic executable operation: ${kind}:${expression}`);
				continue;
			}
			if ((declarations.length > 0) === Boolean(allowReason)) {
				issues.push(`${consumer}: ${kind}:${expression} must have either declarations or one stable allow reason`);
			}
			if (allowReason && allowReason.length < 16) {
				issues.push(`${consumer}: dynamic executable allow reason is not descriptive: ${kind}:${expression}`);
			}
			const liveDeclarations = declarationsByConsumer?.get(consumer) ?? new Set();
			for (const declaration of declarations) {
				if (typeof declaration !== "string" || !liveDeclarations.has(declaration)) {
					issues.push(`${consumer}: dynamic executable declaration is not live: ${declaration}`);
				}
			}
			expected.set(key, count);
		}
		const observed = actual.get(consumer) ?? new Map();
		for (const [key, count] of expected) {
			if (observed.get(key) !== count) {
				const [kind, expression] = key.split("\0");
				issues.push(`${consumer}: audited dynamic executable operation changed: ${kind}:${expression} (expected ${count}, observed ${observed.get(key) ?? 0})`);
			}
		}
		for (const [key, count] of observed) {
			if (!expected.has(key)) {
				const [kind, expression] = key.split("\0");
				issues.push(`${consumer}: new dynamic executable operation requires audit: ${kind}:${expression} (${count})`);
			}
		}
	}
	for (const [consumer, operations] of actual) {
		if (!auditedConsumers.has(consumer)) {
			issues.push(`${consumer}: dynamic executable operations have no audit (${operations.size} unique)`);
		}
	}
	return { issues, auditedConsumers, actual };
}

function unresolvedReadCounts(reads) {
	const counts = new Map();
	for (const read of reads ?? []) {
		if (read?.status !== "unresolved" || typeof read.expression !== "string") continue;
		counts.set(read.expression, (counts.get(read.expression) ?? 0) + 1);
	}
	return counts;
}

/**
 * Require every unsupported unit-test read operand to be intentionally audited.
 * Repository reads must cite a live impact/scan/indirect/static declaration;
 * only generated test artifacts may use an allowReason.
 */
export function validateUnresolvedRepositoryReadAudit(
	unresolvedRepositoryReads,
	unitTests,
	declarationsByConsumer,
	audit = UNRESOLVED_REPOSITORY_READ_AUDIT,
) {
	const testSet = new Set([...unitTests].map(posix));
	const actual = new Map();
	for (const [consumerValue, reads] of unresolvedRepositoryReads ?? []) {
		const consumer = posix(consumerValue);
		if (!testSet.has(consumer)) continue;
		actual.set(consumer, unresolvedReadCounts(reads));
	}
	const issues = [];
	const auditedConsumers = new Set();
	for (const entry of audit) {
		const consumer = normalizedDeclaredPath(entry?.consumer);
		if (!consumer || !testSet.has(consumer)) {
			issues.push(`unresolved-read audit consumer is missing or not unit-owned: ${entry?.consumer}`);
			continue;
		}
		if (auditedConsumers.has(consumer)) {
			issues.push(`${consumer}: duplicate unresolved-read audit consumer`);
			continue;
		}
		auditedConsumers.add(consumer);
		const declarations = Array.isArray(entry?.declarations) ? entry.declarations : [];
		const allowReason = typeof entry?.allowReason === "string" ? entry.allowReason.trim() : "";
		const policyExemption = typeof entry?.policyExemption === "string" ? entry.policyExemption.trim() : "";
		if ((declarations.length > 0) === Boolean(allowReason)) {
			issues.push(`${consumer}: audit must have either declarations or one stable allow reason`);
		}
		if (policyExemption && (declarations.length === 0 || policyExemption.length < 24)) {
			issues.push(`${consumer}: unresolved-read policy exemption is not descriptive or declared`);
		}
		const liveDeclarations = declarationsByConsumer?.get(consumer) ?? new Set();
		for (const declaration of declarations) {
			if (typeof declaration !== "string" || !liveDeclarations.has(declaration)) {
				issues.push(`${consumer}: unresolved-read declaration is not live: ${declaration}`);
			}
		}
		if (allowReason && allowReason.length < 16) {
			issues.push(`${consumer}: generated-read allow reason is not descriptive`);
		}
		const expected = new Map();
		for (const read of entry?.reads ?? []) {
			if (typeof read?.expression !== "string"
				|| !Number.isInteger(read?.count)
				|| read.count < 1
				|| expected.has(read.expression)) {
				issues.push(`${consumer}: invalid or duplicate audited unresolved read: ${read?.expression}`);
				continue;
			}
			expected.set(read.expression, read.count);
		}
		const observed = actual.get(consumer) ?? new Map();
		for (const [expression, count] of expected) {
			if (observed.get(expression) !== count) {
				issues.push(`${consumer}: audited unresolved read changed: ${expression} (expected ${count}, observed ${observed.get(expression) ?? 0})`);
			}
		}
		for (const [expression, count] of observed) {
			if (!expected.has(expression)) {
				issues.push(`${consumer}: new unresolved repository read requires audit: ${expression} (${count})`);
			}
		}
	}
	for (const [consumer, reads] of actual) {
		if (!auditedConsumers.has(consumer)) {
			issues.push(`${consumer}: unresolved repository reads have no audit (${reads.size} unique)`);
		}
	}
	return { issues, auditedConsumers, actual };
}

/**
 * Return actionable inventory defects. Callers decide whether to throw; keeping
 * this pure makes the rule registry independently testable.
 */
export function validateImpactInventory(repoRoot, unitTests, tombstoneValues = []) {
	const testSet = unitTests instanceof Set ? unitTests : new Set(unitTests);
	const tombstones = normalizedTombstones(tombstoneValues);
	const inputs = inventoryShippedInputs(repoRoot, tombstones.values());
	const issues = [];
	for (const input of inputs) {
		const family = SHIPPED_INPUT_FAMILIES.find((candidate) => candidate.qualifies(input));
		const rules = impactRulesForPath(input);
		if (!family) {
			issues.push(`${input}: shipped input has no declared impact family`);
		} else if (!rules.some((rule) => rule.id === family.id)) {
			issues.push(`${input}: shipped input has no ${family.id} impact rule`);
		}
	}
	for (const family of SHIPPED_INPUT_FAMILIES) {
		const familyInputs = inputs.filter((path) => family.qualifies(path));
		if (familyInputs.length === 0) issues.push(`${family.id}: shipped input family is empty`);
		const rule = IMPACT_RULES.find((candidate) => candidate.id === family.id);
		if (!rule) {
			issues.push(`${family.id}: impact rule is missing`);
			continue;
		}
		const consumers = rule.canaries.filter((path) => testSet.has(path));
		if (consumers.length === 0 && !rule.canaries.some((path) => isTombstoned(tombstones, path))) {
			issues.push(`${family.id}: no authoritative unit canary exists`);
		}
		for (const owner of rule.owners) {
			if (!existsSync(join(repoRoot, ...owner.split("/"))) && !isTombstoned(tombstones, owner)) {
				issues.push(`${family.id}: production owner is missing: ${owner}`);
			}
		}
		for (const canary of rule.canaries) {
			if (!testSet.has(canary) && !isTombstoned(tombstones, canary)) {
				issues.push(`${family.id}: unit canary is missing or not unit-owned: ${canary}`);
			}
		}
	}
	return { inputs, issues };
}
