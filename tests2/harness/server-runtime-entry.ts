// Umbrella entry in the content-addressed, split server prebundle. Direct
// src/server entries and this namespace facade share emitted chunks, preserving
// stateful module identity across gateway fixtures and direct tier-1 imports.
export * as server from "../../src/server/server.js";
export * as gatewayDeps from "../../src/server/gateway-deps.js";
export * as aigwManager from "../../src/server/agent/aigw-manager.js";
export * as bobbitDir from "../../src/server/bobbit-dir.js";
export * as scaffold from "../../src/server/scaffold.js";
export * as authToken from "../../src/server/auth/token.js";
export * as oauth from "../../src/server/auth/oauth.js";
export * as packStore from "../../src/server/extension-host/pack-store.js";
export * as costTracker from "../../src/server/agent/cost-tracker.js";
export * as sessionManager from "../../src/server/agent/session-manager.js";
export * as sandboxToken from "../../src/server/auth/sandbox-token.js";
export * as gateDiagnosticsCleanup from "../../src/server/agent/gate-diagnostics-cleanup.js";
export * as serverHostApi from "../../src/server/extension-host/server-host-api.js";
export * as dockerArgs from "../../src/server/agent/docker-args.js";
export * as rpcBridge from "../../src/server/agent/rpc-bridge.js";
export * as sessionStore from "../../src/server/agent/session-store.js";
export * as deletionTombstones from "../../src/server/agent/deletion-tombstones.js";
export * as gateStore from "../../src/server/agent/gate-store.js";
export * as gateVerificationSnapshot from "../../src/server/gate-verification-snapshot.js";
export * as verificationHarness from "../../src/server/agent/verification-harness.js";
export * as projectRegistry from "../../src/server/agent/project-registry.js";
export * as titleGenerator from "../../src/server/agent/title-generator.js";
export * as mcpManager from "../../src/server/mcp/mcp-manager.js";
export * as sandboxGuard from "../../src/server/auth/sandbox-guard.js";
export * as resolveSkillExpansions from "../../src/server/skills/resolve-skill-expansions.js";
export * as slashSkills from "../../src/server/skills/slash-skills.js";
export * as skillManifest from "../../src/server/skills/skill-manifest.js";
export * as staffManager from "../../src/server/agent/staff-manager.js";
export * as compactionSidecar from "../../src/server/agent/compaction-sidecar.js";
export * as profiling from "../../src/server/agent/profiling.js";
