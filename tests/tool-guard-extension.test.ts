/**
 * Unit tests for generateToolGuardExtension.
 *
 * Motivation: a prior bug used `\"` inside a backtick template literal for the
 * never-policy error message. The escape consumed the quote, producing
 * `"" + toolName + ""` and a TS ParseError that crashed every new session with
 * a role owning a never-policy tool. This spec exists to catch any recurrence.
 *
 * Strategy: for each of 4 policy-input variants, assert
 *   1. Parse-validity — TS transpile emits no error diagnostics.
 *   2. Round-trip import — transpiled CJS loads and default-exports a function.
 *   3. Branch presence — `neverPolicies = {}` literal appears iff no never-tool
 *      was supplied (same sanity check for `askPolicies`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";

import {
	generateToolGuardExtension,
	type ToolPolicyEntry,
} from "../src/server/agent/tool-guard-extension.ts";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tgx-"));

after(() => {
	try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ok */ }
});

interface Variant {
	name: string;
	policies: Record<string, ToolPolicyEntry>;
	hasAsk: boolean;
	hasNever: boolean;
}

const variants: Variant[] = [
	{
		name: "allow-only",
		// 'allow' entries are filtered out by the generator — both maps serialize to {}.
		policies: {
			read: { policy: "allow", group: "fs" },
			write: { policy: "allow", group: "fs" },
		},
		hasAsk: false,
		hasNever: false,
	},
	{
		name: "ask-only",
		policies: {
			bash: { policy: "ask", group: "shell" },
		},
		hasAsk: true,
		hasNever: false,
	},
	{
		name: "never-only",
		// The original-bug shape: role denies a tool outright.
		policies: {
			bash_bg: { policy: "never", group: "shell" },
		},
		hasAsk: false,
		hasNever: true,
	},
	{
		name: "mixed",
		policies: {
			read: { policy: "allow", group: "fs" },
			bash: { policy: "ask", group: "shell" },
			bash_bg: { policy: "never", group: "shell" },
		},
		hasAsk: true,
		hasNever: true,
	},
];

describe("generateToolGuardExtension", () => {
	for (const v of variants) {
		describe(v.name, () => {
			const source = generateToolGuardExtension("sess-" + v.name, v.policies, []);

			const transpiled = ts.transpileModule(source, {
				compilerOptions: {
					module: ts.ModuleKind.CommonJS,
					target: ts.ScriptTarget.ES2020,
				},
				reportDiagnostics: true,
			});

			it("emits no TypeScript error diagnostics", () => {
				const errors = (transpiled.diagnostics ?? []).filter(
					(d) => d.category === ts.DiagnosticCategory.Error,
				);
				const msg = errors
					.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
					.join("\n");
				assert.equal(errors.length, 0, `Expected no error diagnostics, got:\n${msg}`);
			});

			it("transpiled module loads and default-exports a function", async () => {
				const file = path.join(tmpDir, `tool-guard-${v.name}.cjs`);
				fs.writeFileSync(file, transpiled.outputText, "utf-8");
				const mod = await import(pathToFileURL(file).href);
				assert.equal(typeof mod.default, "function");
			});

			it("neverPolicies branch presence matches input", () => {
				assert.equal(
					source.includes("neverPolicies = {}"),
					!v.hasNever,
					v.hasNever
						? "expected neverPolicies to be populated"
						: "expected neverPolicies to serialize to {}",
				);
			});

			it("askPolicies branch presence matches input", () => {
				assert.equal(
					source.includes("askPolicies = {}"),
					!v.hasAsk,
					v.hasAsk
						? "expected askPolicies to be populated"
						: "expected askPolicies to serialize to {}",
				);
			});
		});
	}
});
