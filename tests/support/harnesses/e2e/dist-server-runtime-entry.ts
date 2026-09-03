// Umbrella entry for the run-owned Group B compiled-dist prebundle. Every
// production import eligible for bundled E2E execution must route through one
// of these namespaces so stateful server modules retain one identity per worker.
export * as server from "../../../../dist/server/server.js";
export * as bobbitDir from "../../../../dist/server/bobbit-dir.js";
export * as scaffold from "../../../../dist/server/scaffold.js";
export * as authToken from "../../../../dist/server/auth/token.js";
export * as rpcBridge from "../../../../dist/server/agent/rpc-bridge.js";
export * as bgProcessManager from "../../../../dist/server/agent/bg-process-manager.js";
export * as modelRegistry from "../../../../dist/server/agent/model-registry.js";
export * as modelCompletion from "../../../../dist/server/agent/model-completion.js";
export * as preferencesStore from "../../../../dist/server/agent/preferences-store.js";
export * as hostTokens from "../../../../dist/server/agent/host-tokens.js";
export * as sessionManager from "../../../../dist/server/agent/session-manager.js";
export * as credentialStore from "../../../../dist/server/auth/credential-store.js";
export * as serverHostApi from "../../../../dist/server/extension-host/server-host-api.js";
export * as moduleHostWorker from "../../../../dist/server/extension-host/module-host-worker.js";
export * as packStore from "../../../../dist/server/extension-host/pack-store.js";
export * as toolActivation from "../../../../dist/server/agent/tool-activation.js";
export * as providerBridgeExtension from "../../../../dist/server/agent/provider-bridge-extension.js";
export * as dockerArgs from "../../../../dist/server/agent/docker-args.js";
export * as projectSandbox from "../../../../dist/server/agent/project-sandbox.js";
export * as git from "../../../../dist/server/skills/git.js";
export * as worktreePaths from "../../../../dist/server/skills/worktree-paths.js";
