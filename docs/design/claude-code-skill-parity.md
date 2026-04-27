# Claude Code Skill Parity — Design Doc

Goal: make Bobbit's runtime behavior for `SKILL.md` files equivalent to Claude Code's, so a skill authored once and shared between both tools produces the same agent behavior. Focus on file-system/progressive-disclosure parity — not tool-name compatibility, not `allowed-tools` enforcement.

The parity test: drop a skill from `https://github.com/anthropics/skills` into `.claude/skills/<name>/` and the Bobbit agent uses it the same way Claude Code's agent does — including reading `references/REFERENCE.md` and running `scripts/foo.sh` when the SKILL.md tells it to.

---

## 1. File-level change list

### 1.1 `src/server/skills/slash-skills.ts` — stop auto-inlining `@path` refs in skill bodies

Today both `scanSkillDir` (line 121) and `scanCommandsDir` (line 170) call:

```ts
const content = resolveMarkdownRefs(rawContent, path.dirname(skillFile));
```

This eagerly inlines every `@references/foo.md` reference into the skill body at scan time, defeating Claude Code's Level-3 progressive disclosure (the agent is supposed to load referenced files on demand). It also bloats the system-prompt "Available Skills" section and breaks the spec's "<500 lines" expectation.

**Change:**
- In `scanSkillDir`: replace `const content = resolveMarkdownRefs(rawContent, path.dirname(skillFile));` with `const content = rawContent;`
- In `scanCommandsDir`: same replacement (`const content = rawContent;`).
- Drop the `import { resolveMarkdownRefs } from "../agent/system-prompt.js";` line **only if** it has no other consumer in this file (it doesn't — verified by `grep`).
- **Do NOT** touch any other call site. `resolveMarkdownRefs` must remain in use for AGENTS.md / system-prompt assembly (`src/server/agent/system-prompt.ts` lines 100/125/149/275/395/407 — eight other call sites). Add a one-line comment above the change explaining why skills opt out: *"Per Claude Code spec, SKILL.md bodies are NOT pre-resolved — the agent reads `@path` references on demand (Level-3 progressive disclosure)."*

**Rationale:** the description fallback in both functions reads `content.split("\n").find(...)` — preserving the literal text doesn't break this because the first non-empty line is unaffected by `@path` refs (they're whole-line tokens that occur further down in real skills).

### 1.2 New helper `src/server/skills/skill-manifest.ts` — `buildSkillResourceManifest(skillRoot)`

New file. Pure synchronous helper, no dependencies beyond `node:fs`/`node:path`.

```ts
/**
 * Scan a skill directory for "Level-3" resource files the agent may load
 * on demand. Mirrors Claude Code's documented progressive-disclosure
 * convention: only the conventional subdirs (`references/`, `scripts/`,
 * `assets/`) are surfaced, one level deep.
 */
export interface SkillResourceManifest {
  root: string;          // absolute path to the skill directory
  resources: string[];   // ["references/REFERENCE.md", "scripts/extract.py", ...]
}

export function buildSkillResourceManifest(skillRoot: string): SkillResourceManifest;
```

Behavior:
- Iterate the three subdir names `["references", "scripts", "assets"]` in that fixed order.
- For each, if the dir exists, `readdirSync(..., { withFileTypes: true })`, keep only regular files (skip subdirs — **one level deep, no recursion**), sort alphabetically by name, push `<subdir>/<filename>` into `resources`.
- If a subdir does not exist, simply skip it (no marker, no empty section).
- **Size cap:** join the manifest as it would be rendered (`resources.join(", ")`); if that exceeds `2048` bytes (UTF-8), truncate the list alphabetically (i.e. keep the prefix that fits) and append a synthetic final entry `(N more files)` where N is the count of dropped entries. Re-check the cap after appending the suffix; if still over, drop one more real entry.
- Always returns a `SkillResourceManifest` — even when every dir is missing (`resources` is `[]`). Callers decide whether to skip the header for empty manifests (yes — see §1.3).

Errors are swallowed (return whatever was collected so far + warn to stderr). A malformed skill must not break activation.

### 1.3 `src/server/skills/resolve-skill-expansions.ts` — prepend activation header

Both branches of the resolver currently return `expanded = buildSlashSkillPrompt(skill, args)`. Wrap that result in a small synthetic header.

New helper local to this file (or co-located in `skill-manifest.ts`, exported):

```ts
function buildActivationHeader(skill: SlashSkill): string {
  const root = path.dirname(skill.filePath);            // SKILL.md lives at root
  const manifest = buildSkillResourceManifest(root);
  const lines: string[] = [];
  lines.push("<!-- skill-activation-header -->");
  lines.push(`Skill root: ${root}`);
  if (manifest.resources.length > 0) {
    lines.push(`Available resources: ${manifest.resources.join(", ")}`);
  }
  lines.push("<!-- /skill-activation-header -->");
  return lines.join("\n") + "\n\n";   // blank line before SKILL.md body
}
```

For *legacy* commands (`.claude/commands/<name>.md`) the file IS the skill — there's no skill *directory*. Detect this: if `path.basename(skill.filePath) !== "SKILL.md"` → skip the header entirely (no root, no manifest meaningful). For `source === "built-in"` with `filePath === "(built-in)"` (the synthetic `compact` entry) → also skip.

Apply at both expansion sites in `resolveSkillExpansions`:
- **Prefix-only branch:** `const expanded = buildActivationHeader(skill) + buildSlashSkillPrompt(skill, args);`
- **Inline scan branch:** same wrap — `const expanded = buildActivationHeader(skill) + buildSlashSkillPrompt(skill, "");`

Snapshot semantics are preserved automatically because the header is concatenated *into* `expanded`, which is what gets persisted to the sidecar (`skill-sidecar.ts`) and replayed.

### 1.4 `defaults/tools/skills/extension.ts` + `POST /api/sessions/:id/activate-skill`

The autonomous-activation path currently returns the bare `buildSlashSkillPrompt` result. Make it byte-equal to the user-invocation path.

**Server side — `src/server/server.ts` around line 2156:**

Change:
```ts
const expanded = buildSlashSkillPrompt(skill, skillArgs);
json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
```
to:
```ts
import { buildActivationHeader } from "./skills/skill-manifest.js"; // top of file
// ...
const header = buildActivationHeader(skill); // empty string for legacy/synthetic
const expanded = header + buildSlashSkillPrompt(skill, skillArgs);
json({ ok: true, expanded, source: skill.source, filePath: skill.filePath });
```

(Export `buildActivationHeader` from `skill-manifest.ts` so it's shared with `resolve-skill-expansions.ts` — single source of truth.)

**Extension side — `defaults/tools/skills/extension.ts`:** no code change. The extension already passes through the server's `expanded` field verbatim into the tool result text and into `details.skillExpansion.expanded`. Both will pick up the header automatically.

### 1.5 `src/ui/components/SkillChip.ts` — strip header from disclosure body

The chip's disclosure renders `this.data.expanded` via `<markdown-block>`. The header is purely model-facing — strip it before render so the user sees what the SKILL.md author wrote.

Add a private getter:

```ts
private get displayBody(): string {
  // Match the canonical fence (literal HTML comments). The body between
  // the open/close markers is synthetic; everything after is the real
  // SKILL.md body. Use a non-greedy match anchored at the start of the
  // string with optional leading whitespace, so we never accidentally
  // strip mid-document content.
  return this.data.expanded.replace(
    /^\s*<!--\s*skill-activation-header\s*-->[\s\S]*?<!--\s*\/skill-activation-header\s*-->\s*/,
    "",
  );
}
```

Use `${this.displayBody}` in `renderExpansion()` instead of `${this.data.expanded}`. The model-facing `expanded` field is untouched — only the visual render changes.

The regex is anchored at start-of-string and only matches the *first* fenced block, so a SKILL.md author who happens to write `<!-- skill-activation-header -->` later in their body won't be affected.

### 1.6 No changes required (deliberate)

- `skill-sidecar.ts` — opaque pass-through of `expanded`; header rides along automatically.
- `src/ui/components/Messages.ts` — splices `<skill-chip>` from the same `SkillExpansion` payload; no logic change.
- `src/ui/tools/renderers/ActivateSkillRenderer.ts` — already uses `<skill-chip block>` with the same data shape.
- `src/server/agent/system-prompt.ts` — "Available Skills" listing only emits `name` + `description`; the description path still flows through the *first non-empty line* of `content`, which is unaffected (descriptions don't typically start with `@path` refs).

---

## 2. Header marker format

```
<!-- skill-activation-header -->
Skill root: <abs path>
Available resources: references/REFERENCE.md, scripts/extract.py, assets/template.docx
<!-- /skill-activation-header -->

<rest of SKILL.md body…>
```

Why HTML-comment fence:

- **Markdown-invisible.** GitHub-flavored Markdown (and `<markdown-block>`'s renderer) treats `<!-- … -->` as a comment and emits nothing. If a chip's strip logic ever fails, the header still renders as nothing rather than as visible noise.
- **Unambiguous to a regex.** The exact literal `<!-- skill-activation-header -->` is extremely unlikely to appear in a real SKILL.md. The strip regex is anchored at `^\s*` so it can only ever fire on a header we ourselves prepended.
- **Model-friendly.** Modern frontier models reliably parse "Skill root:" / "Available resources:" lines; the comment fence doesn't confuse them. We're not relying on the model to ignore the markers — we tell it explicitly via the `Skill root:` prose.
- **Symmetric.** Open and close fences make the strip regex non-greedy and self-documenting; we don't have to guess where the synthetic block ends.

A simpler `=== HEADER ===` style fence was considered and rejected: those *do* render as visible text in markdown, so any UI strip miss leaves an ugly artifact in the disclosure body.

---

## 3. Sandbox-visibility analysis

The activation header embeds an **absolute host path** (`Skill root: <abs>`). Inside a Docker sandbox the agent's filesystem view is rebased — the project worktree is mounted at `/workspace` and only specific bobbit-state subdirs are bind-mounted (see `src/server/agent/docker-args.ts` lines 103–157, `project-sandbox.ts`).

**Project-local skills (`<cwd>/.claude/skills/<name>/SKILL.md`):**
- Live inside the worktree, which is mounted at `/workspace`.
- The header's host path (e.g. `C:\Users\me\proj\.claude\skills\foo`) does NOT translate inside the container.
- **Mitigation:** the activate-skill REST handler already does `if (session.sandboxed) skillCwd = ctx.project.rootPath;` (server.ts ~line 2147). For sandboxed sessions, emit the header path as a container-relative path (`/workspace/.claude/skills/<name>`) instead of the host path. The `Available resources:` list is already relative to the skill root, so it transparently works inside the container.

  **Implementation note:** `buildActivationHeader` needs to know whether the session is sandboxed. Two options:
  1. Accept an optional `pathRewrite?: (abs: string) => string` callback. Resolver and server pass a rewriter when the session is sandboxed (`abs => "/workspace" + abs.slice(project.rootPath.length).replace(/\\/g, "/")`).
  2. Pass `containerRoot` directly. Cleaner for the server path; resolver doesn't have session context — `resolveSkillExpansions` is called from `ws/handler.ts`, which DOES know whether the session is sandboxed. Thread it through.

  Recommend **option 1** — a single optional callback parameter, defaults to identity, threaded from both call sites.

**Built-in skills shipped with Bobbit (`defaults/skills/<name>/SKILL.md`, copied into `dist/server/defaults/skills/`):**
- Live inside the Bobbit install directory.
- The Docker image already bundles the install dir (the toolchain mount at `/tools-builtin:ro` covers `/tools` only, not `/defaults/skills`). Need to verify whether `defaults/skills/` ends up readable inside the container — `git grep` for `defaults/skills` in `docker-args.ts`/`project-sandbox.ts` shows **no mount**, and the install dir is only present if it's baked into the image (which the dev/dockerized build may or may not do).
- **Decision for v1:** mark this as a **known limitation**. Document in `docs/internals.md` under "Docker sandbox" with wording roughly:

  > *Built-in skills (`defaults/skills/`) and personal skills (`~/.claude/skills/`) are not visible inside the Docker sandbox. Their SKILL.md body still gets injected into the prompt (so the agent receives the instructions), but Level-3 resources (`references/`, `scripts/`, `assets/`) cannot be read or executed by the sandboxed agent. Use `.claude/skills/<name>/` inside your project for skills that ship multi-file resources.*

- **Out of scope:** bind-mounting the install dir, copy-on-activate into the worktree, or per-skill volume injection. File a follow-up goal — too much surface area for this design.

The `Available resources:` line still ships even for built-in skills (it's harmless prose), but the agent will fail to read the files. The follow-up goal can either (a) add a bind-mount for `defaults/skills/` to a stable container path, or (b) suppress the manifest section when the session is sandboxed and the skill root is outside the worktree.

For v1 we'll do **(b)** as a small, contained safety measure: when `pathRewrite` is provided AND the skill root is *not* inside the project worktree, emit a degraded header:

```
<!-- skill-activation-header -->
Skill root: (not visible inside sandbox — see project-local .claude/skills/ for multi-file skills)
<!-- /skill-activation-header -->
```

That keeps the contract honest without misleading the model about a path it can't read.

---

## 4. Test plan

### 4.1 Unit tests

New file: `tests/skill-manifest.spec.ts` (Node test runner, file-system fixtures under `tests/fixtures/skills/`).

- **`buildSkillResourceManifest` — all three subdirs present.** Fixture: `references/REFERENCE.md`, `references/api.md`, `scripts/hello.sh`, `assets/template.txt`. Expect `resources` to contain exactly those four paths, alphabetically per-subdir, in `references → scripts → assets` order. `root` equals the absolute fixture path.
- **One subdir missing.** Fixture has only `scripts/`. Expect `resources` length 1, no error, no synthetic empty section.
- **All subdirs missing.** Fixture has only `SKILL.md`. Expect `resources: []`.
- **>2 KB truncation.** Fixture with 200 files in `references/`. Expect output ≤ 2048 bytes when joined; last entry is `(N more files)` where N matches the dropped count; alphabetical prefix is preserved (no random drops).
- **One-level-deep only.** Fixture with `references/sub/nested.md`. Expect `nested.md` is NOT listed (we don't recurse).

New file: `tests/skill-activation-header.spec.ts`.

- **Header strip regex — round trip.** Construct an `expanded` of `<header>\n\nbody`. Assert `displayBody` equals `body` (no leading whitespace).
- **Header strip is anchored.** A SKILL.md body containing the literal `<!-- skill-activation-header -->` later in the text is preserved (regex anchored at `^\s*`).
- **Empty-resources header.** Skill with no subdirs: assert header has only `Skill root:` line, no `Available resources:` line.
- **Sandboxed degraded header.** With `pathRewrite` returning a path outside the worktree (or `null`): assert header contains the "(not visible inside sandbox …)" prose and no resource list.

Extend existing: `tests/slash-skills.spec.ts` (or add if absent).

- **`@path` refs preserved verbatim.** Fixture SKILL.md body containing `Read @references/foo.md for details.` Assert `scanSkillDir(...)[0].content` contains the literal substring `@references/foo.md` (i.e. `resolveMarkdownRefs` was NOT called).
- **Description fallback unchanged.** Fixture without an explicit `description` frontmatter: assert the discovered `description` equals the first non-empty line of the body (regression coverage for the change).

Extend existing: `tests/resolve-skill-expansions.spec.ts`.

- **Prefix-only expansion includes header.** Assert `expansions[0].expanded` starts with `<!-- skill-activation-header -->`.
- **Inline expansion includes header.** Same for inline match.
- **Header is byte-equal between user invocation and `activate_skill` REST.** Drive both paths against the same fixture skill and `assert.strictEqual` on `expanded`.

### 4.2 E2E tests

New file: `tests/e2e/ui/skill-multifile.spec.ts` (browser E2E, spawned gateway).

Fixture skill at `tests/fixtures/skills-e2e/multi/`:
- `SKILL.md` with frontmatter and a body referencing `references/REFERENCE.md` and `scripts/hello.sh`.
- `references/REFERENCE.md` with a unique sentinel string.
- `scripts/hello.sh` printing the same sentinel.
- `assets/template.txt`.

Steps:
1. **Activate via `/multi`.** Type the slash command into the prompt; submit.
2. **Chip renders.** Assert `<skill-chip>` appears in the user message bubble.
3. **Chip body is clean.** Click the chip to expand; assert the disclosure DOES NOT contain the literal text `<!-- skill-activation-header -->` or `Skill root:` (header was stripped); DOES contain the SKILL.md body's first sentence.
4. **Reload preserves chip.** Reload the page; assert the chip still renders and still hides the header in its disclosure (sidecar replay).
5. **Follow-up turn reads referenced file.** Send a follow-up prompt: "what does references/REFERENCE.md say?" — using a mock agent that returns the result of a `read` tool call against the relative path. Assert the read succeeds and the sentinel appears in the model output.

(Mock-agent harness lives in `tests/e2e/ui/test-helpers/`; pattern is established in existing skill E2E tests.)

### 4.3 Manual / sandbox-visibility check

Not automated for v1. Document a manual repro recipe in `docs/internals.md`:
1. Create a `.claude/skills/multi/` skill with the three subdirs in a sandboxed project.
2. Start a sandboxed session, run `/multi`.
3. Verify the header path begins with `/workspace/.claude/skills/multi`.
4. Have the agent run `bash scripts/hello.sh` — it should succeed.

---

## 5. Acceptance-criteria mapping

| # | Criterion | Test / verification |
|---|-----------|---------------------|
| 1 | Multi-file skill: header lists `references/REFERENCE.md` + `scripts/foo.sh`; agent can read/run them with author-written paths. | E2E §4.2 step 5 + unit `buildSkillResourceManifest — all three subdirs present`. |
| 2 | `@references/foo.md` in SKILL.md body is preserved verbatim (not inlined) for both `/name` invocation and `activate_skill`. | Unit `@path refs preserved verbatim` (§4.1) + a parallel assertion in `resolve-skill-expansions.spec.ts` ensuring the expanded body still contains the literal `@references/foo.md` substring. |
| 3 | Activation header hidden from user-message chat bubble; persists across reload. | E2E §4.2 steps 3 + 4 (chip disclosure + reload). |
| 4 | Multi-file skill works end-to-end in non-sandboxed projects; sandbox behavior verified or documented. | E2E §4.2 covers non-sandboxed; sandbox limitation captured in §3 + manual recipe §4.3 + `docs/internals.md` update under "Docker sandbox". |
| 5 | Browser E2E: activate multi-file skill via `/name`, chip without header, reload preserves chip, follow-up turn reads referenced file. | E2E §4.2 (entire spec). |
| 6 | Existing skill UX (chip rendering, sidecar persistence, `disable-model-invocation`, autonomous activation, byte-equality of model-facing prompt for skills *without* references) continues to work. | Existing test suites under `tests/skill-*` and `tests/e2e/ui/skill-*` continue to pass unchanged. New unit assertion: for a fixture skill with no `@path` refs and no resource subdirs, the model-facing `expanded` of `resolveSkillExpansions` differs from the legacy output ONLY by the leading header block — strip the header and the result is byte-equal to a legacy snapshot. |

---

## 6. Open-question resolutions

- **Header marker:** HTML comment fence (§2). Picked.
- **Manifest depth:** one level deep, `[references, scripts, assets]` only, in fixed order (§1.2). Picked.
- **Manifest size cap:** 2 KB joined, alphabetical truncation, `(N more files)` suffix (§1.2). Picked.
- **Sandbox path rewriting:** project-local skills get `/workspace`-rebased path via optional `pathRewrite` callback; built-in/personal skills emit a degraded "(not visible inside sandbox)" header in v1 (§3). Picked.
- **Legacy `.claude/commands/*.md` and synthetic built-ins (`compact`):** no header (§1.3). Picked.

---

## 7. Migration / backward compatibility

- Old archived sessions with sidecar entries that *don't* contain the header marker continue to render correctly — the strip regex is a no-op when no header is present. The chip body shows the legacy expanded text as before.
- New sessions write headered `expanded` to the sidecar; replay strips on render. Byte-stable across server restarts.
- The system-prompt "Available Skills" listing is unchanged (still uses `name` + `description`); no token-budget regression there.
- `resolveMarkdownRefs` removal from skill bodies is a behavior change for any user who relied on auto-inlining inside SKILL.md. None of Anthropic's published skills depend on this; the change brings us into spec compliance. Worth a one-line note in the user-facing changelog.
