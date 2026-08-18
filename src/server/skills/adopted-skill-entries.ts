import { aggregateAdoptedExtensions, type AdoptedExtensionsMap, type AdoptionScope, type AdoptedExtension } from "../agent/adopted-extensions.js";
import type { PackEntry, LoadedEntity } from "../agent/pack-types.js";
import { scanSkillDirResolved, type SlashSkill } from "./slash-skills.js";

/** The minimal ledger reader needed to compose adopted skill contributions. */
export interface AdoptedSkillLedgerReader {
	getAdoptedExtensions(scope: AdoptionScope): Record<string, AdoptedExtension>;
}

export interface AdoptedSkillEntryOptions {
	/** Server-owned ledger for server and global-user adoptions. */
	serverConfigStore?: AdoptedSkillLedgerReader;
	/** Owning project's ledger. Never substitute another project's store here. */
	projectConfigStore?: AdoptedSkillLedgerReader;
	/** Project whose project-scope records may be exposed. */
	projectId?: string;
}

function recordsFor(store: AdoptedSkillLedgerReader | undefined, scope: AdoptionScope): Record<string, AdoptedExtension> | undefined {
	return typeof store?.getAdoptedExtensions === "function" ? store.getAdoptedExtensions(scope) : undefined;
}

/**
 * Builds the existing SkillLoader input for one adoption scope.
 *
 * This is deliberately an adapter, not a parser or cache: it aggregates the
 * durable ledger with project isolation, scans the stock directory through the
 * shared scanner, then gives the established PackResolver synthetic entries.
 */
export function adoptedSkillEntries(
	scope: AdoptionScope,
	options: AdoptedSkillEntryOptions,
): PackEntry[] {
	const records: AdoptedExtensionsMap = {
		server: recordsFor(options.serverConfigStore, "server"),
		"global-user": recordsFor(options.serverConfigStore, "global-user"),
		project: recordsFor(options.projectConfigStore, "project"),
	};
	return aggregateAdoptedExtensions(records, options.projectId)
		.filter((record) => record.scope === scope && record.kind === "skills" && record.enabled)
		.flatMap((record): PackEntry[] => {
			try {
				const directory = "directory" in record.source ? record.source.directory : "";
				const skills = scanSkillDirResolved(directory, "custom").skills.map((skill): LoadedEntity<SlashSkill> => {
					const name = `adopt-${record.id}--${skill.name}`;
					return { name, item: { ...skill, name } };
				});
				return [{
					id: `adopt:${record.scope}:${record.id}`,
					kind: "adopted",
					adoptionId: record.id,
					scope: record.scope,
					path: directory,
					readOnly: true,
					onlyTypes: ["skills"],
					layout: "skills-flat",
					preloaded: { skills },
				}];
			} catch {
				// A bad adoption is isolated so it cannot hide unrelated skills.
				return [];
			}
		});
}
