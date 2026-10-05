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

## Build and layout

| Path                  | Role                                                             |
| --------------------- | --------------------------------------------------------------- |
| `src/index.js`        | Public surface: `export { Modbus_Client, Modbus_Server }`.      |
| `src/ModbusClient.js` | Client class.                                                   |
| `src/ModbusServer.js` | Server class.                                                   |
| `src/util.js`         | Pure protocol codec (frame parsing, CRC, range parsing). No I/O. |
| `rolldown.config.js`  | Bundles `src/index.js` → `modbus.js` (ESM).                     |
| `modbus.js`           | Build output and the package `exports` entry. Git-ignored; produced by `pnpm build` / `prepare`. |
| `test/*.test.js`      | Automated tests (see `spec-test.md`).                           |
| `test/helpers.js`     | Shared test fixtures.                                           |

Commands:

- `pnpm install`
- `pnpm build` — run before anything that imports `../modbus.js`.
- `pnpm test` — builds, then runs the automated test suite (`node --test`).
- `pnpm test:coverage` — the test suite with a coverage report for `src/`.

## Conventions

- Source is ESM only; identifiers are `snake_case` except where an external interface dictates
  otherwise (see `AGENTS.md`).
- Supported function codes and PDU lengths are validated when parsing; malformed frames are
  dropped rather than raising an exception.
- Ranges cross the public API in one of two forms chosen by JavaScript type, as defined in
  `spec-protocol.md`: a `string` is Modicon notation (5- or 6-digit), an array or object is a
  structured PDU range.
