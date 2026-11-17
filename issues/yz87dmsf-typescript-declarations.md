---
id: yz87dmsf
opened: 2026-11-17T08:32:27.364Z
closed:
title: Ship hand-written TypeScript declarations with the package
status: accepted      # open | accepted | fixed | rejected | wontfix
labels: []
remote:
---

## Problem

The package has no type declaration file, and `exports` in `package.json` has no `types` condition:

- A TypeScript project importing `es-modbus` gets TS7016 (could not find a declaration file) under `strict`, and the whole module is `any` otherwise.
- A JavaScript project gets no completion or checking in the editor for the constructor options, the `handler` methods or the event arguments either.
- The npm page and search results mark typed packages with a "TS" badge, and many users filter by it; a package without types is easily skipped.

`doc/spec.md` currently lists TypeScript types as out of scope, on the grounds that the code documents shapes with JSDoc typedefs.

### Result of generating from JSDoc

Generating declarations from `src/index.js` with `tsc --allowJs --declaration --emitDeclarationOnly` gives an unusable result:

- The internal members of `Modbus_Client` (`send_queue`, `get_tid()`, `make_data_packet()`, `set_serial()`, `_send`, `stream`, and others) all become public declarations; users would rely on them, and an internal refactor would become an API change.
- The client's constructor options and the results of `read()` and `write()` are mostly `any`.
- Making it usable would take JSDoc on all of the source, and an `@internal` tag on every internal member; each tag missed later leaks one internal member.

## Proposal

Ship one hand-written declaration file that describes only the public API defined by the spec:

- `Modbus_Client`: the constructor options (distinguished by transport), `read`, `write`, `connect`, `disconnect`, the state properties, and the events with the arguments of their listeners.
- `Modbus_Server`: `Modbus_Handler` (the single-point methods and the optional batch methods), the constructor options, `start`, `stop`, `set_unit_ids`, and the events with the arguments of their listeners.
- `Modbus_Exception`.

The build puts the declarations in `dist/`, and the `types` condition of `exports` points to them; `files` already includes `dist`.

To keep the declarations from drifting away from the implementation: add `typescript` as a dev dependency, and type-check with `tsc --noEmit` a TypeScript usage file that calls the API as the README examples do, as part of the existing check commands. When the public API changes, the declarations are updated together with the spec.

The spec moves TypeScript types from out of scope into scope: the package ships type declarations that agree with the spec. The source of the declarations and how they are checked go into the design.

Rejected alternatives:

- Generating from JSDoc: it makes internal members public, and needs JSDoc on all of the source plus `@internal` tags maintained from then on, at a cost far above hand-writing about 200 lines of declarations.
- Publishing to DefinitelyTyped (`@types/es-modbus`): it is released apart from the package, its versions drift easily, and users must install one more package.
- Rewriting the source in TypeScript: out of proportion to getting declarations.

## Decision

Accepted: ship hand-written type declarations as proposed. The public API is small and fully defined by the spec; hand-written declarations cover only that part and expose no internal members, and type-checking a usage file with `tsc --noEmit` catches obvious drift between the declarations and the implementation, at a low maintenance cost.
