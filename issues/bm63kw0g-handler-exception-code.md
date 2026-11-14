---
id: bm63kw0g
opened: 2026-11-05T14:20:36.332Z
closed: 2026-11-06T18:58:28.903Z
title: Let a handler specify the exception code
status: fixed       # open | accepted | fixed | rejected | wontfix
labels: []
remote:
---

## Problem

Whatever error a handler throws, the server responds with exception 0x04 (Server Device Failure) and emits `handler_error`. A handler cannot express a problem with the request itself, such as "address not writable"; the client always sees a device failure.

### Background

The handler is supplied by the caller, but the response frame is built and sent by the server. A handler can only return a value or throw, so the server can only take the exception code from the thrown error.

### Requester

The read-only ranges of modbus-emulator: when rejecting an HMI write to a status area, it should respond with 0x02 (Illegal Data Address).

## Proposal

Decide by property, not by `instanceof`: when the error thrown by a handler carries an allowed `exception_code`, the server responds with that code; otherwise it still responds with 0x04 and emits `handler_error`.

- The caller does not need to import any type from this package: `Object.assign(new Error("read-only"), { exception_code: 0x02 })` is enough. Two copies of this package in one process do not affect it either.
- A convenience class `Modbus_Exception` is also exported (e.g. `new Modbus_Exception(0x02)`); it is just an `Error` with that property set. Its constructor checks the code and throws a `RangeError` when it is not in the allowed set, so a wrong code shows up while the handler is being developed.
- Deciding by `instanceof`: not adopted, because the caller would have to import this package, and the check fails when the process holds two copies of it.

### Allowed codes

| Code | Meaning | When a handler uses it |
| --- | --- | --- |
| 0x01 | Illegal Function | The whole server does not support a kind of operation, e.g. a read-only server rejecting all writes |
| 0x02 | Illegal Data Address | The address does not exist or is not writable |
| 0x03 | Illegal Data Value | The value is outside the range the application allows, e.g. a setpoint over its limit |
| 0x04 | Server Device Failure | The handler explicitly reports a device failure |
| 0x06 | Server Device Busy | The data source is temporarily unavailable; the client may retry later |

- An `exception_code` outside this set (e.g. 0x05, 0x10, a non-integer) is treated as an ordinary error: the server responds with 0x04 and emits `handler_error`, so a wrong code from a handler is not silently swallowed.
- 0x05 Acknowledge: not adopted, because it goes with polling for completion through FC 0x0E, which this package does not support.
- 0x08 Memory Parity Error: not adopted, because it is used only with FC 20 / 21, which this package does not support.
- 0x0A / 0x0B (gateway): not adopted for now; they are meaningful only when a handler forwards to downstream devices, and no one needs that yet.

### Events

- A rejection with an allowed code emits neither `handler_error` nor a separate event. It is a response the handler gives on purpose, not a failure; emitting `handler_error` would flood callers that subscribe to it for alerts with normal rejections.
- This matches `check_request`: the requests it rejects (0x02 / 0x03) emit no event either. A handler that wants a log entry can write one before throwing; the frames are visible through the `send` event.
- Explicitly throwing `exception_code: 0x04` does not emit `handler_error` either: the rule only asks whether there is an allowed code, with no special case for 0x04. `handler_error` is only for unexpected errors: errors without an allowed code, and the `TypeError` the server raises when it validates values returned by the handler.
- A separate event (e.g. `handler_exception`): not adopted, because no one needs it; observing all exception responses of the server (`check_request`, illegal function codes, handler rejections) should be designed together, in another issue when needed.

### Rejection in the middle of a point-by-point write

When the handler has no batch write method and throws an error with an allowed code partway through an FC 15 / 16 point-by-point write, the server responds with that code, but the earlier points are already written, as with any error thrown today. A handler that needs to reject a request as a whole should provide the batch write method and check before writing.

## Decision

fixed. Implemented as proposed: when the error thrown by a handler carries an allowed `exception_code` (0x01, 0x02, 0x03, 0x04, 0x06), the server responds with that code and does not emit `handler_error`; otherwise it still responds with 0x04 and emits `handler_error`. `Modbus_Exception` is also exported. The default stays 0x04: by the protocol, 0x02 asserts that the request itself is wrong and belongs to the checking stage; the handler runs in the execution stage, and an error of unknown cause can only be stated truthfully as an execution failure. Switching modbus-emulator to reject writes with 0x02 is work for that repository.
