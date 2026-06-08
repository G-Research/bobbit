// Server action handlers for the `sample_action` demo tool (Extension Host
// Phase 1, design docs/design/extension-host.md §2.4 / §4b).
//
// Loaded by the gateway's ActionDispatcher via dynamic `import()` under PLAIN
// node — so this file MUST be ESM-loadable. A `.js` with `export` and no
// package.json `type:module` would load as CJS and throw, so the module is
// shipped as `.mjs` (and the tool YAML's `actions.module` points at it).
//
// `retry` returns a deterministic-enough payload the browser E2E can assert on
// (the `message` field flows back to the renderer's `pack-result` element).
export const actions = {
	retry: async (_ctx, _args) => ({ message: "retried", at: Date.now() }),
};
