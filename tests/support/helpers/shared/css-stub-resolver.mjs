/**
 * Resolve hook for RemoteAgent unit tests:
 *   - Rewrite `*.css` imports to an empty module.
 *   - Stub the heavy `src/ui/index.ts` barrel (which transitively loads Lit
 *     components with legacy decorators tsx can't lower) with a tiny shim
 *     exporting just the symbols `src/app/custom-messages.ts` consumes at
 *     module init time.
 */
const EMPTY_CSS = "data:text/javascript,export%20default%20%7B%7D%3B";

// Tiny shim: runtime symbols imported by src/app/{custom-messages,storage,...}.ts.
// We only need module-init to succeed; nothing in these tests actually uses
// the storage/UI surfaces. Anything not explicitly listed becomes a no-op via
// the Proxy default in the test file's globals.
const UI_SHIM_SOURCE = `
class _Stub {
  constructor() {}
  getConfig() { return {}; }
  static getMetadataConfig() { return {}; }
}
export function defaultConvertToLlm(msg) { return msg; }
export function registerMessageRenderer() {}
export function setAppStorage() {}
export class AppStorage extends _Stub {}
export class IndexedDBStorageBackend extends _Stub {}
export class CustomProvidersStore extends _Stub {}
export class ProviderKeysStore extends _Stub {}
export class SessionsStore extends _Stub {}
export class SettingsStore extends _Stub {}
export class ShortcutBindingsStore extends _Stub {}
export class ChatPanel extends _Stub {}
`;
const UI_SHIM_URL =
  "data:text/javascript," + encodeURIComponent(UI_SHIM_SOURCE);

// Stub for src/app/api.ts — drops the render-helpers / session-manager /
// storage cascade. RemoteAgent only references `refreshGateStatusForGoal`.
const API_SHIM_SOURCE = `
export async function refreshGateStatusForGoal() {}
export function gatewayFetch() { return Promise.resolve(new Response("{}")); }
export function patchSession() {}
export function startTeam() {}
export function deleteGoal() {}
export function resetPrPollThrottle() {}
export function updateLocalSessionTitle() {}
export function updateLocalSessionStatus() {}
export function clearGoalChildrenFetchedCache() {}
`;
const API_SHIM_URL = "data:text/javascript," + encodeURIComponent(API_SHIM_SOURCE);

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(".css")) {
    return { url: EMPTY_CSS, shortCircuit: true };
  }
  if (
    specifier === "../ui/index.js" ||
    specifier === "../../ui/index.js" ||
    specifier.endsWith("/src/ui/index.ts") ||
    specifier.endsWith("/src/ui/index.js")
  ) {
    return { url: UI_SHIM_URL, shortCircuit: true };
  }
  if (specifier === "./api.js" || specifier.endsWith("/src/app/api.ts") || specifier.endsWith("/src/app/api.js")) {
    return { url: API_SHIM_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
