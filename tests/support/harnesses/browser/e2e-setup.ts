/**
 * Shim: re-exports e2e-setup helpers from tests/e2e/.
 * Geometry fixture specs placed in tests/browser/fixtures/ import from
 * the browser support harness, keeping the setup contract unchanged.
 */
export * from "../../../e2e/e2e-setup.js";
