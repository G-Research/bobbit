import { fileURLToPath } from "node:url";
import { buildGraph } from "../../../scripts/affected/graph.mjs";

/**
 * Read-only repository graph shared by the affected-runner contract partitions.
 * Module evaluation happens during Vitest collection, before per-file execution
 * wall timing starts; consumers must not mutate the graph or its nested sets/maps.
 *
 * Pass the root explicitly because this helper is a prebundled test-support entry;
 * graph.mjs's own import.meta.url would otherwise identify the emitted bundle.
 */
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const AFFECTED_GRAPH = Object.freeze(buildGraph({ repoRoot }));
