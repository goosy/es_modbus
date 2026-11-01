---
id: fnhetwc4
opened: 2026-10-24T06:26:15.703Z
closed: 2026-10-24T06:26:35.586Z
title: Rename the server's vector to handler
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [36ac96a] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

The first parameter of `Modbus_Server` is called `vector`, a name inherited from `ServerTCP(vector, options)` of `modbus-serial`.
There, `vector` is a set of callbacks (`getCoil`, `getHoldingRegister`, etc.), meaning something close to an "interrupt vector table":
function codes mapped to handler functions.

The name does not fit this library:

- In a JS context, "vector" first suggests an array or a mathematical vector. Batch reads can also return a typed array,
  so a phrase like "the `vector` returns an array" is even more confusing.
- Its actual role is the data model or handler behind the server, which the name does not say.
- Users who do not know `modbus-serial` cannot tell what it means without looking it up in the documentation.

This library is an independent Modbus library and does not need to keep the naming of `modbus-serial`.

## Proposal

Rename `vector` to `handler`: the name is short, its meaning is obvious at a glance, and `handler_error` also reads more naturally than `vector_error`.
Related names are renamed along with it:

- The constructor parameter `vector` becomes `handler`, the `ModbusVector` type becomes `Modbus_Handler`,
  `Vector_Error` becomes `Handler_Error`, and `call_vector()` becomes `call_handler()`.
  The constructor parameter is positional, so these renames do not affect callers.
- The instance property `vector` becomes `handler`, and the event `vector_error` becomes `handler_error`. This is breaking for callers,
  but 0.3.0 is the de facto first release and is still in the phase of breaking changes, and nobody uses this property or event yet.
  The CHANGELOG notes it.

## Decision

fixed. Renamed as proposed: `vector` becomes `handler`, the `vector_error` event becomes `handler_error`, and the related types,
error class and methods are renamed along with it. As an independent Modbus library it should use names that are clear at a glance; the breaking part
happens before the first release, and nobody uses it yet.
