# Design

**How** the library is built: internal mechanics, implementation status, known gaps, and TODOs.
Behavior contracts are in the `spec-*` series; this file documents implementation and rough edges
so future changes are made with eyes open. This is the single design document for now; split it
into `design-<topic>.md` files when it grows.

## Transport selection

- **Client.** The constructor sets `this.protocol`: `tcp`, `rtu_over_tcp` (string address with
  `rtu: true`), or `rtu` (non-string address).
- **Decoding.** Response decoding branches on `protocol === 'tcp'` **only**, so `rtu_over_tcp` is
  decoded with the RTU parser (`parse_rtu_response`).
- **Server.** The constructor stores a `number` port or a `SerialPort` instance as given, and
  wraps a `string` port in a new `SerialPort`. `is_tcp` is a getter:
  `typeof this.port === 'number'`.

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
- **`process_packet_transaction`.** During a reconnect back-off (`_conn_failed`) it returns a
  Promise already rejected with `Error('connection lost')`; the frame is never queued. It also
  emits `error`, but only when the client has an `error` listener: emitting `error` with no
  listener throws, and a call with valid arguments must not throw synchronously.
  Otherwise it sets `status = 'pending'`, bumps `#trans_count`, creates the Promise,
  then enqueues the buffer and returns the Promise. It stores `resolve` / `reject` closures on the packet plus a
  `timeout_id`. `end_transaction` decrements the count, stamps `status`, clears the timer, and
  swaps `resolve`/`reject` for `DO_NOTHING` so a late/duplicate response is inert.
- **Matching (`on_data`).** Parse → emit `receive` → skip `func_code === 0` → look up by `tid` →
  ignore unless `status === 'pending'` → `reject` on `exception_code`, else `resolve(data)`.

## Send queue / backpressure (`send` → `sending`)

- `send_queue` is an array capped at `send_queue_size` (256); overflow splices off the **front**
  (oldest dropped).
- `sending` is guarded by `#busy` and returns at once when the queue is empty. When connected it
  shifts one buffer, calls `_send`, then after
  `delay` ms clears `#busy` and re-enters. This serializes writes and paces them.
- When not connected and no reconnect back-off is active, `sending` triggers `_connect` with
  itself as the success callback. It never runs during a back-off: a back-off starts only after
  the connection is lost, when `abort_pending()` has emptied the queue, and requests issued
  during the back-off are rejected before they are queued.
- **`abort_pending()`.** Empties `send_queue` and rejects every packet whose `status` is
  `'pending'` with `Error('connection lost')`. It runs on every transport `close` / `error`
  (TCP socket and serial port), so a failed on-demand connect also fails its requests at once.

## Connection state (TCP, `set_tcp`)

- `_connect(on_connect, on_error)` attaches one-shot `connect` / `error` listeners that clean each
  other up, and only calls `socket.connect` when not already `connecting`.
- `stream` `connect` → `is_connected = true`, `_conn_failed = false`, emit `connect`.
- `stream` `close` / `error` → `is_connected = false`, `abort_pending()`, call `reconnect()`,
  emit `disconnect` / `error`.
- `reconnect()` — if `reconnect_time > 0` and not already backing off, set `_conn_failed = true`
  and after `reconnect_time` ms clear it and call `_connect()`.

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
- `parse_tcp` requires ≥ 9 bytes, protocol ID `== 0`, length field in `3..253`, and a full
  `6 + length` bytes present; it slices `6 + length` bytes per frame and loops to extract
  multiple frames from one chunk until the buffer is exhausted or a malformed header is hit. It
  silently drops frames whose function-code byte is `< 1`.
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

- `on_data` chooses the parser by the **presence of a `socket` argument**, not by `is_tcp`.
- `handle_read_bits` serves FC 1 and FC 2; `handle_read_registers` serves FC 3 (holding) and
  FC 4 (input), branching on `function_code === 3`.
- `send_response` frames by the same `socket`-present test: MBAP for TCP, CRC for serial.

### Request flow

1. `on_data(buffer, socket?)` — parse with `parse_tcp_request` when a `socket` is present, else
   `parse_rtu_request`. Emit `receive` per frame. A frame with `func_code: 0` is dropped, unless
   the parser set `illegal_function`; then it goes on with that function code.
2. `_on_data(request, socket?)` — `serial_bus` is true for RTU framing (no `socket`; it is to
   include RTU-over-TCP once that is served). On a serial bus a broadcast (unit `0`) is never
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
3. `send_response(pdu, socket?, tid, pid)` — TCP: prepend a fresh MBAP header and `socket.write`.
   Serial: append CRC-16 (LE) and `port.write`. Emit `send`.


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

- [ ] **Serial constructor path.** `set_serial` is marked `@todo not finished` and never assigns
  `this._connect`, yet the constructor calls `this._connect()` when `reconnect_time > 0`.
  Constructing a serial client throws. Serial reconnect/`is_connected` handling is also not
  defined.
- [ ] **Fixed transaction ID.** RTU has no transaction field, so every RTU request shares
  `TRANSACTION_START`; concurrent requests overwrite each other's packet slot. RTU needs strict
  request/response serialization (one outstanding request at a time) which is not implemented.

### Server

- [ ] **No `rtu_over_tcp` mode.** The constructor has no `rtu` option (see `spec-server.md`), and
  `on_data` / `send_response` choose framing by the presence of a `socket`, so every TCP socket is
  decoded as MBAP. RTU framing over TCP cannot be served. Framing must be chosen from the
  configured transport, not from the presence of a `socket`.
- [ ] **No RTU frame delimiting.** `spec-protocol.md` ("Frame delimiting") requires serial frames
  to be delimited by a silence of at least 3.5 character times, and RTU-over-TCP frames by the
  length implied by the function code and byte count. `on_data` instead passes each received
  chunk straight to `parse_rtu_request`, so a frame split across chunks, or several frames in one
  chunk, are dropped or misparsed. (Inferred from the code; not verified on hardware.)
- [ ] **Serial path not verified end to end.** `test/serial.test.js` exercises the RTU server and
  client over a serial port pair, but on the development machine the com0com pair fails the
  suite's pre-check and the serial tests are skipped (see `spec-test.md`, "Serial test
  environment"). The RTU server path is covered only by unit tests with a fake serial port.

### Dependency

- [ ] **`serialport` is imported unconditionally.** It is declared as an optional peer dependency
  (`peerDependencies` `>=10.0.0` + `peerDependenciesMeta.optional`) and kept `external` in
  `rolldown.config.js`, but `src/ModbusServer.js` still does `import { SerialPort } from
  'serialport'` at module top level. Importing the package without `serialport` installed
  therefore throws for **every** user, including TCP-only ones. Making it truly optional needs a
  lazy `import('serialport')` on the serial path only (and `instanceof SerialPort` replaced by a
  duck-type check). Note: pnpm's `autoInstallPeers` installs it into this repository's own
  `node_modules` during development, which hides the problem locally.

---

## Known gaps / discrepancies (as of this writing)

These are **not** the intended spec — they are defects to be aware of and, ideally, fix.
RTU / serial defects are listed in the section above, not here. A fixed gap is removed from this
list; the remaining gaps keep their numbers, and a number is never reused.

Most gaps were found by auditing the code against the `spec-*` series. Gaps marked *(verified)*
were reproduced by running the code; the others are derived from reading it. They affect the TCP
path as well, not only RTU.

- **Gap 3 — No lint config.** The automated test suite exists (`spec-test.md`); a lint
  configuration does not.
- **Gap 10 — `write()` resolves with the wrong type.** The spec says `Promise<Buffer>`, but the
  promise resolves with `response.data`: a `number` for FC 5/6 and `undefined` for FC 15/16.

---

## Open questions

Decisions the spec does not make yet. Settle them in the spec first, then implement.

- **Serial parameters.** A `string` server `port` is passed to `new SerialPort(port)`, but
  `serialport` needs an options object (path, baud rate, parity, …). The spec defines no way to
  give serial parameters except passing a ready-made `SerialPort` instance.
- **Partial TCP frames.** For TCP the spec only requires splitting coalesced frames (for
  RTU-over-TCP it requires length-based delimiting). The code also drops an incomplete trailing
  frame instead of buffering it for the next read (the client's `unprocessed_buffer` field is
  unused). Decide whether buffering is required for TCP as well.
- **Return value of `start()` / `stop()`.** `listen()` and serial `open()` complete
  asynchronously; the unified `start` / `stop` events are the signal. Decide whether `start()` /
  `stop()` should also return a Promise (resolved when ready, rejected on failure).
- **Connection flapping (debounce).** The client sets `is_connected` from the socket's
  `connect` / `close` / `error` events and nothing else: no keep-alive, no heartbeat, no
  smoothing. A closed TCP socket cannot recover, and responses to requests sent on it can never
  arrive, so delaying the "connection lost" rejection would only delay the failure. What
  flapping does cost is a reconnect storm if `reconnect_time` is small, and event noise
  (`connect` / `disconnect`) for the caller. The opposite problem is a half-open connection
  (cable pulled, peer gone without a FIN), where no event fires and the client only ever sees
  timeouts. Decide whether to add (a) a minimum or growing reconnect delay, and (b) dead-link
  detection, such as closing the socket after N consecutive timeouts or enabling TCP keep-alive.
- **Return value of `write()`.** Decide whether it resolves with a `Buffer` (spec today) or with
  the echoed value (code today); see gap 10.
- **`disconnect()` and auto-reconnect.** `disconnect()` ends the socket, the `close` event then
  triggers the reconnect timer, so with `reconnect_time > 0` the client reconnects by itself after
  an explicit `disconnect()` (this follows the spec's reconnect rule literally). Decide whether an
  explicit `disconnect()` should suppress reconnecting.
