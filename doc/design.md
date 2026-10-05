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

## Client address argument (`read` / `write`)

The forms accepted for `address` (a Modicon string, or a structured array / object) and the rules
for their fields are defined in `spec-protocol.md`; the client-side validation is in
`spec-client.md`. How they are implemented:

- **Type split first.** `read()` / `write()` look at the type of `address` before anything else:
  a `string` goes to the Modicon parser, an array or object to the structured-address
  validator.
- **Numbering base.** The constructor option `modicon_zero_based` (default `false`, i.e.
  1-based) only affects the Modicon parser. A structured `pdu_addr` is used unchanged.
- **Function code lookup.** A Modicon string finds its table through `MB_prefix_dict`, keyed by
  the leading digit. A structured `func_code` needs its own function-code lookup (see gap 20).
- **Explicit function code.** With a structured address `write()` does not infer the function
  code from the shape of `value`; it validates the value against `func_code`.

## Frame construction pipeline (`Modbus_Client.make_data_packet`)

A single routine builds every outgoing frame regardless of transport:

1. Allocate a TCP-shaped buffer: 12 bytes for reads / single writes, `13 + data_bytes` for
   FC 15/16.
2. Write the PDU at offset 6 (`unit_id`, `func_code`, `start_address`, then per-FC fields).
   - FC 1–4: quantity at offset 10.
   - FC 5: `0xFF00` / `0x0000` at offset 10.
   - FC 6: 16-bit value at offset 10.
   - FC 15/16: quantity at 10, byte count at 12, data from 13.
3. Apply the Modicon→PDU conversion here: the PDU address is `point - 1` by default, or `point`
   when the client was constructed with `options.modicon_zero_based = true`. A `number` PDU address is
   to be used unchanged (not converted). The code still has a `0 → 0xFFFF` case that is to be
   removed (see gaps 15 and 17).
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
- **`process_packet_transaction`.** Sets `status = 'pending'`, bumps `#trans_count`, enqueues the
  buffer, and returns a Promise. It stores `resolve` / `reject` closures on the packet plus a
  `timeout_id`. `end_transaction` decrements the count, stamps `status`, clears the timer, and
  swaps `resolve`/`reject` for `DO_NOTHING` so a late/duplicate response is inert.
- **Matching (`on_data`).** Parse → emit `receive` → skip `func_code === 0` → look up by `tid` →
  ignore unless `status === 'pending'` → `reject` on `exception_code`, else `resolve(data)`.

## Send queue / backpressure (`send` → `sending`)

- `send_queue` is an array capped at `send_queue_size` (256); overflow splices off the **front**
  (oldest dropped).
- `sending` is guarded by `#busy`. When connected it shifts one buffer, calls `_send`, then after
  `delay` ms clears `#busy` and re-enters. This serializes writes and paces them.
- When not connected and no reconnect back-off is active, `sending` triggers `_connect` with
  itself as the success callback. If a back-off is active it emits `error`.

## Connection state (TCP, `set_tcp`)

- `_connect(on_connect, on_error)` attaches one-shot `connect` / `error` listeners that clean each
  other up, and only calls `socket.connect` when not already `connecting`.
- `stream` `connect` → `is_connected = true`, `_conn_failed = false`, emit `connect`.
- `stream` `close` / `error` → `is_connected = false`, call `reconnect()`, emit `disconnect` /
  `error`.
- `reconnect()` — if `reconnect_time > 0` and not already backing off, set `_conn_failed = true`
  and after `reconnect_time` ms clear it and call `_connect()`.

## Parser notes (`src/util.js`)

- `parse_address` returns `{ type, fm_read, fs_write, fm_write, address, length }` (fields absent
  for tables that lack that operation) or `null` when the string does not match.
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
- Response parsers treat `func_code > 127` with a 3-byte PDU as an exception and read the
  exception byte; anything else unrecognized becomes `func_code: 0`.

## Server dispatch notes

- `on_data` chooses the parser by the **presence of a `socket` argument**, not by `is_tcp`.
- `handle_read_bits` serves FC 1 and FC 2; `handle_read_registers` serves FC 3 (holding) and
  FC 4 (input), branching on `function_code === 3`.
- `send_response` frames by the same `socket`-present test: MBAP for TCP, CRC for serial.

### Request flow

1. `on_data(buffer, socket?)` — parse with `parse_tcp_request` when a `socket` is present, else
   `parse_rtu_request`. Emit `receive` per frame.
2. `_on_data(request, socket?)` — reject the unit ID if not accepted (`0x11` in the code; the
   spec says `0x0B`, see gap 24); otherwise switch on
   `func_code` to the matching `handle_*` method, which calls into `vector` and builds the
   response PDU. Unknown function codes → exception `0x01`.
3. `send_response(pdu, socket?, tid, pid)` — TCP: prepend a fresh MBAP header and `socket.write`.
   Serial: append CRC-16 (LE) and `port.write`. Emit `send`.

## Manual smoke script (`test/test.js`)

`pnpm test` runs `test/test.js`, which starts a TCP server on port 502 backed by three
`Buffer`-backed units (18, 19, 12) and a client that polls `40001,73` from each once per second,
logging hex frames. It is a transport sanity check, not an automated test, and its `vector`
predates the current `snake_case` accessor names (see gap 2 below) — do not treat it as an
interface reference. The interface contract is in `spec-server.md`.

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

- [ ] **Unimported symbol.** `make_data_packet`'s non-TCP branch calls `modbus_crc16`, which
  `src/ModbusClient.js` does not import (`src/util.js` exports it). Any `rtu` / `rtu_over_tcp`
  send currently throws `ReferenceError`.
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
- [ ] **Serial lifecycle events use different names.** The spec defines `start` / `stop` for every
  transport (`stop` also when the transport closes by itself). The code emits `start` / `stop`
  for TCP but `started` / `closed` for serial (`set_rtu`); rename the serial events.
- [ ] **Serial path untested.** No test or smoke script exercises it.

### Dependency

- [ ] **`serialport` is not declared and is imported unconditionally.** `src/ModbusServer.js`
  does `import { SerialPort } from 'serialport'` at module top level, but the package is absent
  from `package.json` and `node_modules`. Importing `Modbus_Server` (hence `src/index.js`) throws
  for **every** user, including TCP-only ones.
  - Intended: optional peer dependency supplied by the user (`peerDependencies` +
    `peerDependenciesMeta.optional`).
  - Open question (decide before implementing): a peer declaration alone does not stop the
    top-level import from failing when it is not installed. Making it truly optional likely needs a
    lazy `import('serialport')` only on the serial path (and `instanceof SerialPort` replaced by a
    duck-type check), and `rollup.config.js` must keep it `external`. Today it has
    `external: []`, so once `serialport` is installed Rollup would try to bundle it (a package
    with native addons) into `modbus.js`; while it is not installed it is only reported as an
    unresolved import.

---

## Known gaps / discrepancies (as of this writing)

These are **not** the intended spec — they are defects to be aware of and, ideally, fix.
RTU / serial defects are listed in the section above, not here.

1. **Server single-write handlers get the wrong argument.** `_on_data` calls
   `handle_write_single_coil(start_address, quantity, unit_id)` and
   `handle_write_single_register(start_address, quantity, unit_id)`, but the parsed request
   carries the value in `data`, not `quantity` (which is `undefined` for FC 5/6). As written,
   FC 5 always compares `undefined === 0xFF00` (never writes ON) and both handlers pass
   `undefined` to `buffer.writeUInt16BE`, which throws.
2. **`test/test.js` is stale.** Its `vector` uses camelCase (`getCoil`, `setRegister`, …) which
   the current server never calls, and its `stop` handler references an undefined `logger`.
3. **No automated tests / no lint config.** `pnpm test` runs a long-lived smoke script that binds
   port 502.

The items below are discrepancies between the `spec-*` series and the code, found by auditing the
code against the spec. Items marked *(verified)* were reproduced by running the code; the others
are derived from reading it. They affect the TCP path as well, not only RTU.

4. **Client single writes fail without a `,1` suffix *(verified)*.** `write()` defaults
   `length` to `value.length >> 1`, which is `0` for a `number` or `boolean`. So
   `write('40001', 5)` and `write('00001', true)` throw `Multiple writes require a Buffer value`
   instead of using FC 6 / FC 5 (spec: `number` → FC 6, `boolean` → FC 5). It only works when the
   address carries `,1` or the value is a 2-byte `Buffer`.
5. **FC 6 rejects values above 32767 *(verified)*.** `make_data_packet` uses `writeInt16BE`, so
   `write('40001,1', 40000)` throws `RangeError`. The spec says a 16-bit value.
6. **FC 15 frame is malformed *(verified)*.** `make_data_packet` sets the data byte count to the
   coil count (`dataBytes = length`) instead of `ceil(length / 8)`, so the byte count field and
   the frame length are wrong (16 coils → byte count 16, 16 data bytes, 2 of them real).
7. **TCP exception responses are never recognized *(verified)*.** `parse_mt_response` reads the
   function code with `readInt8`, so `0x83` becomes `-125` and the `func_code > 127` exception
   branch never matches. The frame is dropped as `func_code: 0` and the request times out instead
   of rejecting with `response error: <code>` (spec: client rejects with the exception code).
   The RTU parser uses `readUInt8` and is not affected.
8. **First send before the connection is up crashes *(verified)*.** `sending()` passes
   `this.sending` unbound as the connect callback, so when the connection completes it throws
   `TypeError` (`#busy` of `undefined`) as an uncaught exception, and the pending request times
   out. This is the default path: a client constructed with `reconnect_time > 0` that calls
   `read()` right away.
9. **Invalid address tables are accepted *(verified)*.** `parse_address('20001')` returns an object
   with no `fm_read` instead of `null`; the spec allows only leading digits `0, 1, 3, 4`.
10. **`write()` resolves with the wrong type.** The spec says `Promise<Buffer>`, but the promise
    resolves with `response.data`: a `number` for FC 5/6 and `undefined` for FC 15/16.
11. **Server does not drop malformed frames.** `on_data` hands every parsed frame, including
    `func_code: 0` ones (bad length, bad CRC, unsupported function), to `_on_data`, which answers
    with an exception whose function byte is `0x80` (`0 + 0x80`). The spec says malformed frames
    are dropped, and an unsupported function must be answered with `function_code | 0x80`, but the
    original function code is lost in the parser. Frames too short to carry a unit ID are answered
    with an undefined unit ID.
12. **TCP request parser throws on short frames *(verified)*.** `parse_mt_request` reads the start
    address unconditionally, so a request whose MBAP length field is 3 throws `RangeError` inside
    the socket `data` handler (uncaught). The spec says malformed frames are dropped.
13. **Server does not validate quantity / byte count.** A read with a large quantity throws
    `RangeError` in `writeUInt8(quantity * 2)` (registers above 127, coils above 2040), and a
    FC 15/16 request whose `byte_count` is smaller than `quantity` requires reads past the data.
    Both throw inside the socket `data` handler. The spec defines no limits or exception codes
    for this (see Open questions).
14. **Server `options` has no default.** `new Modbus_Server(vector)` throws `TypeError` on
    `options.unit_id`, although the spec presents every option as optional with a default.
15. **Dead branch in `make_data_packet`.** `address === 0 ? 0xffff` is unreachable because
    `parse_address` rejects address `0`. Remove it once 0-based numbering is handled properly
    (gap 17).
16. **6-digit Modicon addresses are not supported.** `parse_address` only matches
    `^(\d{5})(,(\d{1,4}))?$`, so `"400001"` is rejected. The spec requires both the 5-digit form
    (point `1..9999` when 1-based, `0..9999` when 0-based) and the 6-digit form (`1..65536` /
    `0..65535`), told apart by digit count. The current `1..65535` range check on the 5-digit
    form is meaningless (the field maxes out at 9999).
17. **0-based Modicon numbering is only half implemented.** The mechanism is the client
    constructor option `options.modicon_zero_based` (default `false`; `true` selects 0-based
    Modicon numbering and makes the PDU address equal to the point number). The code still calls
    it `zero_based`; rename it. The mechanism is the right place, but:
    - `parse_address` rejects point `0` and ignores the base, so in 0-based mode the first point
      (`"40000"`, `"400000"`) cannot be addressed and the ranges in gap 16 are not honored.
    - The option's meaning must be narrowed to Modicon strings: it must not affect `number` PDU
      addresses, which are always 0-based and never converted.
18. **`parse_address(address_str)` is poorly implemented.** Beyond gaps 9 and 16:
    - It does not look at the type of its argument: it calls `address_str.match(...)`, so a
      non-string (such as the array and object forms) throws `TypeError`. The type-based split
      described in "Client address argument" has to happen before any parsing.
    - It mixes three jobs: parsing the string, validating the point range, and mapping the table
      digit to function codes. The 5-digit range check is meaningless (gap 16).
    - `,N` accepts `0` (`"40001,0"` yields length `0`), and the length has no upper bound tied to
      the protocol limits.
    - The result is an object spread of an optional table entry, so unsupported tables yield an
      object without `type` / `fm_read` instead of failing (gap 9).
    - It uses the deprecated `String.prototype.substr`.
19. **`read()` / `write()` are incomplete.** They only accept a Modicon string (via
    `parse_address`, gap 18). The array form `[func_code, pdu_addr, length]` and the object form
    `{ func_code, pdu_addr, length }` (see "Client address argument") are not implemented, nor is
    the validation of their fields (`func_code` a `number` from `1, 2, 3, 4, 5, 6, 15, 16`,
    `pdu_addr` an integer `0..65535`, `length` an integer `>= 1` and exactly `1` for FC 5 and 6).
20. **`MB_prefix_dict` cannot resolve a function code.** The structured forms need a lookup from
    `func_code` to the table type and the read/write direction. `MB_prefix_dict` is keyed by the
    Modicon prefix digit (`'0'` coils, `'1'` discrete inputs, `'4'` holding, `'3'` input), not by
    function code, so indexing it with `func_code - 1` gives wrong or missing results: FC 3 →
    `'2'` (missing, holding is `'4'`), FC 5 → `'4'` (holding, but FC 5 writes a coil), FC 6 →
    `'5'` (missing), FC 15 → `'14'` (missing). A function-code lookup (a table or an array
    indexed by function code) has to be added next to it.
21. **Connection loss does not reject pending requests, and stale frames stay queued
    *(verified)*.** The spec requires every pending request to be rejected immediately and the
    queued frames discarded when the connection is lost. The code does neither: pending requests
    just wait for their timeout, and a request that timed out while the client was disconnected or
    backing off keeps its frame in `send_queue`. That frame is sent after the connection returns,
    on the next `send()`, so a write the caller was told had failed can still be executed late.
    The rejection value is to be `new Error('connection lost')`, and a request issued during a
    reconnect back-off is to be rejected at once; today `sending()` only emits `error` and leaves
    the frame queued.
22. **`write()` with a coil `Buffer` takes the wrong path *(verified)*.** With a `,1` suffix,
    `write('00001,1', Buffer.from([1]))` takes the single-write branch and throws
    `Invalid value for coil write`; the spec says a coil `Buffer` of `ceil(length / 8)` bytes uses
    FC 15. Without a suffix, `length` is derived as `value.length >> 1`, which is wrong for coils
    (it counts register words, not bits).
23. **`stop()` before `start()` throws on TCP.** `this.server` is not created until `start()`, so
    `stop()` falls through to `this.port.close()` on a `number` and throws `TypeError`.
24. **Wrong exception code for an unaccepted unit ID.** The server answers `0x11`, which is not a
    Modbus exception code; "Gateway Target Device Failed To Respond" is `0x0B`, which the spec
    now uses. Fix the code and its comment.
25. **The client does not validate its arguments.** The spec requires `read()` / `write()` to
    throw synchronously for these, but the code accepts them:
    - a length below `1` or above the quantity limit of the function code (`"40001,0"` sends
      quantity `0`; `"40001,9999"` sends an oversized request);
    - a `unit_id` that is not an integer in `0..255` (a value above 255 fails deep inside
      `make_data_packet` with a `RangeError` instead of a clear error);
    - an FC 6 value that is not an integer in `0..65535` (negative values are accepted, and a
      fractional one is silently truncated; see also gap 5).
26. **The server does not catch a throwing `vector`.** The spec requires the error to be recorded
    and exception `0x04` to be returned. The `vector` calls are not wrapped, so an exception
    escapes the socket `data` handler as an uncaught exception, and the peer gets no response.
    (Derived from the code; the server cannot be imported to run it while `serialport` is
    missing.)
27. **`unit_id` `0` still means "accept every unit ID", and broadcast is not handled.** The spec
    separates the two: only `null`, `undefined`, `'all'`, `'*'` accept every ID (the default),
    `0` is the broadcast address, and a broadcast executes writes, ignores reads and is never
    answered. The code keeps `0` as an alias for "all" (and defaults `options.unit_id` to `0`),
    and answers requests to unit `0` like any other. This is a breaking change to
    `set_unit_ids`.

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
- **Server-side limits and exception codes.** The client side is settled: it throws on an
  over-limit length. For the server, decide whether an out-of-range quantity is answered with
  `0x03` (Illegal Data Value), an out-of-range address with `0x02`, and so on (see gap 13).
- **How the server records a `vector` error.** The spec says the error is recorded. Decide the
  mechanism: a dedicated event, the existing `error` event (which throws if nobody listens), or
  an injectable logger.
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
- **Unit ID mismatch on a serial bus.** The spec says a request to a non-accepted unit ID gets an
  exception `0x0B` on every transport. On a shared RTU bus the other slaves would answer the same
  request, so the usual behavior is to stay silent. Decide whether the RTU server answers `0x0B`
  (spec today) or stays silent.
- **`disconnect()` and auto-reconnect.** `disconnect()` ends the socket, the `close` event then
  triggers the reconnect timer, so with `reconnect_time > 0` the client reconnects by itself after
  an explicit `disconnect()` (this follows the spec's reconnect rule literally). Decide whether an
  explicit `disconnect()` should suppress reconnecting.
