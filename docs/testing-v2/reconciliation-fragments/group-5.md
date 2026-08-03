# Residual reconciliation — group 5

**Target audited:** `0299fe6b8268f01f136d2a6787983e662e0fdc94` (`origin/main` at audit start)  
**Reference extracted:** `e3051de63cf611143a989f7928bd9f9a7ed9beae^2..e3051de63cf611143a989f7928bd9f9a7ed9beae`

The reference merge is not an ancestor of the target. Classifications therefore use the current implementation and regression coverage, plus the focused PR commits, rather than merge ancestry or textual identity. Categories are: **1** merged, **2** superseded by stronger current behavior, **3** intentionally obsolete/inapplicable, and **4** genuinely missing. Category 4 entries below are candidates only; this audit intentionally makes no implementation change.

## `src/server/extension-host/path-guard.ts` — **2: superseded**

- **Canonical/lexical root aliases and fail-closed containment:** the reference accepted a candidate under either the lexical or real root, then required its real path to remain in the root; it also rejected an outside mutable symlink before resolving it. Current `isStrictlyContained()` and `isPackPathWithinRoot()` retain that contract at lines 55–96 and additionally reject mixed path dialects and case-distinct descendants on Windows case-sensitive directories. The focused path-identity PR is `aaae5330` (#1077); refinements are `4f99969c` (case-preserving pack boundaries) and `29beb19f` (portable test seam).
- **Boundary-aware traversal predicate:** the reference replaced prefix matching with `path.relative()`. Current line 61 uses the correct platform path API and lines 62–66 preserve strict boundary and Windows component-case checks. This is stronger than the reference predicate, so it is superseded rather than copied verbatim.

## `src/server/preview/path-guard.ts` — **2: superseded**

- **Missing asset must be checked against the lexical preview root:** the reference avoided comparing an unresolved user path with a canonical root (`/var` versus `/private/var`). Current `resolveAssetPath()` lines 60–73 does exactly that before returning 404, while retaining canonical containment for existing files.
- **Boundary-aware containment rather than prefix matching:** current exported `isPathContained()` at lines 100–114 keeps the reference `relative()` escape test and additionally preserves Windows case-sensitive descendant components. This was integrated by #1077 (`aaae5330`) and strengthened by `9b0bc03e`.

## `src/server/agent/transcript-sanitizer.ts` — **1: merged**

- **Trust both a validated persisted file's lexical and canonical spellings:** reference blob `04851eb6` equals the target blob. `trustPersistedAgentSessionFile()` lines 576–582 stores `filePath` and `readable`, preventing a trusted `/var/...` file from being rejected when revisited through `/private/var/...`. This is in focused #1077 (`aaae5330`); alias and CRLF coverage is retained in `tests2/core/transcript-sanitizer.test.ts` lines 601–640.

## `src/server/agent/pi-extension-contributions.ts` — **4: missing candidate**

- **Eagerly bind asynchronous Pi discovery before an isolated filesystem fixture is installed:** the reference statically imported `discoverPiExtensionTools` alongside the synchronous entry point and removed the dynamic import from `loadPiExtensionContributionsWithDiscovery()`. Current lines 8 and 345 still import only `discoverPiExtensionToolsSync` statically and dynamically import `discoverPiExtensionTools`. The reference behavior is also isolated in non-ancestor commit `6216bbfb` (`test: avoid lazy pi discovery prebundle load`). This is a candidate because the existing static module import may mask the issue in some runtimes; it needs a focused reproduction before code is changed.

## `src/server/agent/yaml-store.ts` — **1: merged**

- **Reject sibling-prefix traversal with relative-path containment:** reference blob `bc7ca9a5` equals the target blob. `YamlStore.itemPath()` lines 123–130 rejects `..`, `../...`, and absolute relatives rather than trusting a shared string prefix. The behavior arrived with #1077 (`aaae5330`).

## `tests2/core/component-path-traversal.test.ts` — **1: merged**

- **Host-independent POSIX/Windows component traversal coverage:** reference blob `8afd0870` equals the target blob. Lines 32–43 pin both dialects and reject backslash traversal, drive-absolute paths, and UNC paths; the production `isSafeRelPath()` guard remains in `src/server/agent/project-config-store.ts`. The test is part of #1077 (`aaae5330`).

## `tests2/core/extension-host-path-guard.test.ts` — **1: merged**

- **Canonical-root alias and outside-mutable-symlink regressions:** current lines 72–90 and 143–168 retain the reference behavior: accept a canonical in-pack path through a lexical-root alias while refusing an outside symlink even if it currently targets an in-pack file.
- **No symlink-permission skip:** current lines 40–69 and 171–200 retain the reference's scoped `realpathSync` seam, so restricted Windows/container hosts exercise the security branch instead of skipping it. `29beb19f` is a later portability refinement.
- **POSIX and Windows boundary regression:** current lines 93–102 retain the reference's dual-dialect boundary assertions and add the case-sensitive Windows sibling regression at lines 104–118. This coverage is from #1077 (`aaae5330`) plus the later hardening above.

## `tests2/core/extension-host-terminal.test.ts` — **2 / 3: superseded and obsolete**

- **Final PTY output must precede exit:** **2, superseded.** The reference's source-only blocked multi-frame test is replaced by a stronger source-and-packaged parameterized test at lines 239–321. It covers an exit callback before final data, explicit drain, blocked sends, reconnect replay, ordering, exactly one exit, and exactly one close. Focused #1080 is `652666e2`; its implementation serializes output and defers final exit in `market-packs/terminal/src/terminal-channel.ts` lines 42–116.
- **`flushTerminalOutput()` before ordinary output assertions:** **3, obsolete.** The reference added helper waits at two setup sites. The current outbound queue deliberately starts an idle callback in the same turn (`terminal-channel.ts` lines 46–56), and current tests assert that direct delivery boundary without sleeps or polling (for example lines 98–100). The drain contract is now expressed by the explicit host `onDrain` test above, not a generic test-only flush.

## `tests2/core/preview-path-guard.test.ts` — **1: merged**

- **No symlink-permission skip for preview escape rejection:** current lines 41–53 and 115–137 retain the reference's scoped `realpathSync` seam. A restricted host simulates the escaping link and still asserts HTTP 400. Current coverage additionally pins the seam directly and Windows descendant case behavior (lines 130–143). The seam portability refinement is `5891e197`; the base behavior is from #1077 (`aaae5330`).

## `tests2/core/transcript-sanitizer.test.ts` — **1: merged**

- **Portable symlink-rejection regression:** reference blob `70388059` equals the target blob. Lines 46–86 provide link/`lstatSync` seams when native link creation is unavailable, replacing the prior skip; lines 568–588 exercise the rejection.
- **Alias and CRLF persisted-transcript coverage:** the same exact blob retains the reference tests at lines 601–640. They verify canonical-root access through a lexical alias and CRLF-delimited persisted records before read-only trust is granted. This coverage accompanies #1077 (`aaae5330`).

## `tests2/dom/transient-draft-store.test.ts` — **4: missing candidate**

- **Reliably inject storage failures through `globalThis` and `window` storage aliases:** the reference replaced direct `Storage.getItem`/`setItem` overrides with throwing `localStorage`/`sessionStorage` proxy aliases, because happy-dom's Storage proxy can ignore own-method overrides. Current lines 34–104 still use the older direct-method patch and the failure test at lines 274–299 therefore does not pin the reference's alias/proxy invariant. The reference implementation is non-ancestor commit `ada9b07d` (`fix DOM storage aliases`). This is a test-isolation candidate; production draft-store behavior is not alleged missing until the current fixture is reproduced as ineffective.

## Summary

| Category | Behaviors |
|---|---:|
| 1 — merged | 9 |
| 2 — superseded | 5 |
| 3 — obsolete/inapplicable | 1 |
| 4 — missing candidates | 2 |

The two category-4 items are explicitly flagged for reproduction and possible follow-up; no code or tests were modified by this audit.
