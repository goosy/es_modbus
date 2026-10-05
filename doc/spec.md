# es-modbus — Specification

Entry point for the specification document system. This file defines **what** the library
provides and **why**; implementation mechanics, implementation status, and TODOs live in
[design.md](./design.md).

Sub-documents:

- [spec-protocol.md](./spec-protocol.md) — Modbus framing, range notation, function codes, CRC.
- [spec-client.md](./spec-client.md) — `Modbus_Client` API, options, events, behavior contract.
- [spec-server.md](./spec-server.md) — `Modbus_Server` API, the `vector` handler interface, events.
- [spec-test.md](./spec-test.md) — the automated test suite: coverage, commands, serial test
  environment, known-gap convention.
- [design.md](./design.md) — how it is built: internal mechanics, implementation status, known
  gaps and TODOs.

## Goal

Provide a small, dependency-light Modbus implementation for Node.js that offers both sides of a
Modbus conversation from one package:

- `Modbus_Client` — a master/client that issues read and write requests and resolves them as
  Promises.
- `Modbus_Server` — a slave/server that accepts requests and answers them through user-supplied
  data-access callbacks (the `vector`).

The client reads and writes a *range*: a start address and a length. A range is given in Modicon
notation, 5- or 6-digit (e.g. `"40001,73"`, `"400001,73"`), as a `string`, or as a structured PDU
range (function code, PDU address and length, all `number`s). The type decides, so the two never
mix. The server works in PDU addresses only.

## Scope

### In scope

- Transports: Modbus **TCP**, Modbus **RTU** over a serial port, and **RTU-over-TCP** (RTU
  framing on a TCP socket).
- Function codes `1, 2, 3, 4, 5, 6, 15, 16` (read/write coils and registers, single and multiple).
- Modbus exception responses (function code + `0x80`, one exception byte).
- Multi-unit servers: a single server instance can host several unit IDs and route by unit ID.
- Client-side transaction tracking, per-request timeout, send pacing, and automatic reconnect
  for TCP and RTU-over-TCP.
- Event emitters on both classes for wire tracing (`send` / `receive`) and lifecycle.
- An automated test suite for the codec, the server and the client (see `spec-test.md`).

### Out of scope

- Function codes outside the list above (diagnostics `0x08`, file record access, FIFO,
  encapsulated transport, etc.). Parsers reject them.
- ASCII transport.
- Any persistent data model on the server — storage is entirely the caller's `vector`.
- TypeScript types (the code documents shapes with JSDoc typedefs).

## Tools and dependencies

- **Runtime:** Node.js with ES modules (`"type": "module"`). Only Node built-ins are used at
  runtime (`node:net`, `node:events`), plus `serialport` for the serial/RTU paths.
  `serialport` is supplied by the user: it is an optional peer dependency
  (`peerDependencies` + `peerDependenciesMeta.optional`), and TCP-only users must be able to use
  the library without installing it.
- **Package manager:** pnpm (required — see `AGENTS.md`).
- **Bundler:** Rolldown (built-in node resolution, CommonJS interop and JSON import; no plugins).
- **Tests:** the Node.js built-in test runner (`node:test`). During development `serialport` is
  installed by pnpm's `auto-install-peers` (on by default), so the serial tests and the server
  module can load; it is not listed in `devDependencies`.
- **Linter:** ESLint with `@stylistic/eslint-plugin` (`eslint.config.js`), all pinned to exact
  versions in `devDependencies`. ESLint's recommended rules find code problems; `@stylistic`
  normalizes whitespace (tab indent, spacing, quotes, semicolons) without re-wrapping lines, so
  hand-laid tables keep their layout. A reformatting formatter (Prettier, Biome) is not used.

## Build and layout

| Path                  | Role                                                             |
| --------------------- | --------------------------------------------------------------- |
| `src/index.js`        | Public surface: `export { Modbus_Client, Modbus_Server }`.      |
| `src/ModbusClient.js` | Client class.                                                   |
| `src/ModbusServer.js` | Server class.                                                   |
| `src/util.js`         | Pure protocol codec (frame parsing, CRC, range parsing). No I/O. |
| `rolldown.config.js`  | Bundles `src/index.js` → `modbus.js` (ESM).                     |
| `eslint.config.js`    | ESLint and `@stylistic` configuration.                          |
| `modbus.js`           | Build output and the package `exports` entry. Git-ignored; produced by `pnpm build` / `prepare`. |
| `test/*.test.js`      | Automated tests (see `spec-test.md`).                           |
| `test/helpers.js`     | Shared test fixtures.                                           |

Commands:

- `pnpm install`
- `pnpm build` — run before anything that imports `../modbus.js`.
- `pnpm test` — builds, then runs the automated test suite (`node --test`).
- `pnpm test:coverage` — the test suite with a coverage report for `src/`.
- `pnpm lint` — runs ESLint (`eslint .`); `pnpm lint --fix` applies the fixable rules. It is
  separate from `pnpm test`.

## Conventions

- Source is ESM only; identifiers are `snake_case` except where an external interface dictates
  otherwise (see `AGENTS.md`).
- Supported function codes and PDU lengths are validated when parsing; malformed frames are
  dropped rather than raising an exception.
- Ranges cross the public API in one of two forms chosen by JavaScript type, as defined in
  `spec-protocol.md`: a `string` is Modicon notation (5- or 6-digit), an array or object is a
  structured PDU range.

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
- **`disconnect()` and auto-reconnect.** `disconnect()` ends the socket, the `close` event then
  triggers the reconnect timer, so with `reconnect_time > 0` the client reconnects by itself after
  an explicit `disconnect()` (this follows the spec's reconnect rule literally). Decide whether an
  explicit `disconnect()` should suppress reconnecting.
