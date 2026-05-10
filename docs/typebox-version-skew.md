# TypeBox version skew (pi-mono 0.73+)

## Summary

We pin `@sinclair/typebox` at `^0.34.x` for our own schema authoring. As of
`pi-mono` 0.73, `@mariozechner/pi-ai` (transitive via `pi-agent-core` and
`pi-coding-agent`) depends on `@sinclair/typebox` 1.x. npm hoists both: ours at
the top level, pi-ai's nested under `node_modules/@mariozechner/pi-ai/`.

The two versions are **ABI-compatible at the JSON-schema level** — both produce
the same `{ type, properties, ... }` plain objects that the LLM tool-call
runtime serialises and validates against. They are **not type-compatible at
the TypeScript level**: 0.34's `TSchema` and 1.x's `TSchema` are nominally
distinct, and helpers like `StringEnum()` changed return type between major
versions (1.x returns a `TUnsafe<>` wrapper, not a `TUnion<TLiteral[]>`).

This means any file that **builds a pi-side type** (e.g. `AgentTool<S>`) whose
schema generic `S` is **authored with our pinned 0.34 TypeBox** triggers a
compile error: pi-ai's `AgentTool` expects a `TSchema` from 1.x, and our
`Type.Object(...)` returns a `TSchema` from 0.34.

## Where this matters

Exactly one file mixes both versions:

- `src/ui/tools/artifacts/artifacts.ts` — builds an `AgentTool` whose
  `parameters` schema is authored locally for the artifacts tool.

Server-side tools registered via `pi.registerTool({ parameters: Type.Object(...) })`
are **not affected**: pi-agent-core's `registerTool` accepts the schema as an
opaque JSON-schema-shaped object, so the 0.34/1.x distinction never surfaces in
its type signature.

## Workaround pattern

In any file that has to bridge our 0.34 schemas into a pi-side generic,
two small concessions are required:

1. **Author string-enum fields with `Type.Unsafe<LiteralUnion>` instead of
   pi-ai's re-exported `StringEnum()`.** The Unsafe constructor lets us
   declare the TypeScript literal union directly while emitting the same
   `{ type: "string", enum: [...] }` JSON schema that the LLM sees:

   ```ts
   import { type Static, Type } from "@sinclair/typebox";

   const params = Type.Object({
     command: Type.Unsafe<"create" | "update" | "delete">({
       type: "string",
       enum: ["create", "update", "delete"],
       description: "The operation to perform",
     }),
     // ...
   });
   export type Params = Static<typeof params>;
   ```

2. **Loosen the pi-side generic to `any`** at the bridge point:

   ```ts
   public get tool(): AgentTool<any, undefined> {
     return {
       // ...
       parameters: params as any,
       execute: async (_id, args) => { /* args typed via Static<typeof params> */ },
     };
   }
   ```

   The `Static<typeof params>` type is still recovered locally — only the
   pi-facing surface is widened.

## Why we did NOT migrate to TypeBox 1.x in this goal

- **Out of scope.** The pi 0.73 bump is a pure version-bump goal; adopting new
  upstream APIs is captured as separate follow-ups.
- **The headline 1.x breaking change does not apply to us.** TypeBox 1.x
  un-shimmed the deep-import path `@sinclair/typebox/compiler`. We don't
  import the compiler anywhere in the repo; only the top-level `Type` /
  `Static` surface, which has remained stable.
- **Cost / benefit.** A 0.34 → 1.x sweep touches every server-side tool
  schema, every `Static<>` consumer, and our test fixtures. One file with a
  three-line workaround is cheaper than that sweep until something else
  forces it.

## Future cleanup

When we do migrate to TypeBox 1.x:

- Delete this document.
- Replace the inline `Type.Unsafe<...>` in `artifacts.ts` with pi-ai's
  `StringEnum()` (re-exported by pi-ai as a typed convenience).
- Restore the strict generic on `tool`: `AgentTool<typeof params, undefined>`.
- Drop our top-level `@sinclair/typebox` dependency if pi-ai's nested copy
  hoists cleanly.

## Related

- pi-mono upgrade goal: 0.67.5 → 0.73.1, commit `b24abcae` on
  `goal/upgrade-pi-04ae306d`.
- AGENTS.md debugging entry: "TypeBox version skew (artifacts.ts compile
  error after pi bump)".
