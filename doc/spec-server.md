# Modbus_Server

Slave/server. `extends EventEmitter`.

## Construction

```js
import { Modbus_Server } from 'es-modbus';

const server = new Modbus_Server(vector, options);
await server.start();
```

### options

| Option    | Default     | Meaning                                                                       |
| --------- | ----------- | -------------------------------------------------------------------------- |
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
with CRC-16. Request handling (unit ID routing, the `vector`, exception responses) is identical
across the three transports; only the framing and the lifecycle events differ.

### `set_unit_ids(unit_id)`

- `null`, `undefined`, `'all'`, `'*'` → accept **every** unit ID (0–255). This is the default.
- a `number` → accept only that ID. `0` is an ordinary ID here (on a serial bus, the broadcast
  address); it is not a synonym for "every ID".
- an array of numbers → accept exactly those IDs.
- Any ID outside `0..255` (non-integer included) throws.

How unit IDs behave depends on the transport (see "Unit ID" in `spec-protocol.md`):

- **TCP.** Every unit ID, `0` included, is an ordinary unit. A request to an accepted unit is
  served through the `vector`; a request to a non-accepted unit gets an exception response with
  code `0x0B`.
- **Serial bus (RTU, RTU-over-TCP).** The server is one slave on a shared line, so a request to a
  non-accepted unit ID is not answered at all. A request to unit `0` is a broadcast: if unit `0`
  is accepted (explicitly, or because every ID is accepted) a write request is executed; a read
  request is ignored. A broadcast is never answered, whether or not unit `0` is accepted.

## The `vector` interface

The server holds no data. Every request is serviced by calling one of these caller-supplied
functions (names are `snake_case`). Addresses passed in are **PDU addresses**: the **raw on-wire
(0-based)** value as a `number`, never Modicon notation (the server works in PDU addresses only).
`unit_id` is always supplied so one `vector` can back multiple units.

| Method                                   | Used for                        | Returns            |
| ---------------------------------------- | ------------------------------- | ------------------ |
| `get_coil(addr, unit_id)`               | FC 1 (coils) **and FC 2** (discrete inputs) | truthy = bit set |
| `get_holding_register(addr, unit_id)`   | FC 3                            | integer `0..65535` |
| `get_input_register(addr, unit_id)`     | FC 4                            | integer `0..65535` |
| `set_coil(addr, value, unit_id)`        | FC 5, FC 15                     | ignored            |
| `set_register(addr, value, unit_id)`    | FC 6, FC 16                     | ignored            |

Argument types: `addr` and `unit_id` are `number`s; for `set_coil`, `value` is a `boolean`; for
`set_register`, `value` is an integer in `0..65535`.

**The `vector` is synchronous.** Its functions return their values directly; a returned Promise
is not supported. The data must be reachable in real time when a function is called. Keeping the
data in memory (for example in a `Buffer`) is the recommended pattern. Data that lives elsewhere,
such as a PLC, is the caller's responsibility to bring into memory and keep in sync, for example
event-driven; reading from a slow source is not a use case of `Modbus_Server`.

There is no separate discrete-input accessor — FC 2 reuses `get_coil`. Read accessors are called
once per point across the requested range; the server packs/serializes the results into the
response.

**A throwing `vector`.** If a `vector` function throws, the server emits `vector_error` with the
error and answers the request with exception `0x04` (Server Device Failure) instead of a data
response. Unlike `error`, `vector_error` is ignored when nobody listens, so a faulty `vector`
never brings the server down.

**Invalid requests.** Before calling the `vector`, the server validates the request data and the
address range (see "Exception responses" in `spec-protocol.md`); an invalid request is answered
with an exception and the `vector` is not called.

## Methods

- `start()`, `stop()` — see "Lifecycle".
- `is_valid_unit_id(unit_id)` — whether the server accepts the given unit ID.

## Lifecycle

`start()` and `stop()` return Promises. The `start` / `stop` events are kept and fire as before;
the Promises settle after them.

### `start() → Promise<void>`

Begins listening (TCP-family) or opens the serial port. The first serial `start()` creates the
serial port, which loads `serialport` and its native binding.

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
| `vector_error`      | all             | `Error`, request | A `vector` function threw; the request was answered with `0x04`. |
