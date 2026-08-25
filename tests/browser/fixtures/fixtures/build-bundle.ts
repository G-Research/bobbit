// Shim: re-export build-bundle from the original test helpers location.
// Fixture specs copied from tests/ import "../../support/fixtures/shared/build-bundle.js"
// which resolves here when running from tests/browser/fixtures/.
export * from "../../../../tests/support/fixtures/shared/build-bundle.js";
