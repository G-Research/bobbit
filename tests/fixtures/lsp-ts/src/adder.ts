/**
 * Second `add` symbol — used by the LSP symbolName-shorthand tests in
 * tests/lsp/symbol-name-shorthand.spec.ts to exercise the ambiguity
 * and path-hint disambiguation rules.
 *
 * Adding the method here (rather than mutating math.ts/index.ts) keeps
 * the existing typescript-client.spec.ts coordinate-based assertions
 * (math.ts:0:16, index.ts:2:10) stable.
 */
export class Adder {
	add(a: number, b: number): number {
		return a + b;
	}
}
