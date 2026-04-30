/**
 * Acceptance-criteria parser — re-exported from `src/shared/` so existing
 * server-side import paths continue to work while the client can also
 * import the parser without bundling `node:fs`.
 *
 * See `src/shared/acceptance-criteria.ts` for the implementation and
 * `docs/design/nested-goals.md` §1.3 for the spec.
 */

export { parseAcceptanceCriteria } from "../../shared/acceptance-criteria.js";
