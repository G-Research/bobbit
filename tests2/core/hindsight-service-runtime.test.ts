import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import YAML from "yaml";
import { parseServiceManifest } from "../../src/server/service-runtime/service-manifest.js";

import provider, {
  __setClientFactory,
} from "../../market-packs/hindsight/src/provider.ts";
import { routes } from "../../market-packs/hindsight/src/routes.ts";
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
});
