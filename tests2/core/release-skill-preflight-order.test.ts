import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "vitest";
import {
	evaluatePackedConsumerAudit,
	parseAuditJson,
} from "../../scripts/release-packed-consumer-audit.mjs";

const skill = readFileSync(resolve(process.cwd(), ".claude/skills/release/SKILL.md"), "utf8");
const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as {
	scripts?: Record<string, string>;
};
const preflight = skill.match(/## 2\. Pre-flight quality gates[\s\S]*?```bash\n([\s\S]*?)\n```/)?.[1];

const zeroCounts = {
	info: 0,
	low: 0,
	moderate: 0,
	high: 0,
	critical: 0,
	total: 0,
};

function position(command: string): number {
	assert.ok(preflight, "release skill must contain a fenced pre-flight command block");
	const index = preflight.indexOf(command);
	assert.notEqual(index, -1, `pre-flight command is missing: ${command}`);
	return index;
}

describe("release skill pre-flight order", () => {
	it("audits the built tarball consumer before type-checking and tests", () => {
		assert.equal(
			packageJson.scripts?.["audit:packed-consumer"],
			"node scripts/release-packed-consumer-audit.mjs",
		);
		assert.ok(position("npm ci") < position("npm audit --omit=dev"));
		assert.ok(position("npm audit --omit=dev") < position("npm run build"));
		assert.ok(position("npm run build") < position("npm run audit:packed-consumer"));
		assert.ok(position("npm run audit:packed-consumer") < position("npm run check"));
		assert.ok(position("npm run check") < position("npm run test:unit"));
		assert.ok(position("npm run test:unit") < position("npm run test:e2e"));
	});

	it("keeps mutable advisory availability release-only and blocks every finding", () => {
		assert.match(skill, /Registry advisory availability is deliberately release-only/);
		assert.match(skill, /Any finding blocks publish; there are no release exceptions/);
	});
});

describe("packed-consumer audit decision", () => {
	it("accepts only a zero exit with explicit zero counts at every severity", () => {
		const report = parseAuditJson(JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {},
			metadata: { vulnerabilities: zeroCounts },
		}));

		assert.deepEqual(evaluatePackedConsumerAudit(report, 0), {
			clean: true,
			counts: zeroCounts,
			diagnostics: [],
		});
	});

	it("retains actionable package, path, and advisory details from a vulnerability exit", () => {
		const report = parseAuditJson(JSON.stringify({
			auditReportVersion: 2,
			vulnerabilities: {
				protobufjs: {
					name: "protobufjs",
					severity: "moderate",
					range: "<=7.6.4",
					nodes: ["node_modules/@earendil-works/pi-coding-agent/node_modules/protobufjs"],
					via: [{
						source: 1109682,
						title: "Prototype pollution in protobufjs",
						severity: "moderate",
						range: "<=7.6.4",
						url: "https://github.com/advisories/GHSA-j3f2-48v5-ccww",
					}],
				},
			},
			metadata: {
				vulnerabilities: { ...zeroCounts, moderate: 1, total: 1 },
			},
		}));

		const evaluation = evaluatePackedConsumerAudit(report, 1);
		assert.equal(evaluation.clean, false);
		const diagnostics = evaluation.diagnostics.join("\n");
		assert.match(diagnostics, /1 moderate vulnerability/);
		assert.match(diagnostics, /protobufjs/);
		assert.match(diagnostics, /pi-coding-agent/);
		assert.match(diagnostics, /GHSA-j3f2-48v5-ccww/);
		assert.match(diagnostics, /exited with code 1/);
	});

	it("fails closed on malformed counts, inconsistent entries, and nonzero clean exits", () => {
		const missingSeverity = evaluatePackedConsumerAudit({
			vulnerabilities: {},
			metadata: { vulnerabilities: { ...zeroCounts, critical: undefined } },
		}, 0);
		assert.equal(missingSeverity.clean, false);
		assert.match(missingSeverity.diagnostics.join("\n"), /invalid critical vulnerability count/);

		const hiddenFinding = evaluatePackedConsumerAudit({
			vulnerabilities: { unexpected: { severity: "low", via: [], nodes: [] } },
			metadata: { vulnerabilities: zeroCounts },
		}, 0);
		assert.equal(hiddenFinding.clean, false);
		assert.match(hiddenFinding.diagnostics.join("\n"), /unexpected: severity=low/);

		const failedCleanAudit = evaluatePackedConsumerAudit({
			vulnerabilities: {},
			metadata: { vulnerabilities: zeroCounts },
		}, 2);
		assert.equal(failedCleanAudit.clean, false);
		assert.match(failedCleanAudit.diagnostics.join("\n"), /exited with code 2/);
	});

	it("rejects absent and malformed npm audit JSON", () => {
		assert.throws(() => parseAuditJson(""), /emitted no JSON/);
		assert.throws(() => parseAuditJson("npm error"), /malformed JSON/);
		assert.throws(() => parseAuditJson("[]"), /root must be an object/);
	});
});
