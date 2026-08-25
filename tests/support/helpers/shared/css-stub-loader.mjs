/**
 * Minimal Node ESM loader that resolves `*.css` imports to an empty module.
 * Used by RemoteAgent unit tests that transitively pull in UI components
 * which `import "./foo.css"`. The loader is registered via Node's
 * `--import` flag in the test command.
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./css-stub-resolver.mjs", import.meta.url);
