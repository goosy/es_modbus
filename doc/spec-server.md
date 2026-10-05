# Modbus_Server

Slave/server. `extends EventEmitter`.

## Construction

```js
import { Modbus_Server } from 'es-modbus';

const server = new Modbus_Server(vector, options);
server.start();
```

### options

| Option    | Default     | Meaning                                                                       |
| --------- | ----------- | -------------------------------------------------------------------------- |
| `host`    | `'0.0.0.0'` | Bind address (TCP only).                                                    |
| `port`    | `502`       | `number` → listen on that TCP port. `string` → open as a serial device path. A `SerialPort` instance → use it directly (serial). |
| `rtu`     | `false`     | With a `number` port, use RTU framing on the accepted TCP sockets (RTU-over-TCP). Ignored for serial ports. |
| `unit_id` | all         | Which Modbus unit IDs to answer; every ID when omitted (see `set_unit_ids`). |

### Transport selection

The server's transport is chosen at construction from `port` and `rtu`:

| `port`                        | `rtu`   | Transport      | Behavior                                                        |
| ----------------------------- | ------- | -------------- | --------------------------------------------------------------- |
| `number`                      | `false` | TCP            | Listens on `host:port`; each connection speaks MBAP-framed Modbus TCP. |
| `number`                      | `true`  | RTU-over-TCP   | Listens on `host:port`; each connection speaks RTU frames (unit ID + PDU + CRC16). |
| `string` or `SerialPort`      | ignored | RTU            | Opens the serial port and answers as a Modbus RTU slave.         |

An RTU server is a Modbus slave on a serial line: it has no connections and frames its responses
with CRC-16. Request handling (unit ID routing, the `vector`, exception responses) is identical
across the three transports; only the framing and the lifecycle events differ.

### `set_unit_ids(unit_id)`

- `null`, `undefined`, `'all'`, `'*'` → accept **every** unit ID (0–255). This is the default.
- a `number` → accept only that ID. `0` is an ordinary ID here (the broadcast address); it is not
  a synonym for "every ID".
- an array of numbers → accept exactly those IDs.
- Any ID outside `0..255` (non-integer included) throws.

Requests to a non-accepted unit ID get an exception response with code `0x0B`.

**Broadcast (unit ID `0`).** A request addressed to unit `0` is a broadcast. If unit `0` is
accepted (explicitly, or because every ID is accepted) a write request is executed; a read
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

- `start()` — begins listening (TCP) or opens the serial port. Safe to call again after a prior
  `start()`: it closes and re-opens the listener/port.
- `stop()` — TCP: destroys all live sockets and closes the server. Serial: closes the port.
- `is_valid_unit_id(unit_id)` — whether the server accepts the given unit ID.

## Events

The event names are the same on every transport; the `socket_*` events exist only for the
TCP-family transports (TCP and RTU-over-TCP).

| Event               | Transports      | Argument | Fired when                                  |
| ------------------- | --------------- | -------- | ------------------------------------------- |
| `start`             | all             | —        | The listener or serial port is ready.       |
| `stop`              | all             | —        | The listener or serial port is closed, whether by `stop()` or by the transport itself. |
| `error`             | all             | `Error`  | Transport error.                            |
| `socket_connect`    | TCP-family      | `socket` | A client connected.                         |
| `socket_disconnect` | TCP-family      | `socket` | A client disconnected.                      |
| `socket_error`      | TCP-family      | `Error`  | A per-connection error.                     |
| `send`              | all             | `Buffer` | A frame was written.                        |
| `receive`           | all             | `Buffer` | A frame was received.                       |
| `vector_error`      | all             | `Error`, request | A `vector` function threw; the request was answered with `0x04`. |
