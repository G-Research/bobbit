import createFileExplorerPanel from "../../../market-packs/file-explorer/src/file-explorer-panel.ts";

type Entry = { path: string; name: string; kind: "directory" | "file" | "symlink" | "other"; virtual?: boolean };
type RouteInit = { body?: Record<string, unknown> };

const entriesByParent: Record<string, Entry[]> = {
  "": [
    { path: "docs", name: "docs", kind: "directory" },
    { path: "public", name: "public", kind: "directory" },
    { path: "src", name: "src", kind: "directory" },
    { path: ".gitignore", name: ".gitignore", kind: "file" },
    { path: "package.json", name: "package.json", kind: "file" },
    { path: "README.md", name: "README.md", kind: "file" },
    { path: "vite.config.ts", name: "vite.config.ts", kind: "file" },
  ],
  docs: [
    { path: "docs/design", name: "design", kind: "directory" },
    { path: "docs/file-explorer.md", name: "file-explorer.md", kind: "file" },
    { path: "docs/marketplace.md", name: "marketplace.md", kind: "file" },
  ],
  "docs/design": [
    { path: "docs/design/extension-host.md", name: "extension-host.md", kind: "file" },
  ],
  public: [
    { path: "public/favicon.svg", name: "favicon.svg", kind: "file" },
  ],
  src: [
    { path: "src/app", name: "app", kind: "directory" },
    { path: "src/server", name: "server", kind: "directory" },
    { path: "src/shared", name: "shared", kind: "directory" },
    { path: "src/ui", name: "ui", kind: "directory" },
  ],
  "src/app": [
    { path: "src/app/file-explorer.ts", name: "file-explorer.ts", kind: "file" },
    { path: "src/app/main.ts", name: "main.ts", kind: "file" },
    { path: "src/app/state.ts", name: "state.ts", kind: "file" },
  ],
  "src/server": [
    { path: "src/server/agent", name: "agent", kind: "directory" },
    { path: "src/server/routes.ts", name: "routes.ts", kind: "file" },
    { path: "src/server/server.ts", name: "server.ts", kind: "file" },
  ],
  "src/server/agent": [
    { path: "src/server/agent/session-manager.ts", name: "session-manager.ts", kind: "file" },
  ],
  "src/shared": [
    { path: "src/shared/extension-host.ts", name: "extension-host.ts", kind: "file" },
  ],
  "src/ui": [
    { path: "src/ui/app.css", name: "app.css", kind: "file" },
  ],
};

const statuses = [
  {
    path: "src/app/file-explorer.ts", index: " ", worktree: "M", summary: "modified",
    staged: false, unstaged: true, modified: true, added: false, deleted: false,
    renamed: false, copied: false, conflict: false, untracked: false,
  },
  {
    path: "src/server/routes.ts", index: "A", worktree: " ", summary: "added",
    staged: true, unstaged: false, modified: false, added: true, deleted: false,
    renamed: false, copied: false, conflict: false, untracked: false,
  },
  {
    path: "README.md", index: "M", worktree: " ", summary: "modified",
    staged: true, unstaged: false, modified: true, added: false, deleted: false,
    renamed: false, copied: false, conflict: false, untracked: false,
  },
  {
    path: "docs/legacy.md", index: " ", worktree: "D", summary: "deleted",
    staged: false, unstaged: true, modified: false, added: false, deleted: true,
    renamed: false, copied: false, conflict: false, untracked: false,
  },
];

const contents: Record<string, string> = {
  "src/app/file-explorer.ts": `import type { HostApi } from "../shared/extension-host.js";

export interface ExplorerOptions {
  sessionId: string;
  showChangedOnly?: boolean;
}

export async function openExplorer(host: HostApi, options: ExplorerOptions) {
  const result = await host.callRoute("list", {
    method: "POST",
    body: { path: "", includeStatus: true },
  });

  return {
    ...result,
    sessionId: options.sessionId,
    readOnly: true,
  };
}
`,
  "src/server/routes.ts": `export const routes = {
  list: async (_ctx, request) => ({
    ok: true,
    value: await listDirectory(request.body.path),
  }),
};
`,
  "README.md": `# Bobbit\n\nA remote coding agent gateway with persistent sessions and extension-host panels.\n`,
  "package.json": `{
  "name": "@gresearch/bobbit",
  "scripts": {
    "dev:harness": "node dist/server/harness.js",
    "build:packs": "node scripts/build-market-packs.mjs"
  }
}
`,
  "docs/file-explorer.md": `# Built-in file explorer\n\nThe explorer is a read-only side panel for inspecting session files.\n`,
  "vite.config.ts": `import { defineConfig } from "vite";\n\nexport default defineConfig({ server: { port: 5173 } });\n`,
};

const diffs: Record<string, string> = {
  "src/app/file-explorer.ts": `diff --git a/src/app/file-explorer.ts b/src/app/file-explorer.ts
index 930c1a1..42a57d0 100644
--- a/src/app/file-explorer.ts
+++ b/src/app/file-explorer.ts
@@ -4,6 +4,7 @@ export interface ExplorerOptions {
   sessionId: string;
+  showChangedOnly?: boolean;
 }
 
 export async function openExplorer(host: HostApi, options: ExplorerOptions) {
@@ -13,5 +14,6 @@ export async function openExplorer(host: HostApi, options: ExplorerOptions) {
     ...result,
     sessionId: options.sessionId,
+    readOnly: true,
   };
 }
`,
  "src/server/routes.ts": `diff --git a/src/server/routes.ts b/src/server/routes.ts
new file mode 100644
--- /dev/null
+++ b/src/server/routes.ts
@@ -0,0 +1,6 @@
+export const routes = {
+  list: async (_ctx, request) => ({
+    ok: true,
+    value: await listDirectory(request.body.path),
+  }),
+};
`,
};

const allEntries = [...new Map(Object.values(entriesByParent).flat().map((entry) => [entry.path, entry])).values()];
const entryByPath = new Map(allEntries.map((entry) => [entry.path, entry]));
const stored = new Map<string, unknown>([[
  "ui/file-explorer-preview",
  {
    version: 1,
    expanded: ["src", "src/app"],
    selected: "src/app/file-explorer.ts",
    focused: "src/app/file-explorer.ts",
    view: "file",
    changedOnly: false,
  },
]]);

function chainFor(path: string): Entry[] {
  if (!path) return [];
  const parts = path.split("/");
  const chain: Entry[] = [];
  for (let index = 1; index <= parts.length; index += 1) {
    const entry = entryByPath.get(parts.slice(0, index).join("/"));
    if (entry) chain.push(entry);
  }
  return chain;
}

function routeValue(value: unknown) {
  return Promise.resolve({ ok: true, value });
}

const host = {
  capabilities: { callRoute: true, session: true, store: true },
  store: {
    async read(key: string) {
      return stored.has(key)
        ? { state: "present" as const, value: stored.get(key) }
        : { state: "absent" as const };
    },
    async get(key: string) { return stored.get(key) ?? null; },
    async put(key: string, value: unknown) { stored.set(key, value); },
  },
  session: {
    subscribe(_event: "status", _callback: (value: { status: "idle" | "running" | "error" }) => void) {
      return () => undefined;
    },
  },
  callRoute(route: string, init?: RouteInit) {
    const body = init?.body ?? {};
    if (route === "list") {
      const path = typeof body.path === "string" ? body.path : "";
      return routeValue({
        path,
        rootPath: "C:\\Users\\jsubr\\w\\bobbit",
        entries: entriesByParent[path] ?? [],
        truncated: false,
        ...(body.includeStatus === true
          ? {
              status: {
                kind: "git",
                head: "present",
                files: statuses,
                ancestors: ["docs", "src", "src/app", "src/server"],
                virtualEntries: [{ path: "docs/legacy.md", name: "legacy.md", kind: "file", virtual: true }],
              },
            }
          : {}),
      });
    }
    if (route === "resolve") {
      const path = typeof body.path === "string" ? body.path : "";
      if (!path) return routeValue({ path: "", kind: "root", chain: [] });
      const entry = entryByPath.get(path) ?? (path === "docs/legacy.md"
        ? { path, name: "legacy.md", kind: "file" as const, virtual: true }
        : undefined);
      if (!entry) return Promise.resolve({ ok: false, error: { code: "NOT_FOUND", message: "This item no longer exists.", retryable: false } });
      return routeValue({ path, kind: entry.kind, chain: chainFor(path) });
    }
    if (route === "search") {
      const query = String(body.query ?? "").trim().toLowerCase();
      const results = allEntries.filter((entry) => entry.path.toLowerCase().includes(query));
      return routeValue({ query, results, count: results.length, limit: 200, truncated: false });
    }
    if (route === "read") {
      const path = String(body.path ?? "");
      const text = contents[path] ?? `// Preview fixture for ${path}\n`;
      return routeValue({ path, kind: "text", text, bytes: new TextEncoder().encode(text).byteLength, limit: 1024 * 1024 });
    }
    if (route === "diff") {
      const path = String(body.path ?? "");
      if (path === "docs/legacy.md") {
        const text = `diff --git a/docs/legacy.md b/docs/legacy.md\ndeleted file mode 100644\n--- a/docs/legacy.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-# Legacy notes\n`;
        return routeValue({ path, kind: "deleted", text, bytes: text.length, limit: 500 * 1024 });
      }
      const text = diffs[path] ?? "";
      return routeValue({ path, kind: text ? "text" : "empty", text, bytes: text.length, limit: 500 * 1024 });
    }
    return Promise.resolve({ ok: false, error: { code: "READ_FAILED", message: `Unknown preview route: ${route}`, retryable: false } });
  },
};

const root = document.getElementById("root");
if (!root) throw new Error("Missing preview root");
const panel = createFileExplorerPanel();
const content = panel.render({ __sessionId: "file-explorer-preview" }, host);
root.replaceChildren(content as Node);
