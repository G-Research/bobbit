/**
 * Bootstrap for the worker .js->.ts resolve fallback. Loaded into worker threads
 * via NODE_OPTIONS="--import <this file>" (see enable-ts-worker.ts). Registers
 * the resolve hook on the module loader for the (worker) process it runs in.
 */
import { register } from "node:module";

register("./ts-worker-resolve-hooks.mjs", import.meta.url);
