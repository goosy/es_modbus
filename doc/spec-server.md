# Modbus_Server

Slave/server. `extends EventEmitter`.

## Construction

```js
import { Modbus_Server } from 'es-modbus';

const server = new Modbus_Server(handler, options);
await server.start();
```

### options

| Option    | Default     | Meaning                                                                       |
| --------- | ----------- | -------------------------------------------------------------------------- |
| `name`    | `'Modbus_Server'` | A name for telling instances apart, e.g. in logs; kept in the `name` property. The library does not use it itself. |
| `host`    | `'0.0.0.0'` | Bind address (TCP only).                                                    |
| `port`    | `502`       | `number` → listen on that TCP port. `string` → open as a serial device path. Anything else throws `Invalid port`; a port instance is not accepted. |
| `rtu`     | `false`     | With a `number` port, use RTU framing on the accepted TCP sockets (RTU-over-TCP). Ignored for serial ports. |
| `silence` | `50`        | Silence in ms after which the bytes left of an incomplete frame are resolved (see "Frame delimiting" in `spec-protocol.md`). A finite positive number (else `Invalid silence`). On a serial port at least 3.5 character times (1.75 ms above 19200 baud). |
| `unit_id` | all         | Which Modbus unit IDs to answer; every ID when omitted (see `set_unit_ids`). |
| `baud_rate` | `9600`    | Serial baud rate, a positive integer (else `Invalid baud rate`). |
| `parity`  | `'none'`    | Serial parity: `'none'`, `'odd'`, `'even'`, or `0` = none, `1` = odd, `2` = even. Anything else throws `Invalid parity`. |
| `data_bits` | `8`       | Serial data bits: `5`, `6`, `7` or `8` (else `Invalid data bits`). |
| `stop_bits` | `1`       | Serial stop bits: `1`, `1.5` or `2` (else `Invalid stop bits`). |

The serial options (`baud_rate`, `parity`, `data_bits`, `stop_bits`) apply only when `port` is a
serial device path and are ignored for a TCP port. They are checked at construction, which throws
on an invalid one; the serial port itself is created and opened by `start()`.

### Transport selection

The server's transport is chosen at construction from `port` and `rtu`:

| `port`                        | `rtu`   | Transport      | Behavior                                                        |
| ----------------------------- | ------- | -------------- | --------------------------------------------------------------- |
| `number`                      | `false` | TCP            | Listens on `host:port`; each connection speaks MBAP-framed Modbus TCP. |
| `number`                      | `true`  | RTU-over-TCP   | Listens on `host:port`; each connection speaks RTU frames (unit ID + PDU + CRC16). |
| `string`                      | ignored | RTU            | Opens the serial port and answers as a Modbus RTU slave.         |

An RTU server is a Modbus slave on a serial line: it has no connections and frames its responses
with CRC-16. Request handling (unit ID routing, the `handler`, exception responses) is identical
across the three transports; only the framing and the lifecycle events differ.

### `set_unit_ids(unit_id)`

- `null`, `undefined`, `'all'`, `'*'` → accept **every** unit ID (0–255). This is the default.
- a `number` → accept only that ID. `0` is an ordinary ID here (on a serial bus, the broadcast
  address); it is not a synonym for "every ID".
- an array of numbers → accept exactly those IDs.
- Any ID outside `0..255` (non-integer included) throws.

How unit IDs behave depends on the transport (see "Unit ID" in `spec-protocol.md`):

- **TCP.** Every unit ID, `0` included, is an ordinary unit. A request to an accepted unit is
  served through the `handler`; a request to a non-accepted unit gets an exception response with
  code `0x0B`.
- **Serial bus (RTU, RTU-over-TCP).** The server is one slave on a shared line, so a request to a
  non-accepted unit ID is not answered at all. A request to unit `0` is a broadcast: if unit `0`
  is accepted (explicitly, or because every ID is accepted) a write request is executed; a read
  request is ignored. A broadcast is never answered, whether or not unit `0` is accepted.

## The `handler` interface

The server holds no data. Every request is serviced by calling one of these caller-supplied
functions (names are `snake_case`). Addresses passed in are **PDU addresses**: the **raw on-wire
(0-based)** value as a `number`, never Modicon notation (the server works in PDU addresses only).
`unit_id` is always supplied so one `handler` can back multiple units.

| Method                                            | Used for                        | Returns            |
| ------------------------------------------------- | ------------------------------- | ------------------ |
| `get_coil(addr, unit_id)`                         | FC 1 (coils); FC 2 as a fallback | truthy = bit set |
| `get_discrete_input(addr, unit_id)`               | FC 2 (discrete inputs, optional) | truthy = bit set |
| `get_holding_register(addr, unit_id)`             | FC 3                            | integer `0..65535` |
| `get_input_register(addr, unit_id)`               | FC 4                            | integer `0..65535` |
| `set_coil(addr, value, unit_id)`                  | FC 5, FC 15                     | ignored            |
| `set_holding_register(addr, value, unit_id)`      | FC 6, FC 16                     | ignored            |
| `get_coils(addr, quantity, unit_id)`              | FC 1 (optional); FC 2 as a fallback | `quantity` values, truthy = bit set |
| `get_discrete_inputs(addr, quantity, unit_id)`    | FC 2 (optional)                 | `quantity` values, truthy = bit set |
| `get_holding_registers(addr, quantity, unit_id)`  | FC 3 (optional)                 | `quantity` integers `0..65535` |
| `get_input_registers(addr, quantity, unit_id)`    | FC 4 (optional)                 | `quantity` integers `0..65535` |
| `set_coils(addr, values, unit_id)`                | FC 15 (optional)                | ignored            |
| `set_holding_registers(addr, values, unit_id)`    | FC 16 (optional)                | ignored            |

Only coils and holding registers are writable in Modbus, so the write methods name no other
table.

Argument types: `addr`, `quantity` and `unit_id` are `number`s; for `set_coil`, `value` is a
`boolean`; for `set_holding_register`, `value` is an integer in `0..65535`. For `set_coils`,
`values` is an `Array` of `boolean`s; for `set_holding_registers`, an `Array` of integers in
`0..65535`. `values[i]` is the value for address `addr + i`, and `values.length` is the quantity
of the request. The array is new for each call; the `handler` may keep it.

A batch read method returns an `Array` or a typed array (for example a `Uint16Array`) of exactly
`quantity` values, `values[i]` being the value at address `addr + i`. The server reads it before
the method is called again; the `handler` may return a view of its own storage.

**Batch methods.** The six batch methods (`get_coils`, `get_discrete_inputs`,
`get_holding_registers`, `get_input_registers`, `set_coils`, `set_holding_registers`) are optional. They let a `handler`
handle the points of one request as a whole:

- **Batch writes, consistency**: update a multi-register value in one step instead of exposing
  it half written.
- **Batch writes, performance**: do the per-request work, such as locating the data, detecting
  changes and notifying observers, once per request instead of once per point.
- **Batch reads**: a data source with side effects on each read (diagnostic events, access
  counts, refresh on demand) has them once per request instead of once per point, and a request
  can become one range read of the data source. Consistency is not a reason here: the `handler`
  is synchronous, so point-by-point reads already see one snapshot.

The rules:

- A request calls its batch method once with every point of the request when the `handler` has
  that function; otherwise it calls the single-point method once per point, in ascending address
  order. FC 1 uses `get_coils` / `get_coil`, FC 2 `get_discrete_inputs` / `get_discrete_input`
  (see "Discrete inputs" below), FC 3 `get_holding_registers` /
  `get_holding_register`, FC 4 `get_input_registers` / `get_input_register`, FC 15
  `set_coils` / `set_coil`, FC 16 `set_holding_registers` / `set_holding_register`.
- The choice is made by function code, not by quantity: a request for a single point still uses
  the batch method when there is one. FC 5 and FC 6 always call `set_coil` and
  `set_holding_register`.
- The batch methods are independent: a `handler` may provide any of them.
- The choice is made for each request, when it is served.
- A batch method is called only for a valid request, like any other `handler` function, and a
  throwing one is handled the same way (`handler_error`, exception `0x04`). Without the batch
  method, a `set_coil` / `set_holding_register` that throws stops the request: the points before
  it are written, the rest are not.
- A batch read result that is not an `Array` or typed array, or whose length is not `quantity`,
  is handled as a throwing `handler`: `handler_error` with a `TypeError`, and exception `0x04`.
  Its register values are checked like those of the single-point accessors (see "An invalid
  register value" below).

**The `handler` is synchronous.** Its functions return their values directly; a returned Promise
is not supported. The data must be reachable in real time when a function is called. Keeping the
data in memory (for example in a `Buffer`) is the recommended pattern. Data that lives elsewhere,
such as a PLC, is the caller's responsibility to bring into memory and keep in sync, for example
event-driven; reading from a slow source is not a use case of `Modbus_Server`.

**Discrete inputs.** `get_discrete_input` and `get_discrete_inputs` let a `handler` keep discrete
inputs (FC 2) apart from coils (FC 1); both are optional.

- When the `handler` has either of them, FC 2 uses them: `get_discrete_inputs` once per request
  when present, otherwise `get_discrete_input` once per point.
- When it has neither, FC 2 is served like FC 1, through `get_coils` / `get_coil`, so a `handler`
  that does not tell the two tables apart keeps working.
- FC 1 always uses the coil methods.

The server packs/serializes the values read into the response.

**A throwing `handler`.** If a `handler` function throws, the server emits `handler_error` with the
error and answers the request with exception `0x04` (Server Device Failure) instead of a data
response. Unlike `error`, `handler_error` is ignored when nobody listens, so a faulty `handler`
never brings the server down.

**An invalid register value.** A register read accessor that returns anything other than an
integer in `0..65535` (`undefined`, `null`, a fraction, a string, a value out of range) is handled
as a throwing `handler`: the server emits `handler_error` with a `TypeError` and answers exception
`0x04`. The value is never coerced. Coil read accessors return truthy or falsy, so any value is
valid.

**Invalid requests.** Before calling the `handler`, the server validates the request data and the
address range (see "Exception responses" in `spec-protocol.md`); an invalid request is answered
with an exception and the `handler` is not called.

## Methods

- `start()`, `stop()` — see "Lifecycle".
- `is_valid_unit_id(unit_id)` — whether the server accepts the given unit ID.

## Lifecycle

`start()` and `stop()` return Promises. The `start` / `stop` events are kept and fire as before;
the Promises settle after them.

### `start() → Promise<void>`

Begins listening (TCP-family) or opens the serial port. The first serial `start()` creates the
serial port, which loads `serialport-rs` and its native addon.

- The promise resolves once the listener is listening or the port is open, after the `start`
  event.
- It rejects with the first error before that point: an address in use (`EADDRINUSE`), a serial
  port that cannot be created (for example, its native binding fails to load) or opened. The
  server is then stopped, and a later `start()` tries again.
- **Who handles the failure.** A failure the caller handles in neither way crashes the process,
  as an `error` with no listener always has:
  - With an `error` listener, the server first marks the promise as handled, then emits the error
    as `error` and rejects. A caller that does not await it gets no `unhandledRejection`, so code
    that listens to `error` behaves as before.
  - Without one, nothing is emitted and the promise just rejects. Any ordinary rejection
    handling catches the error: `await` inside `try`, `.then(on_ready, on_fail)`, or
    `.then(on_ready).catch(on_fail)`. Otherwise the rejection is unhandled and Node.js
    terminates the process.
- **Restart.** If the server is already started, `start()` first stops it as `stop()` does (every
  live socket is destroyed, `stop` is emitted), then starts it again; the promise settles on the
  new start.

### `stop() → Promise<void>`

Stops the server. TCP-family: destroys all live sockets and closes the listener. Serial: closes
the port.

- The promise resolves once the listener or the port is fully closed, after the `stop` event; or
  at once if the server is not started (never started, already stopped, or its transport closed
  by itself).
- It never rejects: the caller has nothing to recover, and the server counts as stopped anyway. An
  error while closing is emitted as `error` when the server has an `error` listener, and is
  dropped otherwise.

### Overlapping calls

`start()` and `stop()` run one at a time, in call order: a call made while another is still
pending waits for it to settle, then runs. When the last pending call is of the same kind, a new
call joins it instead and returns the same promise: a second `start()` during a start does not
restart, and a second `stop()` during a stop does not close twice. A call stops being joinable
once it emits its outcome: `start` or `stop`, or the `error` that fails it. A call made from a
listener of that event, or after it, runs anew: `start()` after `start` restarts, and `start()`
after a failure retries instead of receiving the same failure.

For example, `start(); stop(); start();` called together opens, closes and opens again, while
`start(); start();` opens once.

### Errors after start

Once started, a transport error is emitted as `error` as before; with no `error` listener,
`EventEmitter` throws it. A transport that closes by itself (for example, a serial adapter
unplugged) emits `stop`, and the server counts as stopped.

## Events

The event names are the same on every transport; the `socket_*` events exist only for the
TCP-family transports (TCP and RTU-over-TCP).

| Event               | Transports      | Argument | Fired when                                  |
| ------------------- | --------------- | -------- | ------------------------------------------- |
| `start`             | all             | —        | The listener or serial port is ready.       |
| `stop`              | all             | —        | The listener or serial port is closed, whether by `stop()` or by the transport itself. |
| `error`             | all             | `Error`  | Transport error. While `start()` or `stop()` is pending, emitted only when listened to (see "Lifecycle"). |
| `socket_connect`    | TCP-family      | `socket` | A client connected.                         |
| `socket_disconnect` | TCP-family      | `socket` | A client disconnected.                      |
| `socket_error`      | TCP-family      | `Error`  | A per-connection error.                     |
| `send`              | all             | `Buffer` | A frame was written.                        |
| `receive`           | all             | `Buffer` | A frame was received.                       |
| `handler_error`     | all             | `Error`, request | A `handler` function threw; the request was answered with `0x04`. |
