// Compatibility entrypoint for extensions that import ../_shared/gateway.js.
// The implementation lives in gateway.ts so TypeScript and JavaScript import
// specifiers both resolve in the raw defaults tree copied into dist/.
export * from "./gateway.ts";
