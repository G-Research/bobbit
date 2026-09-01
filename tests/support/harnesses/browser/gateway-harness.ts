/**
 * Shim: re-exports the real gateway harness from tests/e2e/.
 * Geometry fixture specs placed in tests/browser/fixtures/ import from
 * the browser support harness, keeping the fixture contract unchanged.
 */
export * from "../../../e2e/gateway-harness.js";
