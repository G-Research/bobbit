// Legacy E2E harnesses import this compatibility surface. The implementation
// belongs to tests2 so every E2E coordinator shares the same root validation,
// exclusive acquisition, and stale-lock recovery semantics.
export { withDistServerImportLock } from "../../../tests2/harness/dist-import-lock.js";
