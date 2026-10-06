# Modbus_Client

Master/client. `extends EventEmitter`.

## Construction

```js
import { Modbus_Client } from 'es-modbus';

const client = new Modbus_Client(address, options);
```

- `address`
  - **string** → TCP-family transport: TCP, or RTU-over-TCP when `options.rtu` is true.
  - **non-string** (for example `null`) → serial RTU transport on the device path
    `options.port`, with the serial options below. The client creates the serial port itself;
    it does not accept a port instance.

```js
const client = new Modbus_Client(null, { port: 'COM3', baud_rate: 19200, parity: 'even' });
```

### options

| Option           | Default | Meaning                                                                 |
| ---------------- | ------- | --------------------------------------------------------------------- |
| `port`           | `502`   | TCP port. For a serial client, the serial device path (a non-empty `string`; anything else throws `Invalid serial port`). |
| `rtu`            | `false` | With a string address, use RTU framing over the TCP socket.           |
| `timeout`        | `1000`  | Per-transaction response timeout, ms. On expiry the request rejects and `timeout` is emitted. |
| `delay`          | `20`    | Minimum gap between consecutive frame writes, ms (send pacing).       |
| `reconnect_time` | `10000` | Reconnect delay for TCP and RTU-over-TCP, ms. `> 0` also makes the constructor connect immediately (for serial, open the port); `0` disables automatic reconnection. |
| `modicon_zero_based` | `false` | `true` selects 0-based Modicon point numbering (see below). |
| `baud_rate`      | `9600`  | Serial baud rate, a positive integer (else `Invalid baud rate`). |
| `parity`         | `'none'` | Serial parity: `'none'`, `'odd'`, `'even'`, or `0` = none, `1` = odd, `2` = even. Anything else throws `Invalid parity`. |
| `data_bits`      | `8`     | Serial data bits: `5`, `6`, `7` or `8` (else `Invalid data bits`). |
| `stop_bits`      | `1`     | Serial stop bits: `1`, `1.5` or `2` (else `Invalid stop bits`). |

The serial options (`baud_rate`, `parity`, `data_bits`, `stop_bits`) apply only to a serial
client and are ignored for a TCP-family client. They are checked at construction, which throws on
an invalid one; the serial port itself is created when it is first opened (see "Serial port").

The constructor opens the connection automatically when `reconnect_time > 0`. With
`reconnect_time = 0` the client does not reconnect by itself after the connection is lost, but
it still connects on demand: the first request (or `connect()`) opens the connection.

The numbering base of Modicon addresses is also chosen at construction: 1-based by default, or
0-based with `modicon_zero_based: true` (see "Numbering base" in `spec-protocol.md`). It applies
to Modicon strings only, never to structured PDU ranges, and cannot change afterwards: the
`modicon_zero_based` property is read-only.

## Methods

In `read` and `write`, `range` is either a Modicon string or a structured PDU range (an
array `[func_code, pdu_addr, length]` or an object `{ func_code, pdu_addr, length }`), both
defined in `spec-protocol.md`. `unit_id` is an integer in `0..255`.

Both methods throw synchronously, instead of returning a rejected promise, when an argument is
invalid:

- `range` is not a valid range (`Error('Invalid range format')`), including a length below `1`;
- `unit_id` is not an integer in `0..255`;
- the length exceeds the quantity limit of its function code (see `spec-protocol.md`)
  (`Error('Invalid length <length> for function code <fc>')`), for both forms of range;
- the range ends past PDU address 65535 (`Error('Range exceeds address 65535')`);
- the function code does not belong to the method.

### `read(range, unit_id = 1) → Promise<Buffer>`

Function code and length come from the range:

- **Modicon string** — the table selected by the leading digit gives the read function code
  (1–4); the length is the `,N` suffix, default 1.
- **Structured** — `func_code` must be one of `1, 2, 3, 4`; `length` is the length.

Resolves with the **raw payload bytes** of the response (register words big-endian, or packed
coil bytes) — the caller decodes them. Rejects with:

- a message that identifies the transaction by its transaction ID, on timeout;
- `` `response error: <exception_code>` `` on a Modbus exception;
- an `Error` with the message `connection lost`, if the connection is lost while the request is
  pending, or if the request is issued during a reconnect back-off (see "Connection loss").

### `write(range, value, unit_id = 1) → Promise<boolean>`

For a Modicon string the function code is chosen from the table and the shape of `value`; for a
structured range `func_code` names it, and must be one of `5, 6, 15, 16`.

| Table / FC         | `value`                              | Function code | Notes |
| ------------------ | ------------------------------------ | ------------- | ----- |
| coils (`0…`) / 5   | `boolean`                            | 5 (single)    | Non-boolean throws `Invalid value for coil write`. |
| coils (`0…`) / 15  | `Buffer` of `ceil(length / 8)` bytes | 15 (multiple) | Wrong length throws `Invalid buffer length for coil write`. |
| holding (`4…`) / 6 | integer `0..65535`, or 2-byte `Buffer` | 6 (single)  | |
| holding (`4…`) / 16 | `Buffer` of `length * 2` bytes      | 16 (multiple) | Wrong length throws `Invalid buffer length for register write`. |

Buffers carry big-endian register words and LSB-first packed coil bits.

`length` is the `,N` suffix (default 1) or the structured `length`. For a register `Buffer`
without a `,N` suffix, `length` is `value.length / 2`; a coil `Buffer` always needs `,N`, because
a bit count cannot be derived from a byte count. Writing to a read-only table (discrete inputs
`1…`, input registers `3…`) throws `Write operation not supported for this table`.
Resolves with whether the write was confirmed: a Modbus write response echoes its request (the
function code, unit ID and address, plus the value for FC 5/6 or the quantity for FC 15/16).
`true` when the echo matches the request, `false` when it does not. Rejects like `read` (timeout,
exception response, connection lost).

### `connect() → Promise<void>`

Resolves immediately if already connected; rejects with `Error('ERR_ILLEGAL_STATE')` while a
reconnect back-off is pending; otherwise attempts to connect (for serial, opens the port).

### `disconnect()`

Closes the transport.

## Events

| Event        | Argument            | Fired when                                              |
| ------------ | ------------------- | ----------------------------------------------------- |
| `connect`    | —                   | Transport connected.                                   |
| `disconnect` | —                   | Transport closed.                                      |
| `error`      | `Error` \| `string` | Socket error, or a send attempted with no usable connection. |
| `timeout`    | —                   | A transaction's `timeout` elapsed with no response.    |
| `send`       | `Buffer`            | A frame was written to the wire (full frame incl. MBAP/CRC). |
| `receive`    | `Buffer`            | A frame was parsed from the wire (per frame, before matching). |
| `data`       | resolved value      | A transaction resolved: the payload `Buffer` of a read, or the `boolean` result of a write. |
| `data_error` | —                   | A transaction was rejected (exception or explicit reject). |

`send` / `receive` are the wire-trace hooks; `data` / `data_error` mirror Promise settlement.

## Behavior contract

- **Transaction ID.** On TCP the client puts a transaction ID in every request header; the
  server echoes it and the client matches the response by it. A timeout rejection identifies the
  transaction by this ID. How IDs are allocated is not specified.
- **Concurrency.** On TCP, multiple `read`/`write` calls may be outstanding at once, and
  responses with no matching pending transaction are ignored. RTU-family transports have no
  transaction ID, so only one request may be outstanding at a time and requests must be
  serialized.
- **Broadcast (RTU, RTU-over-TCP).** On a serial bus every request to unit `0` is a broadcast:
  slaves execute a broadcast write, ignore a broadcast read, and never answer. The promise
  resolves as soon as the frame has been written, without waiting for a response: a write with
  `true` (there is no echo to check), a read with an empty `Buffer` (there is no data). It still
  rejects with `connection lost` if the connection is lost before the frame is written. On TCP
  unit `0` is an ordinary unit.
- **Ordering / pacing.** Outgoing frames are queued and written one at a time with at least
  `delay` ms between writes. The queue is bounded (256); on overflow the **oldest** queued frames
  are dropped.
- **Timeouts are per transaction**, not per connection. A late response arriving after timeout is
  discarded.
- **Connection loss.** When the connection is lost, every pending request, whether already sent
  or still queued, is rejected immediately with an `Error` (message `connection lost`) and the
  queued frames are discarded, so no request is executed after it was reported as failed. A
  request issued while a reconnect back-off is pending is rejected at once instead of being
  queued.
- **Reconnect (TCP and RTU-over-TCP).** On `close` or `error`, if `reconnect_time > 0` the client
  retries after that delay; `connect()` called during the back-off rejects with
  `ERR_ILLEGAL_STATE`.
- **Serial port.** The port is created and opened at construction when `reconnect_time > 0`,
  otherwise on demand by the first request or `connect()`; concurrent callers share one open.
  Creating the port loads `serialport` and its native binding, so a platform where the binding
  cannot load fails here, not at import. A failed creation or open emits `error`, rejects
  `connect()`, and rejects every pending request with `connection lost`; a later request or
  `connect()` tries again. A closed serial port is never re-opened automatically (a close usually
  means the device is gone); the next request or `connect()` opens it again. `disconnect()`
  closes the port when it is open.
