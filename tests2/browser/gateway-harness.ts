/**
 * Shim: re-exports the real gateway harness from tests/e2e/.
 * Geometry fixture specs placed in tests2/browser/fixtures/ import from
 * "../gateway-harness.js" which resolves here, keeping the specs verbatim.
 */
export * from "../../tests/e2e/gateway-harness.js";
