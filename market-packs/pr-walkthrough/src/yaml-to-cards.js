// Pack synthesis entry — re-exports the PURE shared YAML → cards synthesis so
// `build:packs` bundles it (with its `yaml` dep inlined) into a self-contained ESM
// at lib/yaml-to-cards.mjs. ONE source of truth: the agent toolchain imports the
// same shared module server-side; the pack's `publish` route (confined Node worker)
// imports this bundle. No duplication of the mapping logic.
import { parseAllDocuments } from "yaml";

export {
	mapYamlToWalkthroughPayload,
	validatePrWalkthroughYaml,
} from "../../../src/shared/pr-walkthrough/yaml-to-cards.ts";
export { changesetIdForGithub } from "../../../src/shared/pr-walkthrough/ids.ts";

export function parsePrWalkthroughYamlValue(yamlText) {
	const documents = parseAllDocuments(String(yamlText ?? ""), { uniqueKeys: true });
	if (documents.length !== 1) throw new Error(`Expected exactly one YAML document, received ${documents.length}.`);
	const [document] = documents;
	if (!document) return null;
	if (document.errors.length > 0) throw document.errors[0];
	return document.toJSON();
}
