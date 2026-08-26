// Keep runtime imports pointed at the built server while deriving their types
// from source, so type-checking E2E specs does not require dist/.
export function importBuiltServerModule<T>(specifier: string): Promise<T> {
	return import(specifier) as Promise<T>;
}
