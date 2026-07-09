/**
 * Shim: re-exports e2e-setup helpers from tests/e2e/.
 * Geometry fixture specs placed in tests2/browser/fixtures/ import from
 * "../e2e-setup.js" which resolves here, keeping the specs verbatim.
 */
export * from "../../tests/e2e/e2e-setup.js";
