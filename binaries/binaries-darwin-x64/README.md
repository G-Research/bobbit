# @bobbit/binaries-darwin-x64

Bundled `fd` and `rg` binaries for [Bobbit](https://github.com/SuuBro/bobbit) on darwin x64.

This package is installed as an optional dependency of `bobbit`. npm picks the
correct sub-package per `{os, cpu}` automatically — you should not depend on
this package directly.

See `docs/releasing.md` in the Bobbit repo for how binaries are sourced and
versioned, and `src/server/binaries.ts` for the resolver.
