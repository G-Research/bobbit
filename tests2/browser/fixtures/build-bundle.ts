// Shim: re-export build-bundle from the original test helpers location.
// Fixture specs copied from tests/ui-fixtures/ import "../fixtures/build-bundle.js"
// which resolves here when running from tests2/browser/fixtures/.
export * from "../../../tests/fixtures/build-bundle.js";
