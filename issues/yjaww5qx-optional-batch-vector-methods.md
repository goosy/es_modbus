---
id: yjaww5qx
opened: 2026-10-24T02:34:21.148Z
closed: 2026-10-24T04:12:05.578Z
title: Add optional batch read and write methods to the vector
status: fixed       # open | accepted | fixed | rejected | wontfix
fixed_in: [68a16aa] # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

The server calls the vector once for each point of a request. The vector does not know the boundaries of a request, so it cannot handle a request as a whole. The case comes from modbus_emulator: it publishes layout-data blocks as slaves, and every read and write of the data source behind the vector has side effects.

**Write direction (FC 15 / FC 16).** A request writes several coils / registers, and `set_coil` / `set_register` is called once per point:

- Consistency: a `Real` occupies two registers. Once the first register is written, the block has already detected the change and notified subscribers, so subscribers see a half-written value.
- Overhead: change detection and the `write` event happen once per point. Measured for a write of 125 registers: about 13.5 µs point by point, about 7.7 µs as one range write; 125 `write` events versus 1, and the heavier the listener, the larger the gap.

**Read direction (FC 1 / 2 / 3 / 4).** `get_coil` / `get_holding_register` / `get_input_register` is called once per point.

Point-by-point reads are not only a performance issue (a request for 125 registers takes about 10 µs, far less than the communication time); they also produce wrong diagnostics. Example: behind the vector of modbus_emulator is the Ldata of layout-data; each read calls `read_bytes` once, and each call emits one `access` (a diagnostic event reporting the tags read). One FC3 read of 4 registers emits it 4 times, and a Real spanning two registers appears twice; one FC1 read of 16 coils emits it 16 times. The vector cannot handle the request as a whole, so it cannot correct this.

## Proposal

Add optional batch methods to the vector: optional, selected by function code, falling back to per-point calls when absent.

| Method | Used for | Parameters / return |
| --- | --- | --- |
| `set_coils(addr, values, unit_id)` | FC 15 | parameter `values`: an array of booleans |
| `set_holding_registers(addr, values, unit_id)` | FC 16 | parameter `values`: an array of integers in 0..65535 |
| `get_coils(addr, quantity, unit_id)` | FC 1; also FC 2 when the vector has no discrete input methods (see issue#2kn5yrqz) | returns an `Array` or typed array of length `quantity`, each element taken as a bit by truthiness |
| `get_holding_registers(addr, quantity, unit_id)` | FC 3 | returns an `Array` or typed array of length `quantity`, each element an integer in 0..65535 |
| `get_input_registers(addr, quantity, unit_id)` | FC 4 | same as above |

- The single-point write method `set_register` is renamed to `set_holding_register` at the same time, symmetric with `get_holding_register` and the batch `set_holding_registers`. In the protocol only holding registers are writable (FC 6 / FC 16), so the old name is not ambiguous; the rename is only for naming symmetry. This is a breaking change; 0.3.0 is the de facto first release, so it is acceptable.
- When the corresponding batch method exists, it is called once per request; otherwise the per-point method is called for each point. Each method is independent of the others. Selection is by function code regardless of quantity: a single point also uses the batch method. It is decided on each request, so replacing `server.vector` takes effect immediately. FC 5 / FC 6 still call the single-point `set_coil` / `set_holding_register`.
- `values[i]` corresponds to address `addr + i`; each call receives a new array, which the vector may keep.
- Called only for requests that pass `check_request`. A thrown exception is handled the same way as for other vector functions (`vector_error`, exception 0x04). Without a batch write method, an exception thrown in the middle of point-by-point writing ends the request; the points before it are already written.
- When a batch read returns something that is not an `Array` or typed array, whose length is not `quantity`, or whose register values are not integers in 0..65535, it is treated as a vector error: `vector_error` is emitted with a `TypeError`, and the response is 0x04.
- Batch reads return an `Array` or a typed array (such as `Uint16Array`), symmetric with the parameter type of batch writes; the vector may return a view of its own storage directly (such as `subarray`). Returning registers as a big-endian `Buffer`: not adopted, because a typed array can already return the storage directly, and its elements are the register values with no byte decoding needed.
- The consumer modbus_emulator then switches to these methods and completes each request in one range read or write; that is work for that repository.

Why batch writes:

- Consistency (the main reason): all points of a request are written in one step, so a value spanning several registers (such as `Real`) is never exposed to subscribers in a half-written state.
- Work that should happen once per request happens once: locating the data, detecting changes and notifying subscribers (the `write` event) go from once per point to once per request.
- The vector can translate a request into one range write to the data source instead of n.
- Overhead: measured about 1.7 times faster for a write of 125 registers; the heavier the listener, the larger the gain.

Why batch reads:

- Read side effects occur once per request (the main reason): when every read of the data source behind the vector has side effects (such as diagnostic events, access counters, on-demand refresh), a request produces them once instead of once per point. For modbus_emulator, a read request emits only one `access` per block, with no duplicate tags.
- The vector can translate a request into one range read from the data source (such as one `Ldata.read_bytes`) instead of n.
- Symmetric with batch writes, so the vector can handle both read and write directions per request.
- Overhead is a secondary gain: measured about 10 µs for reading 125 registers point by point, about 0.2 µs as one range read.
- Consistency is not a reason for batch reads: the vector is synchronous, so no other code can modify the data between point-by-point reads, and point-by-point reads already yield a consistent snapshot.

## Decision

fixed. Implemented as proposed: the five optional batch methods, and `set_register` renamed to `set_holding_register`, with the contract written into `spec-server`. Batch reads and writes let the vector handle requests as units, solving the visibility of half-written values and the repeated read side effects, and vectors that do not provide batch methods fall back to per-point calls. Switching modbus_emulator to these methods is work for that repository.
