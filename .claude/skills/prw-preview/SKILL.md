---
name: prw-preview
description: Bring up a like-for-like PR Walkthrough panel preview using the exact pack source and Bobbit theme bridge
argument-hint: [mock scenario or PR title]
allowed-tools: read, write, edit, bash, preview_open, browser_navigate, browser_wait, browser_screenshot, browser_eval
---

# PR Walkthrough Like-for-Like Preview

Create a live preview of the PR Walkthrough panel that is faithful enough for layout iteration.

## Non-negotiables

- Import the exact source: `market-packs/pr-walkthrough/src/panel.js`.
- Do **not** copy panel HTML by hand.
- Do **not** define `--background`, `--card`, `--primary`, or any other theme variables in the preview HTML.
- Use Bobbit `preview_open(file=..., assets=["bundle.js"])` so the preview iframe gets the real theme bridge.
- If taking screenshots, prefer the in-app preview iframe. Standalone `file://` or local HTTP screenshots do not prove theme parity.
- The mock `recover` route must return `found: true` **and** a YAML payload, or the real panel will correctly render the missing state.

## Steps

1. Create a temporary preview directory:

```bash
mkdir -p .bobbit/tmp/prw-preview
```

2. Write `.bobbit/tmp/prw-preview/index.html` with no custom palette:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR Walkthrough Preview</title>
  <style>
    html, body, #root { height: 100%; margin: 0; }
    body {
      background: var(--background);
      color: var(--foreground);
      overflow: hidden;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./bundle.js"></script>
</body>
</html>
```

3. Write `.bobbit/tmp/prw-preview/entry.ts` that imports the exact source panel:

```ts
import { html, nothing, render } from "lit";
import createPanel from "../../../market-packs/pr-walkthrough/src/panel.js";

const panel = createPanel({ html, nothing, renderHeader: () => nothing });
const root = () => document.getElementById("root");
let currentParams: any = {};
let currentHost: any;
let renderQueued = false;
const hostStoreData = new Map<string, unknown>();

const READY_YAML = `schema_version: 1
pr:
  provider: github
  owner: SuuBro
  repo: bobbit
  number: 42
  title: Fix terminal reattach
  url: https://github.com/SuuBro/bobbit/pull/42
  base_sha: 135c5ef1234567890
  head_sha: 6fa7ce0123456789
  original_description:
    body: Preview fixture
    source: gh_api
    fetched_at: "2026-06-28T12:00:00.000Z"
  stats:
    files_changed: 16
    additions: 828
    deletions: 104
walkthrough:
  context:
    why_created: Fix terminal reattach after refresh.
    problem_solved: Reopened sessions reconnect to persisted background processes.
    why_worth_merging: Prevents users losing terminal context.
    merge_concerns: Verify restart recovery manually.
    author_intent: Reuse saved process metadata to restore terminal streams.
    reviewer_map: core: src/server/agent/bg-process-manager.ts — reattach lifecycle
  merge_assessment:
    recommendation: comment
    confidence: medium
    summary: Core reattach path is covered; manually verify restart recovery.
    blocking_concerns: []
    non_blocking_concerns: []
  design_decisions: []
  review_chunks: []
  omissions_and_followups: []
  audit:
    remaining_changed_areas: []
    low_signal_or_mechanical_changes: []
    generated_or_binary_files: []
    reviewer_checklist:
      - Browser coverage for terminal refresh and session navigation reattach.
  display:
    phase_order: [orientation, significant, audit]
    chunk_order: []
`;

const READY_BUNDLE = {
  found: true,
  persistedAt: "2026-06-28T12:00:00.000Z",
  changeset: {
    provider: "github",
    owner: "SuuBro",
    repo: "bobbit",
    number: 42,
    url: "https://github.com/SuuBro/bobbit/pull/42",
    prTitle: "Fix terminal reattach",
    title: "Fix terminal reattach",
    baseSha: "135c5ef1234567890",
    headSha: "6fa7ce0123456789",
    filesChanged: 16,
    additions: 828,
    deletions: 104,
  },
  cards: [
    {
      id: "orientation-overview",
      phaseId: "orientation",
      navLabel: "Orientation",
      title: "PR context",
      summary: "Terminal reattach now restores persisted background processes after refresh or restart.",
      rationale: "Focused six-beat reviewer orientation.",
      sections: [
        { id: "what-changed-and-why", navLabel: "What/why", eyebrow: "Purpose", heading: "What changed and why", body: "Fixes terminal reattach so reopened sessions reconnect to persisted background processes instead of showing stale or disconnected terminal state.", showStats: true },
        { id: "how-it-works", navLabel: "How it works", eyebrow: "Implementation", heading: "How it works", body: "The runtime resolves saved process metadata, reconnects the terminal stream when the process is still alive, and surfaces clear stopped/stale states when reattach is not possible." },
        { id: "change-map", navLabel: "Change map", eyebrow: "Review map", heading: "Change map", fileRoles: [{ role: "core", file: "src/server/agent/bg-process-manager.ts", note: "reattach lifecycle" }] },
        { id: "risks-and-edge-cases", navLabel: "Risks", eyebrow: "Risk", heading: "Risks and edge cases", concerns: [{ severity: "blocking", text: "A dead process must not be shown as reattached or interactive." }] },
        { id: "validation", navLabel: "Validation", eyebrow: "Evidence", heading: "Validation", items: ["Browser coverage for terminal refresh and session navigation reattach."] },
        { id: "merge-recommendation", navLabel: "Merge", eyebrow: "Decision", heading: "Merge recommendation", body: "Merge if reattach works after refresh and stale process states stay explicit.", verdict: { recommendation: "comment", confidence: "medium", summary: "Verify restart recovery manually before approval." } },
      ],
      checklist: [],
      diffBlocks: [],
      suggestedComments: [],
    },
    { id: "runtime", phaseId: "significant", navLabel: "Runtime", title: "Terminal reattach runtime", summary: "Reconnects reopened sessions to existing background process streams when possible.", rationale: "Primary behavior change.", checklist: [], diffBlocks: [], suggestedComments: [] },
    { id: "audit", phaseId: "audit", navLabel: "Audit", title: "Final review controls", summary: "Confirm completion and export controls.", rationale: "Submit flow smoke card.", checklist: [], diffBlocks: [], suggestedComments: [] },
  ],
  warnings: [],
  export: { available: false, reason: "Preview fixture" },
};

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    if (currentHost) renderPanel(currentParams, currentHost);
  });
}

const host = {
  store: {
    async get(key: string) { return hostStoreData.get(key); },
    async put(key: string, value: unknown) { hostStoreData.set(key, value); },
  },
  async callRoute(route: string) {
    if (route === "recover") return { found: true, finalized: true, jobId: "preview-job", yaml: READY_YAML, baseSha: "135c5ef1234567890", headSha: "6fa7ce0123456789", finalizedAt: Date.now() };
    if (route === "bundle") return READY_BUNDLE;
    if (route === "status") return { phase: "submitted", finalized: true, jobId: "preview-job", yaml: READY_YAML };
    return undefined;
  },
  requestRender: scheduleRender,
};

function renderPanel(params: any, hostArg: any) {
  currentParams = params;
  currentHost = hostArg;
  render(panel.render(currentParams, currentHost), root()!);
}

renderPanel({ __sessionId: "preview-child", jobId: "preview-job" }, host);
```

4. Bundle the harness:

```bash
npx esbuild .bobbit/tmp/prw-preview/entry.ts --bundle --format=esm --target=es2022 --outfile=.bobbit/tmp/prw-preview/bundle.js --tsconfig=tsconfig.web.json
```

5. Open the file-backed live preview:

```ts
preview_open({ file: ".bobbit/tmp/prw-preview/index.html", assets: ["bundle.js"] })
```

6. If iterating, edit the real source panel, rebuild the bundle, then call `preview_open` again:

```bash
npx esbuild .bobbit/tmp/prw-preview/entry.ts --bundle --format=esm --target=es2022 --outfile=.bobbit/tmp/prw-preview/bundle.js --tsconfig=tsconfig.web.json
```

## Validation checklist

- Preview iframe inherits the same theme as Bobbit. If it is brown/slate/white unexpectedly, inspect the preview HTML for hardcoded theme variables and remove them.
- The first card should render PR data, not “Walkthrough unavailable”. If it is missing, check that `recover` returns both `found: true` and `yaml: READY_YAML`.
- Use browser devtools/eval against the in-app iframe when verifying theme parity:

```js
(() => {
  const frame = document.querySelector('iframe[src*="/preview/"]');
  const d = frame?.contentDocument;
  return {
    parentPalette: document.documentElement.getAttribute('data-palette'),
    framePalette: d?.documentElement.getAttribute('data-palette'),
    parentBg: getComputedStyle(document.documentElement).getPropertyValue('--background'),
    frameBg: d ? getComputedStyle(d.documentElement).getPropertyValue('--background') : null,
  };
})()
```
