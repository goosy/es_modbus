---
id: 0hehj5mg
opened: 2026-10-24T04:06:31.416Z
closed: 2026-10-24T04:22:58.090Z
title: Single-point register reads are not checked; an out-of-range value can crash the server
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [3404e7d] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

The spec requires `get_holding_register` / `get_input_register` to return an integer in `0..65535`, but the server does not check the returned value and passes it straight to `buffer.writeUInt16BE` when writing the response (`handle_read_registers`). Observed with an FC 3 single-point read:

| Returned value | Result |
| --- | --- |
| `70000`, `-1` | throws `RangeError` (`ERR_OUT_OF_RANGE`) |
| `1.5` | truncated to 1 |
| `'7'` | converted to 7 |
| `undefined`, `null`, `NaN` | become 0 |

Impact:

- An out-of-range value crashes the server. `RangeError` is not a `Vector_Error`, so `serve()` does not catch it; it propagates out of `on_data` into the `data` event listener of the socket / serial port, becomes an uncaught exception, and the process exits. This breaks the spec's promise that "a faulty `vector` does not crash the server".
- Values that violate the contract are silently converted; the master receives data that looks normal, and the defect in the vector is hidden.

Coils are not affected: the return value of `get_coil` is taken as a bit by truthiness, so any value is meaningful.

The batch read methods of issue#yjaww5qx must also check their return values; single-point reads should follow the same rule.

## Proposal

Single-point register reads use the same check as batch reads: when the returned value is not an integer in `0..65535`, it is treated as a `vector` that threw, emitting `vector_error` with a `TypeError` and responding with exception `0x04`. The implementation shares `is_register_value`.

- `undefined` also counts as an error. A vector relying on "an unmapped address returns `undefined` and reads as 0" will now get `0x04` instead. This is a behavior change; 0.3.0 is the de facto first release, so it is acceptable, and the CHANGELOG notes it.
- Changing only out-of-range values to `0x04` and still silently converting the rest: not adopted, because the rule would be inconsistent and would still hide defects in the vector.

## Decision

fixed. Implemented as proposed: when a register read accessor returns a value that is not an integer in `0..65535`, `vector_error` is emitted with a `TypeError` and the response is `0x04`, `undefined` included. Out-of-range values no longer crash the server, and values that violate the contract are no longer silently converted.
