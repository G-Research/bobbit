// Shim: re-export build-bundle from the original test helpers location.
// Fixture specs copied from tests/ui-fixtures/ import the browser support helper,
// which resolves here under tests/support/helpers/browser/fixtures/.
export * from "../../../../fixtures/build-bundle.js";
