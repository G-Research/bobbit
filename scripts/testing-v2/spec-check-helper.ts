/**
 * spec-check-helper.ts — outputs contract completeness as JSON to stdout.
 * Run via: vite-node scripts/testing-v2/spec-check-helper.ts
 */
import { contractCompleteness, getStoryRegistry } from "../../tests/e2e/ui/spec-framework.js";
import "../../tests/e2e/ui/spec-contracts.js";
import "../../tests/e2e/ui/story-registry.js";

const result = contractCompleteness();
const stories = getStoryRegistry();
console.log(JSON.stringify({
  contracts: result.length,
  stories: stories.size,
  completeness: result,
}));
