// Shared custom-element registration bridge for the v2-dom (happy-dom) tier.
// Import this module FIRST in every dom test file; call `syncCustomElements()` in
// a top-level `beforeAll`.
//
// WHY THIS EXISTS
// vitest runs with `pool:"forks", isolate:false` (see vitest.config.ts): the
// module registry is shared across all test files in a fork, but happy-dom hands
// each file a BRAND-NEW window (fresh `customElements`). Two problems follow:
//
//  (1) `@customElement("x")` runs its define exactly ONCE — in whichever file's
//      window first imported it. Later files get a fresh registry missing `x`, so
//      `createElement("x")` yields an inert element. syncCustomElements() replays
//      every recorded define into the current window.
//
//  (2) lit-html captures `const d = document` at MODULE INIT and builds every
//      template via `d.createElement("template")`, in the FIRST window that
//      imported lit-html — not the current test's window. A custom element is
//      upgraded at parse time against THAT document's registry; if the tag isn't
//      defined there when the template is first parsed (and CACHED), it is created
//      generic forever, throwing "createRenderRoot is not a function" on connect.
//      registry-bridge mirrors every define into that pinned registry, and this
//      module PRE-IMPORTS the real lazy lit components below so their tags are
//      defined in the pinned window BEFORE any template referencing them is
//      parsed — killing the intermittent <markdown-block>/<gate-verification-live>
//      straggler.
//
// registry-bridge.js is imported first so its CustomElementRegistry patch is
// installed before these component defines run (static imports evaluate in order).
import { syncCustomElements } from "./registry-bridge.js";

// Pre-define the async-rendered lazy lit components in lit-html's pinned window
// (their @customElement side-effects run here, recorded + mirrored by the patch
// installed in registry-bridge). This must happen before any test renders a
// template containing them, so lit's cached template holds the REAL class.
import "../../../src/ui/lazy/safe-markdown-block.js";
import "../../../src/ui/tools/renderers/GateVerificationLive.js";

export { syncCustomElements };
