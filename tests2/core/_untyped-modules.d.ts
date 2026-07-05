// Ambient declarations for untyped `.mjs` modules imported by v2 tests.
//
// Tier-1 tests import a few plain-JS `.mjs` sources directly (scripts, market-pack
// libs, the e2e mock-agent-core, default tool gateways). These have no sibling
// `.d.ts`, so under `noImplicitAny` a static import resolves to an implicit `any`
// and fails the type-check (TS7016). Declaring them as ambient `any` modules is
// the standard test-side accommodation for untyped JS — it does not affect
// production types (this file is scoped to the tests2 tsconfig only).
declare module "*.mjs";
