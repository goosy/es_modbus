---
id: 2kn5yrqz
opened: 2026-10-24T03:14:23.284Z
closed: 2026-10-24T04:28:45.678Z
title: Add discrete input read methods to the vector (single-point and batch)
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [066d076] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

The vector interface has no accessor for discrete inputs (1xxxx): both FC 1 (read coils) and FC 2 (read discrete inputs) call `get_coil`. The vector does not receive the function code, so it cannot tell which table is being read.

On the register side there are two read methods, `get_holding_register` (FC 3) and `get_input_register` (FC 4); on the bit side there is only one, so the read interface is asymmetric.

Impact: coils and discrete inputs cannot use different data. For example, a slave with a writable coil table and a read-only input table should have two distinct points at the same address, one in each table; today FC 1 and FC 2 necessarily read the same value.

## Proposal

Add optional discrete input read methods to the vector, used by FC 2:

| Method | Used for | Returns |
| --- | --- | --- |
| `get_discrete_input(addr, unit_id)` | FC 2 | truthy = bit set |
| `get_discrete_inputs(addr, quantity, unit_id)` | FC 2 | an array of length `quantity`, each element taken as a bit by truthiness |

- Selection order for FC 2: when the vector provides discrete input methods, `get_discrete_inputs` is called once per request if present, otherwise `get_discrete_input` is called per point; when neither is present, FC 2 is handled like FC 1 (`get_coils`, otherwise `get_coil` per point). Vectors that do not distinguish the two tables therefore keep working.
- FC 1 uses only the coil methods and is not affected by the discrete input methods.
- The batch method follows the same rules as issue#yjaww5qx: selected by function code, regardless of quantity; decided on each request; called only for requests that pass `check_request`; a thrown exception answers 0x04 and emits `vector_error`; a return value whose length is not `quantity` is treated as a vector error.
- The batch method depends on the batch read mechanism of issue#yjaww5qx; the two are best implemented together.

## Decision

fixed. Implemented as proposed: FC 2 uses `get_discrete_inputs` or `get_discrete_input` when the vector provides them (batch first), and reads through the coil methods as FC 1 does when neither is present; FC 1 is not affected. Coils and discrete inputs can therefore use different data, and vectors that do not distinguish the two tables keep working.
