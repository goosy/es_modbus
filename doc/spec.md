# es-modbus — Specification

Entry point for the specification document system. This file defines **what** the library
provides and **why**; implementation mechanics, implementation status, and TODOs live in
[design.md](./design.md).

Sub-documents:

- [spec-protocol.md](./spec-protocol.md) — Modbus framing, range notation, function codes, CRC.
- [spec-client.md](./spec-client.md) — `Modbus_Client` API, options, events, behavior contract.
- [spec-server.md](./spec-server.md) — `Modbus_Server` API, the `handler` interface, events.
- [design.md](./design.md) — how it is built: internal mechanics, implementation status, known
  gaps and TODOs.
- [design-test.md](./design-test.md) — how it is tested: what is tested where, commands, the
  serial test environment, the known-gap convention.

## Goal

Provide a small, dependency-light Modbus implementation for Node.js that offers both sides of a
Modbus conversation from one package:

- `Modbus_Client` — a master/client that issues read and write requests and resolves them as
  Promises.
- `Modbus_Server` — a slave/server that accepts requests and answers them through user-supplied
  data-access callbacks (the `handler`).

The client reads and writes a *range*: a start address and a length. A range is given in Modicon
notation, 5- or 6-digit (e.g. `"40001,73"`, `"400001,73"`), as a `string`, or as a structured PDU
range (function code, PDU address and length, all `number`s). The type decides, so the two never
mix. The server works in PDU addresses only.

## Scope

### In scope

- Transports: Modbus **TCP**, Modbus **RTU** over a serial port, **RTU-over-TCP** (RTU framing
  on a TCP socket), Modbus **UDP** (MBAP framing in UDP datagrams), and **RTU-over-UDP** (RTU
  framing in UDP datagrams).
- Function codes `1, 2, 3, 4, 5, 6, 15, 16` (read/write coils and registers, single and multiple).
- Modbus exception responses (function code + `0x80`, one exception byte).
- Multi-unit servers: a single server instance can host several unit IDs and route by unit ID.
- Client-side transaction tracking, per-request timeout, send pacing, and automatic reconnect
  for the TCP family (TCP and RTU-over-TCP) and the UDP family (UDP and RTU-over-UDP).
- Event emitters on both classes for wire tracing (`send` / `receive`) and lifecycle.
- TypeScript declarations of the public API, `dist/modbus.d.ts`, found through the `types`
  condition of `exports`. They declare what `spec-client.md` and `spec-server.md` define and
  nothing else: an option that does not apply to the selected transport is a type error, as it is
  a run-time error. They use the Node.js types of `@types/node` (`Buffer`, `EventEmitter`,
  `Socket`).
- An automated test suite for the codec, the server and the client (see `design-test.md`).

### Out of scope

- Function codes outside the list above (diagnostics `0x08`, file record access, FIFO,
  encapsulated transport, etc.). Parsers reject them.
- ASCII transport.
- Any persistent data model on the server — storage is entirely the caller's `handler`.

## Tools and dependencies

- **Runtime:** Node.js with ES modules (`"type": "module"`). Only Node built-ins are used at
  runtime (`node:net`, `node:dgram`, `node:dns`, `node:events`), plus `serialport-rs` for the
  serial/RTU paths.
  The published package has **no runtime dependencies**: users install `es-modbus` alone. The
  JavaScript of `serialport-rs` (its stream and binding modules) is bundled into
  `dist/modbus.js`, and its native addons ship in `native/` (N-API, so one file per platform
  serves every Node.js version). The bundle loads `serialport-rs` only on the first use of a
  serial port, never at import: loading it loads the native addon, and a platform without an
  addon (or a process that forbids native addons) must still be able to use TCP and UDP. The
  licenses of the bundled packages ship in `THIRD_PARTY_LICENSES`, those of the Rust crates in
  the native addons in `native/THIRD_PARTY_LICENSES.md`.
- **Serial platforms:** native addons ship for Windows (x64, ia32, arm64), macOS (x64, arm64),
  Linux with glibc or musl (x64, arm64, armv7), Linux with glibc on armv6, and Android (arm64,
  armv7). On any other platform the serial paths fail on first use; TCP and UDP work everywhere.
- **Node.js version:** `>=20.11` (`engines`), for `import.meta.dirname`.
- **Package manager:** pnpm (required — see `AGENTS.md`).
- **Bundler:** Rolldown, driven by `build.js` through its API (built-in node resolution and
  CommonJS interop; no plugins).
- **Tests:** the Node.js built-in test runner (`node:test`). `serialport-rs` is a
  `devDependency`: the build bundles it, and the serial tests use its `SerialPort` for a raw peer
  port.
- **Types:** TypeScript (`typescript`) and `@types/node`, both `devDependencies` pinned to
  exact versions; `tsc` type-checks `test/types.ts` against the declarations.
- **Linter:** ESLint with `@stylistic/eslint-plugin` (`eslint.config.js`), all pinned to exact
  versions in `devDependencies`. ESLint's recommended rules find code problems; `@stylistic`
  normalizes whitespace (tab indent, spacing, quotes, semicolons) without re-wrapping lines, so
  hand-laid tables keep their layout. A reformatting formatter (Prettier, Biome) is not used.

## Build and layout

| Path                  | Role                                                             |
| --------------------- | --------------------------------------------------------------- |
| `src/index.js`        | Public surface: `export { Modbus_Client, Modbus_Server, Modbus_Exception }`. |
| `src/index.d.ts`      | The declarations of the public surface, written by hand.         |
| `src/ModbusClient.js` | Client class.                                                   |
| `src/ModbusServer.js` | Server class.                                                   |
| `src/util.js`         | Pure protocol codec (frame parsing, CRC, range parsing). No I/O. |
| `src/serial.js`       | Serial options check, and serial port creation (loads `serialport-rs` on first use). |
| `build.js`            | The build: bundles `src/index.js` → `dist/modbus.js`, copies `src/index.d.ts` → `dist/modbus.d.ts` and `native/`, writes `THIRD_PARTY_LICENSES`. |
| `eslint.config.js`    | ESLint and `@stylistic` configuration.                          |
| `dist/modbus.js`      | Build output (one ES module) and the package `exports` entry.   |
| `dist/modbus.d.ts`    | Build output: the declarations, the `types` condition of `exports`. |
| `native/`             | Build output: the `serialport-rs` native addons, found by the bundle at `dist/../native`, and the licenses of their Rust crates. |
| `THIRD_PARTY_LICENSES` | Build output: the license texts of the bundled packages.       |
| `test/*.test.js`      | Automated tests (see `design-test.md`).                         |
| `test/helpers.js`     | Shared test fixtures.                                           |
| `test/types.ts`       | Type-checked use of the declarations (`test/tsconfig.json`).   |

The build outputs are git-ignored, produced by `pnpm build` / `prepare`, and published through
`package.json` `files`.

Commands:

- `pnpm install`
- `pnpm build` — runs `build.js`; run it before anything that imports `../dist/modbus.js`.
- `pnpm test` — builds, type-checks `test/types.ts` (`tsc -p test`), then runs the automated
  test suite (`node --test`).
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
