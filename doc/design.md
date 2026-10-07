# Design

**How** the library is built: internal mechanics, implementation status, known gaps, and TODOs.
Behavior contracts are in the `spec-*` series; this file documents implementation and rough edges
so future changes are made with eyes open. This is the single design document for now; split it
into `design-<topic>.md` files when it grows.

## Transport selection

- **Client.** The constructor sets `this.protocol`: `tcp`, `rtu_over_tcp` (string address with
  `rtu: true`), or `rtu` (non-string address). For `rtu` it checks the serial options with
  `serial_settings` and calls `set_serial` with the result; the port is created later.
- **Decoding.** Response decoding branches on `protocol === 'tcp'` **only**, so `rtu_over_tcp` is
  decoded with the RTU parser (`parse_rtu_response`).
- **Server.** The constructor keeps `port` as given: a `number` (TCP) or a `string` device path,
  whose options `serial_settings` checks into `this.serial_settings`; anything else throws.
  It sets `this.protocol` with the client's values: `tcp`, `rtu_over_tcp` (number port with
  `rtu: true`), or `rtu` (string port; `rtu` is ignored). `is_tcp` is a getter:
  `typeof this.port === 'number'`, true for both TCP-family transports. The serial port is
  `this.serial_port`, created by the first `start()` (`start_serial`, which shares one pending
  creation and resets it on failure so a later `start()` retries); `send_response` and `stop`
  use it.
- **`src/serial.js`.** `serial_settings` validates the snake_case options and maps them to the
  `serialport` settings (`port` → `path`, `baud_rate` → `baudRate`, `parity` with `0`/`1`/`2`
  mapped to `none`/`odd`/`even`, `data_bits` → `dataBits`, `stop_bits` → `stopBits`).
  `create_serial_port` makes a closed `SerialPortStream` (`@serialport/stream`) with the
  `autoDetect()` binding of `@serialport/bindings-cpp` and `autoOpen: false`. It reaches both
  packages through dynamic `import()`, never a static one: Rolldown turns a static import of a
  CommonJS package into a top-level `require` that would run at import and load the native
  binding, while a dynamic import becomes a deferred `require` inside the same file
  (`codeSplitting: false`). Importing the two packages instead of `serialport` leaves its unused
  parsers out of the bundle. `set_serial_port_factory` swaps the factory for tests.
- **Client serial lifecycle.** `set_serial` assigns `_open`, which creates the port once (a
  failed creation is forgotten, so the next attempt retries), attaches its events
  (`listen_serial`), and opens it (concurrent callers share one attempt). A failure runs
  `abort_pending()` and emits `error`. The connection phase follows the port's `open` / `close`
  / `error` events (see "Client connection state"). A serial port never enters `BACKING_OFF`:
  after a close it goes to `IDLE`, and a closed port is re-opened only on demand.

## Build (`build.js`)

- Bundles `src/index.js` with the Rolldown API into the single ES module `dist/modbus.js`.
  `transform.define` replaces `__dirname` with `import.meta.dirname`: the bindings locate their
  prebuilds with `path.join(__dirname, "../")`, and an ES module has no `__dirname`. The bundle
  therefore finds them at `dist/../prebuilds`, the package root. `__dirname` appears only there
  in the bundled code, so the replacement touches nothing else.
- Replaces `prebuilds/` with a copy of `@serialport/bindings-cpp`'s `prebuilds/`, unchanged:
  `node-gyp-build` picks `prebuilds/<platform>-<arch>/` and, on Linux, the glibc or musl file.
- Writes `THIRD_PARTY_LICENSES` from the bundle's module IDs: every `node_modules` package in
  the bundle with its name, version, license and license file, packages with the same license
  text sharing an entry. The native prebuilds belong to `@serialport/bindings-cpp`, which is
  among them.
- A user who bundles es-modbus again moves `import.meta.dirname` to their own bundle; they must
  copy `prebuilds/` next to it, or keep es-modbus external.

## Client range argument (`read` / `write`)

**Address and range.** `read()` / `write()` take a *range* (see "Range notation" in
`spec-protocol.md`): a start address and a length, with the function code (or the table's
function codes) as attributes of the range. An *address* is a single point: a Modicon address
(`"40001"`) or a PDU address (`pdu_addr`, the number on the wire). The parsers turn every form
of range into the same internal range object: `parse_modicon_range` handles the Modicon form,
`parse_pdu_range` the structured PDU range, and the client's `resolve_range` picks one of them.

The forms accepted for `range` (a Modicon string, or a structured array / object) and the rules
for their fields are defined in `spec-protocol.md`; the client-side validation is in
`spec-client.md`. How they are implemented:

- **Type split first.** `read()` / `write()` call `resolve_range`, which looks at the type of
  `range` before anything else: a `string` goes to the Modicon parser (`parse_modicon_range`),
  anything else to the structured-range validator (`parse_pdu_range`). Either one returning
  `null` throws `Invalid range format`.
- **Numbering base.** The constructor option `modicon_zero_based` (default `false`, i.e.
  1-based) only affects the Modicon parser. A structured `pdu_addr` is used unchanged.
- **Function code lookup.** A Modicon string finds its table through `MB_prefix_dict`, keyed by
  the leading digit. A structured `func_code` finds its table and access direction (`read` /
  `write`) through `MB_func_dict`, keyed by function code. A function code of the wrong
  direction for the method throws `Function code <fc> is not a read function` (or `write`).
- **Structured validation.** `parse_pdu_range` takes an array of exactly three elements or an
  object with the three fields (other keys are ignored); each must be a `number`, `pdu_addr` an
  integer in `0..65535`, and `length` an integer `>= 1`.
- **Range checks.** After the range is parsed and the function code chosen, `check_range()`
  applies the same two checks to both forms: the length must be within `MAX_QUANTITY[func_code]`
  (`Invalid length …`), and `pdu_addr + length` must not exceed `0x10000`
  (`Range exceeds address 65535`). `write()` runs it after `check_write_value`, so a value that
  does not fit the function code is reported first.
- **Explicit function code.** With a Modicon string `write()` infers the function code from the
  shape of `value` (`infer_write`); with a structured range it takes `func_code` as given.
  In both cases `check_write_value` then validates `value` against the function code and length,
  and for FC 16 rejects an odd-length `Buffer` as a wrong buffer length.
- **One transaction path.** Both methods end in `transact()`, which allocates the TID, builds the
  frame and stores the packet.

## Frame construction pipeline (`Modbus_Client.make_data_packet`)

A single routine builds every outgoing frame regardless of transport:

1. Allocate a TCP-shaped buffer: 12 bytes for reads / single writes, `13 + data_bytes` for
   FC 15/16.
2. Write the PDU at offset 6 (`unit_id`, `func_code`, `start_address`, then per-FC fields).
   - FC 1–4: quantity at offset 10.
   - FC 5: `0xFF00` / `0x0000` at offset 10.
   - FC 6: 16-bit value at offset 10.
   - FC 15/16: quantity at 10, byte count at 12, data from 13.
3. The start address is the PDU address and is written unchanged. The Modicon→PDU conversion
   (`point - 1` by default, `point` when the client was constructed with
   `options.modicon_zero_based = true`) has already been done by the Modicon parser.
4. If `protocol === 'tcp'`: fill MBAP (offsets 0–5) and return.
   Else: drop the 6-byte MBAP prefix, append CRC-16 little-endian, return the RTU frame.

## Client transaction lifecycle

- **Packet table.** `#packets` is a plain array indexed by `tid - TRANSACTION_START`
  (`TRANSACTION_START = 8000`). `set_packet` / `get_packet` wrap the offset math. `packets_length`
  is 256.
- **TID allocation (`get_tid`).** Non-TCP always returns `TRANSACTION_START` (RTU has no
  transaction field). TCP increments `#last_tid` and wraps back to `TRANSACTION_START` once it
  passes `packets_length + TRANSACTION_START`. With 256 slots and no check that a slot is free,
  more than 256 simultaneously-pending TCP transactions would collide.
- **`process_packet_transaction`.** While `BACKING_OFF`, `DISCONNECTING` or `DISCONNECTED` it
  returns a Promise already rejected with `Error('connection lost')`; the frame is never queued.
  For `BACKING_OFF` only, it also emits `error`, and only when the client has an `error`
  listener: emitting `error` with no listener throws, and a call with valid arguments must not
  throw synchronously.
  Otherwise it sets `status = 'pending'`, bumps `#trans_count`, creates the Promise,
  then enqueues the buffer and returns the Promise. It stores `resolve` / `reject` closures on the packet plus a
  `timeout_id`. `end_transaction` decrements the count, stamps `status`, clears the timer, and
  swaps `resolve`/`reject` for `DO_NOTHING` so a late/duplicate response is inert.
- **Framing (`on_data`).** The chunk is appended to `unprocessed_buffer` and cut by
  `split_frames` with `mbap_frame_length` (`tcp`) or `rtu_response_length`. `#keep` stores `rest`
  in `unprocessed_buffer` and, when it is not empty, restarts `#silence_timer` (`#silence`, see
  "Silence" below).
  `#on_silence` runs `resync_frames` on the bytes left, keeps what is still left on TCP (without
  a new timer) and discards it on a serial port. `#transport_opened` and `#transport_lost` empty
  the buffer. A response length is never `UNKNOWN`, so the client has no unknown-length case.
- **Matching (`on_data`).** For each frame: parse → emit `receive` → skip `func_code === 0` → look up by `tid` →
  ignore unless `status === 'pending'` → `reject` on `exception_code`, else resolve: a read with
  `response.data`, a write with `echo_matches()`.
- **Write echo.** `transact()` stores `packet.echo`, the value a write response must echo after
  its address (`expected_echo()`: `0xFF00` / `0x0000` for FC 5, the value for FC 6, the quantity
  for FC 15/16; `undefined` for a read). `echo_matches()` compares the response's function code,
  unit ID, start address and echoed value or quantity with the request; the write resolves with
  the result.

## Send queue / backpressure (`send` → `sending`)

- `send_queue` is an array of `{ buffer, on_sent }` capped at `send_queue_size` (256); overflow
  splices off the **front** (oldest dropped). `on_sent`, if given, runs right after the buffer
  is passed to `_send`. A broadcast packet (`packet.broadcast`: any request to unit `0` on a
  non-TCP protocol) resolves through it, since no response will come: a write with `true`, a
  read with an empty `Buffer`.
- `sending` is guarded by `#busy` and returns at once when the queue is empty. When connected it
  shifts one buffer, calls `_send`, then after
  `delay` ms clears `#busy` and re-enters. This serializes writes and paces them.
- In `IDLE` (or joining a `CONNECTING`), `sending` starts a connect with itself as the success
  callback. It never
  connects from another phase: a back-off or a manual close starts only after `abort_pending()`
  has emptied the queue, and requests issued then are rejected before they are queued.
- **`abort_pending()`.** Empties `send_queue` and rejects every packet whose `status` is
  `'pending'` with `Error('connection lost')`. It runs on every transport `close` / `error`
  (through `#transport_lost`, for the TCP socket and the serial port) and on a `disconnect()`
  from `IDLE` or `BACKING_OFF`, so a failed on-demand connect also fails its requests at once.

## Client connection state

### Phases

The connection is in exactly one of six phases, kept in one private integer `#state`. Setting a
phase is a single assignment, so two phases can never be true at once and nothing has to be
reset. The phase constants live in a module-level frozen object
`STATE = Object.freeze({ IDLE, CONNECTING, CONNECTED, DISCONNECTING, DISCONNECTED, BACKING_OFF })`.

| `#state`        | Read-only getter   | Meaning                                                     |
| --------------- | ------------------ | ----------------------------------------------------------- |
| `IDLE`          | `is_idle`          | Not connected; automatic and on-demand connects are allowed. |
| `CONNECTING`    | `is_connecting`    | A connect (TCP) or open (serial) is in progress.            |
| `CONNECTED`     | `is_connected`     | The transport is open.                                      |
| `DISCONNECTING` | `is_disconnecting` | `disconnect()` was called; the transport has not closed yet. |
| `DISCONNECTED`  | `is_disconnected`  | Closed by `disconnect()`; only `connect()` leaves it.       |
| `BACKING_OFF`   | `is_backing_off`   | The connection was lost and a reconnect timer is pending.   |

The getters are the only way the rest of the class reads the phase: no code compares `#state`
outside them. `enable_reconnect` (see `spec-client.md`) is also a getter:
`!(is_disconnecting || is_disconnected)`.

`IDLE` and `DISCONNECTED` are both "not connected, nothing in progress". They differ only in who
may connect next: anyone (`IDLE`), or only `connect()` (`DISCONNECTED`). The names follow the
client's own vocabulary, `connect` → `CONNECTING` → `CONNECTED` and `disconnect` →
`DISCONNECTING` → `DISCONNECTED`, not the transport's `close`.

### Transitions

| From                       | Trigger                                                   | To              |
| -------------------------- | --------------------------------------------------------- | --------------- |
| (construction)             | —                                                         | `IDLE`          |
| `IDLE`                     | construction with `reconnect_time > 0`; on-demand connect by `sending`; `connect()` | `CONNECTING` |
| `DISCONNECTED`             | `connect()`                                               | `CONNECTING`    |
| `BACKING_OFF`              | reconnect timer fires                                     | `CONNECTING`    |
| `CONNECTING`               | transport `connect` / `open`                              | `CONNECTED`     |
| `CONNECTING` / `CONNECTED` | transport `close` / `error`, TCP-family, `reconnect_time > 0` | `BACKING_OFF` |
| `CONNECTING` / `CONNECTED` | transport `close` / `error`, otherwise (serial, or `reconnect_time = 0`) | `IDLE` |
| `CONNECTING` / `CONNECTED` | `disconnect()`                                            | `DISCONNECTING` |
| `DISCONNECTING`            | transport `close` (or `error`)                            | `DISCONNECTED`, then `CONNECTING` if a `connect()` is waiting |
| `IDLE` / `BACKING_OFF`     | `disconnect()` (cancels the timer when backing off)        | `DISCONNECTED`  |

Any trigger not in the table leaves the phase unchanged: `connect()` while `CONNECTING` joins the
attempt in progress, `connect()` while `CONNECTED` resolves at once, `connect()` while
`BACKING_OFF` rejects with `ERR_ILLEGAL_STATE`, `disconnect()` while `DISCONNECTING` shares the
close in progress, and `disconnect()` while `DISCONNECTED` resolves at once.

### Rules

- **One event per loss moves the phase.** The transports report to `#transport_opened()` and
  `#transport_lost(error, emit_disconnect)`; the latter runs `abort_pending()` and moves the
  phase only from `CONNECTING`, `CONNECTED` or `DISCONNECTING`, so a repeated report changes
  nothing. Each transport makes sure one loss is reported once:
  - **TCP.** A socket emits `close` after every `error`, so only `close` reports the loss;
    `error` just keeps the error for the callers of a failed connect and emits it. Moving on
    `error` would let the `close` that follows it be taken for the loss of a newer attempt. This
    replaces the old de-duplication by `_conn_failed`.
  - **Serial.** A port may emit `error` with no `close` after it. An `error` on a port that is
    still open closes the port, and its `close` reports the loss; an `error` on a closed port
    reports it at once. This is the only place the serial code reads `isOpen`.
- **Reconnect timer.** `#reconnect_timer` holds the handle of the pending timer. It is a
  resource, not a phase: it is non-null exactly while `BACKING_OFF`. Entering `BACKING_OFF`
  starts it; the timer callback clears it before moving to `CONNECTING`; `disconnect()` clears it
  with `clearTimeout`.
- **Waiting `connect()`.** A `connect()` called while `DISCONNECTING` is kept as a pending
  resolver, also a resource, not a phase. The `close` that ends `DISCONNECTING` starts it. A
  `disconnect()` called before that rejects it with `connection lost`.
- **Requests.** `process_packet_transaction` rejects a request at once with `connection lost`
  while `BACKING_OFF`, `DISCONNECTING` or `DISCONNECTED`. It emits `error` (when listened to) only
  for `BACKING_OFF`: in the other two the caller closed the connection. In `IDLE` the request is
  queued and `sending` connects on demand; it never connects from any other phase.
- **Closing the transport.** `disconnect()` from `CONNECTING` or `CONNECTED` calls the
  transport's `_close()`. TCP destroys the socket (`socket.destroy()`), not `end()`: on a dead
  link the peer's FIN never comes and the close would hang. Serial closes the port; a serial open
  cannot be aborted, so from `CONNECTING` the port is closed as soon as the open settles, and an
  open that fails instead reports the loss itself. The `disconnect()` promise resolves on the transition to `DISCONNECTED`,
  after the `disconnect` event. From `IDLE` or `BACKING_OFF` no transport event follows, so
  `disconnect()` runs `abort_pending()` itself and resolves at once.
- **`#busy` is not a phase.** It marks the `delay` gap after a frame write and is independent of
  the connection phase, so it stays a separate boolean.

### Transport hooks

Each transport assigns `_send(data)`, `_open()` and `_close()`. `_open()` is called only on
the move into `CONNECTING`; a caller that arrives while `CONNECTING` is added to
`#connect_waiters` instead, so concurrent callers share one attempt.

- **TCP (`set_tcp`).** `_open()` is `socket.connect`; the socket's `connect` event reports
  `#transport_opened()`. A socket is reused for every attempt.
- **Serial (`set_serial`).** `_open()` creates the port once (the `creating` promise, a
  lazy-creation cache, not a phase) and opens it; the `opening` promise lets `_close()` wait for
  an open in progress. The open callback, not the `open` event, reports `#transport_opened()`.

## Parser notes (`src/util.js`)

- `parse_modicon_range(address_str, zero_based)` returns
  `{ type, fm_read, fs_write, fm_write, pdu_addr, length }` (fields absent for tables that lack
  that operation) or `null` for a non-string, a string that does not match, an unsupported table
  digit, a point out of range, or a `,0` length. It is built from three steps: `split_modicon`
  (the regular expression; the 5- and 6-digit forms differ only in the point's digit count),
  the `MB_prefix_dict` lookup of the table digit, and `point_to_pdu_addr` (applies the numbering
  base; a PDU address outside `0..65535` rejects the point, which yields the ranges of
  `spec-protocol.md` for both forms and both bases).
- `read()` / `write()` validate their arguments before building a frame and throw synchronously:
  `unit_id` must be an integer in `0..255`, the length must be within `MAX_QUANTITY` (exported
  from `src/util.js`) for the function code, and an FC 6 value must be an integer in `0..65535`.
- Supported function codes and PDU lengths are validated per function: exact length for
  fixed-size functions, `7 + byte_count` for the multiple-write requests. Any failure yields
  `func_code: 0`, which callers drop.
- **Framing is separate from parsing.** The frame length functions (`mbap_frame_length`,
  `rtu_request_length`, `rtu_response_length`) read the start of a buffer and return a length or
  `NEED_MORE` / `INVALID` / `UNKNOWN` (exported constants), following the table in
  `spec-protocol.md` ("Frame delimiting"). They return a length as soon as the bytes that decide
  it are present; whether the buffer holds that many is the caller's test. Once the whole RTU
  frame is present they also check its CRC (`rtu_length`) and return `INVALID` when it is wrong,
  so a frame length > 0 with enough bytes always means a complete, valid frame.
- **`split_frames(buffer, frame_length)`** is pure and returns `{ frames, rest }`; the caller
  holds `rest` and passes it back joined with the next chunk. In a loop from `pos`: a complete
  frame is cut off; `INVALID` calls `resynchronize` (the first offset after `pos` whose length is
  > 0 and fully present; `UNKNOWN` offsets never qualify) and else moves `pos` on by one byte;
  once a search finds nothing, later ones in the same call are skipped (`none_follows`), since
  nothing follows a later `pos` either. `NEED_MORE`, `UNKNOWN` or too few bytes stop the loop.
  A single chunk is used without a copy.
- **`resync_frames(rest, frame_length)`** is what a silence timer calls: it resumes delimiting at
  the first complete frame after the start of `rest` (`resynchronize` from 0), or returns `rest`
  unchanged. The search is safe at any time: a stream is ordered, so a complete frame cannot
  follow a correct frame that is still incomplete. No separate size cap is needed: a length
  function never exceeds the maximum ADU, so `rest` stays below one. A resynchronization costs
  at most one CRC per offset over a few hundred bytes, and runs only on an error or a silence
  with bytes left.
- **Silence.** Both constructors read the `silence` option with `silence_option` (`util.js`):
  `DEFAULT_SILENCE_MS` (50) when nullish, else a finite positive number, or `Invalid silence` is
  thrown. A TCP-family transport uses it as is; a serial one uses `silence_time(settings,
  silence)` (`serial.js`), which is `max(t3.5, silence)`, t3.5 being 3.5 character times, or
  1.75 ms above 19200 baud. The result is `#silence`.
- The four parsers (`parse_tcp_request` / `_response`, `parse_rtu_request` / `_response`) each
  parse **one** delimited frame and return one object. They still check the PDU layout and the
  CRC, since an unknown-length request reaches them as whatever bytes were received.
- `modbus_crc16(bytes, previous?)` is table-driven (256-entry `Int32Array`); `previous` allows
  incremental computation across chunks.
- RTU parsers synthesize `tid = TRANSACTION_START` (8000, since RTU has no transaction field), validate PDU length (`3..253`), validate the
  per-FC byte layout, then verify CRC — any failure collapses to `{ tid, func_code: 0, buffer }`.
- Request parsers set `illegal_function` (alongside `func_code: 0`) for a frame whose function
  code is unsupported but within `1..127`; for RTU only when the CRC over the whole buffer is
  valid. Every other failure leaves it `undefined`.
- Response parsers treat `func_code > 127` with a 3-byte PDU as an exception and read the
  exception byte; anything else unrecognized becomes `func_code: 0`.

## Server dispatch notes

- Framing follows `this.protocol`: `on_data` chooses the parser, `send_response` the framing,
  and `_on_data` the serial-bus semantics from it. The `socket` argument only says where the
  response is written: a socket for both TCP-family transports, the serial port when absent.
- `handle_read_bits` serves FC 1 and FC 2; `handle_read_registers` serves FC 3 (holding) and
  FC 4 (input), branching on `function_code === 3`.

### Request flow

1. `on_data(chunk, socket?)` — append the chunk to the bytes left for that socket (`#pending`,
   a `Map` keyed by socket; the serial port's under `undefined`), and cut them with
   `split_frames` (`mbap_frame_length` for `tcp`, else `rtu_request_length`). On `rtu_over_tcp`
   a `rest` of `UNKNOWN` length is taken at once as one frame (`take_unknown`). `#keep` stores
   the rest and, when it is not empty, restarts its timer in `#silence_timers` (`#silence`:
   see "Silence" under the codec notes); a socket's
   entries are cleared on its `close`, the serial port's on its `close`. `#on_silence` takes a
   serial `rest` of `UNKNOWN` length as one frame, and otherwise runs `resync_frames`, then
   `take_unknown` on RTU; what is still left is discarded on a serial port and kept on TCP,
   without a new timer.
   Each frame goes to `#on_frame`, which parses it with `parse_tcp_request` for `tcp`, else
   `parse_rtu_request`, and emits `receive`. A frame with `func_code: 0` is dropped, unless
   the parser set `illegal_function`; then it goes on with that function code.
2. `_on_data(request, socket?)` — `serial_bus` is true for RTU framing (`rtu` and
   `rtu_over_tcp`). On a serial bus a broadcast (unit `0`) is never
   answered: if unit `0` is accepted and the function is a write (5, 6, 15, 16) it is served and
   the response discarded, anything else is dropped; a non-accepted unit ID is dropped silently.
   On TCP unit `0` is ordinary and a non-accepted unit ID gets `0x0B`. Otherwise `serve()` calls
   `dispatch()`, which switches on `func_code` to the matching `handle_*` method; that method
   calls into `vector` and builds the response PDU. An unsupported function code → exception
   `0x01` under its own function code (`fc | 0x80`).
   - Before any `vector` call, `check_request()` validates a supported request as the Modbus
     application protocol does: `0x03` for a quantity outside `1..MAX_QUANTITY[fc]`, a byte count
     that does not match the quantity (FC 15/16) or an FC 5 value other than `0xFF00` /
     `0x0000`; then `0x02` for a range ending past address 65535. A failing request is answered
     with that exception and the `vector` is not called. An over-limit FC 15/16 request with a
     matching byte count cannot occur: it does not fit in a 253-byte PDU.
   - Every `vector` call goes through `call_vector`, which wraps a thrown exception in a private
     `Vector_Error`. `serve()` catches only `Vector_Error`: it emits `vector_error` with the
     original error and the request, and answers exception `0x04`. A `vector_error` with no
     listener is ignored. Any other exception is a bug and propagates.
3. `send_response(pdu, socket?, tid, pid)` — `tcp`: prepend a fresh MBAP header. `rtu` and
   `rtu_over_tcp`: append CRC-16 (LE). Emit `send`, then write to `socket`, or to the serial port
   when there is none.


---

## RTU / serial: unfinished work

**Status: NOT FINISHED.** Only Modbus TCP is complete. `rtu` (serial) and `rtu_over_tcp` are in
scope (see `spec.md`) but must be treated as unsupported. Parts exist: the codec in `src/util.js`
(`parse_rtu_request`, `parse_rtu_response`, `modbus_crc16`), the client RTU branch of
`make_data_packet`, `Modbus_Client.set_serial`, and `Modbus_Server.set_rtu`. They have not been
completed or exercised end to end. This section is the backlog; remove an item only when it is
fixed in code. The `spec-*` files describe the target contract, so their RTU / serial rows are
not yet guaranteed by the code, and they do not change when this list is cleared.

Each item is a defect or missing piece, not intended behavior.

### Client

- [ ] **Fixed transaction ID.** RTU has no transaction field, so every RTU request shares
  `TRANSACTION_START`; concurrent requests overwrite each other's packet slot. RTU needs strict
  request/response serialization (one outstanding request at a time) which is not implemented.

### Server

- [ ] **Serial path not verified end to end.** `test/serial.test.js` exercises the RTU server and
  client over a serial port pair, but on the development machine the com0com pair fails the
  suite's pre-check and the serial tests are skipped (see `spec-test.md`, "Serial test
  environment"). The RTU server path is covered only by unit tests with a fake serial port.
