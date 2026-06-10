// Pack synthesis entry — re-exports the PURE shared YAML → cards synthesis so
// `build:packs` bundles it (with its `yaml` dep inlined) into a self-contained ESM
// at lib/yaml-to-cards.mjs. ONE source of truth: the agent toolchain imports the
// same shared module server-side; the pack's `publish` route (confined Node worker)
// imports this bundle. No duplication of the mapping logic.
export {
	mapYamlToWalkthroughPayload,
	validatePrWalkthroughYaml,
} from "../../../src/shared/pr-walkthrough/yaml-to-cards.ts";
export { changesetIdForGithub } from "../../../src/shared/pr-walkthrough/ids.ts";
