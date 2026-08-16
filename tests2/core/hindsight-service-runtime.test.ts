import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";
import { parseServiceManifest } from "../../src/server/service-runtime/service-manifest.js";
import { loadPackContributions } from "../../src/server/agent/pack-contributions.js";
import { HindsightRuntimeBridge, type HindsightRuntimeSettingsResolver } from "../../src/server/agent/hindsight-runtime-bridge.js";
import { ExtensionSettingsSecretStore } from "../../src/server/agent/extension-settings-secret-store.js";
import { ExtensionSettingsStore } from "../../src/server/agent/extension-settings-store.js";
import { ProjectConfigStore } from "../../src/server/agent/project-config-store.js";
import { SecretsStore } from "../../src/server/agent/secrets-store.js";
import { ServiceRuntimeStore, ServiceRuntimeSupervisor, type ServiceRunner } from "../../src/server/service-runtime/index.js";
import { ComposeServiceRunner } from "../../src/server/service-runtime/service-runners.js";

import provider, {
  __setClientFactory,
} from "../../market-packs/hindsight/src/provider.ts";
import { routes } from "../../market-packs/hindsight/src/routes.ts";
import { createClient } from "../../market-packs/hindsight/src/hindsight-client.ts";
import {
  clientConfig,
  isActive,
  resolveConfig,
  runtimeModeFor,
  type ClientConfig,
  type RuntimeContext,
  type StoreReadResult,
} from "../../market-packs/hindsight/src/shared.ts";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const endpoint = "http://127.0.0.1:49152";
const authoritativeScopeContext = {
  project: { id: "runtime-project" },
  goal: { id: "runtime-goal" },
};

/** Direct provider fixtures must model the host's live EP-6 allowance. */
const liveMemoryGrant = { requireCapability: () => undefined };

function store() {
  const values = new Map<string, unknown>();
  return {
    get: async <T = unknown>(key: string): Promise<T | null> =>
      values.has(key) ? (structuredClone(values.get(key)) as T) : null,
    read: async <T = unknown>(key: string): Promise<StoreReadResult<T>> =>
      values.has(key)
        ? { state: "present", value: structuredClone(values.get(key)) as T }
        : { state: "absent" },
    put: async <T = unknown>(key: string, value: T): Promise<void> => {
      values.set(key, structuredClone(value));
    },
  };
}

function readyRuntime(): RuntimeContext {
  return { state: "ready", endpoint };
}

function fakeClient() {
  return {
    health: async () => ({ ok: true }),
    ensureBank: async () => {},
    recall: async () => ({ memories: [{ text: "same endpoint contract" }] }),
    retain: async () => {},
    reflect: async () => ({ text: "reflection" }),
    listBanks: async () => ({ banks: ["bobbit"] }),
  };
}

describe("Hindsight generic runtime linkage", () => {
  it("uses one endpoint client contract for external, local, Docker, and Compose", async () => {
    const seen: ClientConfig[] = [];
    __setClientFactory((cfg) => {
      seen.push(cfg);
      return fakeClient();
    });
    try {
      const variants: Array<{ config: Record<string, unknown>; runtime?: RuntimeContext }> = [
        { config: { runtimeMode: "external", externalUrl: endpoint } },
        { config: { runtimeMode: "local" as const }, runtime: readyRuntime() },
        { config: { runtimeMode: "docker" as const }, runtime: readyRuntime() },
        {
          config: { runtimeMode: "compose" as const },
          runtime: readyRuntime(),
        },
      ];

      for (const variant of variants) {
        const result = await provider.beforePrompt({
          config: {
            ...variant.config,
            bank: "bobbit",
            namespace: "default",
            autoRecall: true,
            autoRetain: true,
            recallBudget: 1200,
            timeoutMs: 1500,
          },
          runtime: variant.runtime,
          prompt: "does every adapter use this endpoint?",
          host: { store: store(), memory: liveMemoryGrant },
          scopeContext: authoritativeScopeContext,
        } as never);
        assert.equal(result.blocks[0]?.content, "- same endpoint contract");
      }

      assert.deepEqual(
        seen,
        Array.from({ length: 4 }, () => ({
          baseUrl: endpoint,
          namespace: "default",
          timeoutMs: 1500,
        })),
      );
      assert.equal(
        runtimeModeFor({ runtimeMode: "external" } as never),
        undefined,
      );
      assert.equal(runtimeModeFor({ runtimeMode: "local" } as never), "local");
      assert.equal(
        runtimeModeFor({ runtimeMode: "docker" } as never),
        "docker",
      );
      assert.equal(
        runtimeModeFor({ runtimeMode: "compose" } as never),
        "compose",
      );
    } finally {
      __setClientFactory(null);
    }
  });

  it("keeps the external bearer out of managed local, Docker, and Compose requests", async () => {
    const authorization: Array<string | undefined> = [];
    const server = http.createServer((request, response) => {
      authorization.push(request.headers.authorization);
      response.statusCode = 204;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const apiKey = "external-bearer-must-not-reach-managed-runtime";
    try {
      const external = resolveConfig({ runtimeMode: "external", externalUrl: url, apiKey });
      assert.equal(external.apiKey, apiKey, "the stored external credential remains available for external mode");
      await createClient(clientConfig(external)).ensureBank("bobbit");

      for (const runtimeMode of ["local", "docker", "compose"] as const) {
        const managed = resolveConfig({ runtimeMode, apiKey });
        assert.equal(managed.apiKey, apiKey, `${runtimeMode} retains the write-only setting without repurposing it`);
        const config = clientConfig(managed, { state: "ready", endpoint: url });
        assert.equal("apiKey" in config, false, `${runtimeMode} client configuration excludes the external bearer`);
        await createClient(config).ensureBank("bobbit");
      }
      assert.deepEqual(authorization, [`Bearer ${apiKey}`, undefined, undefined, undefined]);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps unavailable runtime reads dormant without constructing a client", async () => {
    let clientCalls = 0;
    __setClientFactory(() => {
      clientCalls++;
      return fakeClient();
    });
    try {
      for (const state of [
        "stopped",
        "starting",
        "degraded",
        "blocked",
        "unavailable",
      ] as const) {
        const runtime: RuntimeContext = {
          state,
          diagnostic: { code: "SERVICE_DOWN" },
        };
        assert.equal(
          isActive({ runtimeMode: "docker" } as never, runtime),
          false,
        );
        assert.deepEqual(
          await provider.beforePrompt({
            config: { runtimeMode: "docker", autoRecall: true },
            runtime,
            prompt: "do not start a service",
            host: { store: store() },
            scopeContext: authoritativeScopeContext,
          } as never),
          { blocks: [] },
        );
      }

      const persisted = store();
      await persisted.put("provider-config:memory", { runtimeMode: "compose" });
      const status = (await routes.status({
        host: { store: persisted },
        runtime: {
          state: "degraded",
          diagnostic: { code: "SERVICE_HEALTH_TIMEOUT" },
        },
      } as never)) as { configured: boolean; healthy: boolean };
      assert.deepEqual(status, {
        configured: true,
        runtimeMode: "compose",
        bank: "bobbit",
        namespace: "default",
        recallScope: "project",
        autoRecall: true,
        autoRetain: true,
        queueDepth: 0,
        queueState: "available",
        healthy: false,
      });
      assert.equal(clientCalls, 0);
    } finally {
      __setClientFactory(null);
    }
  });

  it("starts the shipping descriptor with the project SecretsStore in every managed mode and reconciles only desired runtimes", async () => {
    const packRoot = path.join(root, "market-packs/hindsight");
    const contributions = loadPackContributions(
      packRoot,
      YAML.parse(fs.readFileSync(path.join(packRoot, "pack.yaml"), "utf8")),
    );
    const runtime = contributions.runtimes.find((candidate) => candidate.id === "hindsight");
    const memoryProvider = contributions.providers.find((candidate) => candidate.id === "memory");
    assert.ok(runtime, "the shipping runtime descriptor must load through the production contribution loader");
    assert.ok(memoryProvider, "the shipping provider must link to the runtime descriptor");
    const shippingRuntime = runtime;

    for (const mode of ["local", "docker", "compose"] as const) {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), `hindsight-runtime-${mode}-`));
      try {
        const projectId = `shipping-${mode}`;
        const settingsStore = new ExtensionSettingsStore(
          new ProjectConfigStore(path.join(directory, "config")),
          new ExtensionSettingsSecretStore(path.join(directory, "settings-secrets")),
        );
        settingsStore.compareAndSwap(
          { packId: "hindsight", kind: "provider", id: "memory" },
          0,
          {
            values: {
              runtimeMode: mode,
              databaseMode: mode === "compose" ? "managed-volume" : "external",
              localLlmProvider: "openai-compatible",
              localLlmModelId: "qwen3-coder",
              localLlmBaseUrl: "http://127.0.0.1:11434/v1",
              localLlmContextTokens: 32768,
              localLlmMaxOutputTokens: 4096,
              localLlmResidency: "resident",
              localLlmKeepAlive: 3600,
            },
            ...(mode === "compose" ? {} : { secrets: { externalDatabaseUrl: `postgresql://hindsight:external-${mode}@db.example/hindsight` } }),
          },
        );

        // This is the same structural composition used by createGateway: the
        // generic store owns its collision-safe key while ProjectContext owns
        // durable secret bytes. No secret ever reaches a settings projection.
        const secretsStore = new SecretsStore(path.join(directory, "state"));
        const store = new ServiceRuntimeStore({
          stateDir: path.join(directory, "state"),
          serverIdentity: "shipping-server",
          generatedSecrets: secretsStore,
          generateSecret: () => `generated-${mode}-database-password`,
        });
        let starts = 0;
        let inspections = 0;
        const passwords: string[] = [];
        const fakeRunner: ServiceRunner = {
          mode,
          async start(input) {
            starts++;
            const password = input.environment.HINDSIGHT_DB_PASSWORD;
            assert.equal(typeof password, "string");
            assert.ok(password.length > 0, "generated password reaches the selected runner");
            passwords.push(password);
            input.onOutput?.(`HINDSIGHT_DB_PASSWORD=${password}`);
            return {
              endpoint: `http://127.0.0.1:${49000 + starts}`,
              runnerIdentity: { kind: mode, id: `${mode}-${starts}` },
              services: [],
            };
          },
          async inspect() {
            inspections++;
            return {
              endpoint: "http://127.0.0.1:49001",
              runnerIdentity: { kind: mode, id: `${mode}-survived` },
              services: [],
            };
          },
          async stop() {},
          async remove() {},
        };
        const bridge: HindsightRuntimeBridge = new HindsightRuntimeBridge({
          contributions: {
            getPack: () => contributions,
          },
          contextForProject: () => ({ stateDir: path.join(directory, "state"), extensionSettingsStore: settingsStore }),
          grants: () => ({ allowed: true }) as never,
          supervisorForProject: (_id: string, settings: HindsightRuntimeSettingsResolver): ServiceRuntimeSupervisor => new ServiceRuntimeSupervisor({
            registry: { getRuntime: () => shippingRuntime },
            store,
            runners: [fakeRunner],
            authorizer: { authorize: () => true },
            settings,
            serverIdentity: "shipping-server",
            probe: async () => true,
          }),
        });

        const started = await bridge.control(projectId, "start");
        const generatedPassword = `generated-${mode}-database-password`;
        assert.equal(secretsStore.get("service-runtime:hindsight:hindsight:databasePassword"), generatedPassword);
        assert.equal(passwords[0], generatedPassword);
        assert.ok(!JSON.stringify(started).includes(generatedPassword), "control/status responses remain redacted");

        await new Promise<void>((resolve) => setImmediate(resolve));
        const logs = await store.readLog({ packId: "hindsight", runtimeId: "hindsight" });
        assert.ok(logs?.includes("[REDACTED]"));
        assert.ok(!logs?.includes(generatedPassword));

        await bridge.reconcile(projectId);
        assert.deepEqual(passwords, mode === "local" ? [generatedPassword, generatedPassword] : [generatedPassword]);
        assert.equal(inspections, mode === "local" ? 0 : 1, "Docker and Compose preserve by inspection; local restarts");

        await bridge.control(projectId, "stop");
        await bridge.reconcile(projectId);
        assert.equal(starts, mode === "local" ? 2 : 1, "desired:stopped stays inert during startup reconciliation");
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("declares the strict schema-2 descriptor and a read-only provider runtime", () => {
    const descriptorPath = path.join(root, "market-packs/hindsight/runtimes/hindsight.yaml");
    const manifest = YAML.parse(fs.readFileSync(descriptorPath, "utf8"));
    const runtimeManifest = parseServiceManifest(manifest, {
      packRoot: path.join(root, "market-packs/hindsight"),
      sourceFile: descriptorPath,
    });
    assert.ok(runtimeManifest, "the shipped descriptor must resolve under its own source directory");
    assert.deepEqual(manifest.endpoint, {
      protocol: "http",
      servicePort: 8888,
      health: {
        path: "/health",
        expectedStatus: 200,
        requestTimeoutMs: 1500,
        intervalMs: 1000,
        startupTimeoutMs: 120000,
      },
    });
    assert.deepEqual(manifest.lifecycle.restart, {
      policy: "on-failure",
      maxAttempts: 3,
      windowMs: 300000,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
    });
    assert.deepEqual(manifest.environment.HINDSIGHT_API_PORT, {
      endpointPort: true,
    });
    assert.equal("storage" in manifest, false, "Compose storage is owned by its durable named volume or a configured external database, never a host path descriptor");
    assert.deepEqual(Object.keys(manifest.modes).sort(), [
      "compose",
      "docker",
      "local",
    ]);

    const providerDeclaration = YAML.parse(
      fs.readFileSync(
        path.join(root, "market-packs/hindsight/providers/memory.yaml"),
        "utf8",
      ),
    );
    assert.equal(providerDeclaration.runtime, "hindsight");
    assert.deepEqual(providerDeclaration.config.runtimeMode.values, [
      "external",
      "local",
      "docker",
      "compose",
    ]);
    assert.equal("llmApiKey" in providerDeclaration.config, false, "managed runtime secrets must not enter ordinary provider config");
    assert.deepEqual(manifest.environment.HINDSIGHT_API_LLM_API_KEY, { secret: "localLlmApiKey", optional: true }, "loopback model starts do not require a placeholder key");
    assert.deepEqual(manifest.environment.HINDSIGHT_API_DATABASE_URL, { secret: "externalDatabaseUrl", optional: true }, "managed-volume starts do not require an external database secret");
    assert.deepEqual(providerDeclaration.config.localLlmResidency.values, ["resident"], "request-scoped model residency is unsupported");
    const projected = resolveConfig({ llmApiKey: "must-not-reach-provider" });
    assert.equal("llmApiKey" in projected, false, "legacy ordinary config never reaches the provider/client contract");

    const composePath = path.resolve(path.dirname(descriptorPath), runtimeManifest.modes.compose.file);
    assert.equal(composePath, path.join(root, "market-packs/hindsight/runtime/compose.yaml"));
    assert.ok(fs.existsSync(composePath), "the descriptor-selected Compose asset must exist");
    const compose = fs.readFileSync(composePath, "utf8");
    assert.match(compose, /127\.0\.0\.1::8888/);
    assert.match(compose, /restart: "no"/);
    assert.match(compose, /hindsight-postgres:\/var\/lib\/postgresql\/data/, "Compose owns PostgreSQL through a durable named volume");
    assert.match(compose, /HINDSIGHT_API_LLM_API_KEY:-/, "Compose gives the optional LLM secret an explicit empty fallback");
    assert.match(compose, /HINDSIGHT_API_DATABASE_URL:-postgresql:\/\/hindsight:\$\{HINDSIGHT_DB_PASSWORD\}@db:5432\/hindsight/, "Compose falls back to its durable named-volume database when the external secret is absent");
    assert.doesNotMatch(compose, /^\s*-\s*[^#\n]*pg0[^#\n]*:/m, "Compose must never bind-mount the live legacy pg0 directory");
    const source = fs.readFileSync(
      path.join(root, "market-packs/hindsight/src/shared.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      source,
      /service-supervisor|ServiceRuntimeSupervisor|dockerode|execa/,
    );
    assert.deepEqual(
      clientConfig(
        {
          runtimeMode: "local",
          namespace: "default",
          timeoutMs: 1500,
        } as never,
        readyRuntime(),
      ),
      {
        baseUrl: endpoint,
        namespace: "default",
        timeoutMs: 1500,
      },
    );
  });

  it("validates Hindsight's optional database fallback and its nested generated password", async () => {
    const descriptorPath = path.join(root, "market-packs/hindsight/runtimes/hindsight.yaml");
    const manifest = parseServiceManifest(YAML.parse(fs.readFileSync(descriptorPath, "utf8")), {
      packRoot: path.join(root, "market-packs/hindsight"),
      sourceFile: descriptorPath,
    });
    assert.ok(manifest);
    const environment = Object.fromEntries(Object.entries(manifest.environment).flatMap(([name, source]) => {
      if ("secret" in source && source.optional) return [];
      if ("value" in source) return [[name, source.value]];
      if ("endpointPort" in source) return [[name, String(manifest.endpoint.servicePort)]];
      if ("generatedSecret" in source) return [[name, "generated-password"]];
      return [[name, name === "HINDSIGHT_OCI_IMAGE" ? manifest.modes.docker.image : "configured"]];
    }));
    const envDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bobbit-hindsight-compose-"));
    const envFile = path.join(envDirectory, "runtime.env");
    fs.writeFileSync(envFile, "# owner-only test environment\n", { mode: 0o600 });
    fs.chmodSync(envFile, 0o600);
    let call = 0;
    const runner = new ComposeServiceRunner({
      execute: () => Promise.resolve(call++ === 0
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: "127.0.0.1:43123", stderr: "", exitCode: 0 }) as never,
    });
    try {
      const started = await runner.start({
        manifest,
        mode: "compose",
        packRoot: path.join(root, "market-packs/hindsight"),
        descriptorDir: path.dirname(descriptorPath),
        serverIdentity: "test-server",
        serviceIdentity: "hindsight:test",
        packId: "hindsight",
        environment,
        envFile,
      });
      assert.equal(started.endpoint, "http://127.0.0.1:43123");
    } finally {
      fs.rmSync(envDirectory, { recursive: true, force: true });
    }
  });
});
