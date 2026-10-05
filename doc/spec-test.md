# Test suite

Defines the automated test suite: what it covers, how it is run, and the environment it needs.

## Goals

- Cover the three parts of the library: the codec in `src/util.js`, `Modbus_Server` and
  `Modbus_Client`, plus the build output `modbus.js` that the package publishes.
- Test against the `spec-*` series, not against the current code. Where the code does not yet
  meet the spec (a gap listed in `design.md`), the test still states the spec behavior and is
  marked as a known gap (see "Known gaps"), so the suite shows what is missing without failing.
- Need no extra test dependency: the suite uses the Node.js built-in runner (`node:test`,
  `node:assert/strict`).
- Import from `src/` directly, except the bundle test, so the source tests need no build.

## Commands

| Command              | What it does                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `pnpm test`          | Runs `pnpm build`, then every `test/**/*.test.js` with `node --test`. |
| `pnpm test:coverage` | Same, with the built-in coverage report limited to `src/**`.         |

Running `node --test` directly also works; the bundle test is then skipped when `modbus.js` is
missing or older than any file in `src/`.

## Layout

| File                  | Covers                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `test/helpers.js`     | Shared fixtures: in-memory `vector`, RTU / MBAP frame builders, fake TCP slave, raw TCP peer, server and client set-up. Not a test file. |
| `test/util.test.js`   | Constants, `modbus_crc16`, `parse_modicon_range`, the RTU and TCP request / response parsers. |
| `test/client.test.js` | `Modbus_Client` against a fake TCP slave: construction, argument validation, frames on the wire, transaction matching, timeouts, pacing, queue overflow, events, connection and reconnect, RTU-over-TCP framing. |
| `test/server.test.js` | `Modbus_Server`: construction, unit IDs, every function code with TCP and RTU framing (through a fake socket / fake serial port), exceptions, events, and the TCP lifecycle on a real socket. |
| `test/tcp.test.js`    | End to end: `Modbus_Client` against `Modbus_Server` over Modbus TCP on loopback. |
| `test/serial.test.js` | End to end over a serial port pair: `Modbus_Server` in RTU mode against a raw serial peer, and `Modbus_Client` in RTU mode against `Modbus_Server`. |
| `test/bundle.test.js` | The build output `modbus.js`: it exports exactly `Modbus_Client` and `Modbus_Server`, `package.json` `exports` points at it, `serialport` stays external, and the bundled classes complete a TCP round trip. |

## TCP tests

- Servers listen on `127.0.0.1` with port `0`, so every test gets a free ephemeral port and test
  files can run in parallel.
- Client-only tests use a raw `node:net` server as a fake slave, so the exact bytes on the wire
  can be checked and malformed or out-of-order replies can be produced.
- Server-only tests feed frames to `on_data` through a fake socket or a fake serial port where
  no network is needed, and use a raw `node:net` socket where the real transport matters.
- End-to-end tests connect the two classes to each other.

## Serial tests

- The serial tests need a pair of serial ports linked like a null-modem cable, such as a
  com0com pair. The server side opens the first port, the peer (a raw `SerialPort`, or
  `Modbus_Client`) the second.
- The pair is set with the environment variable `MODBUS_SERIAL_PORTS="<server>,<peer>"`; the
  default is `COM11,COM12`. `MODBUS_SERIAL_PORTS=none` skips the serial tests.
- Before the serial tests run, a pre-check opens both ports and checks that a byte written on
  one port reaches a read already pending on the other. If either step fails, the serial suites
  are skipped with the reason, and the rest of the suite still runs.

### Serial test environment

On the development machine (Windows 11, com0com 3.0.0.0 with default parameters,
`serialport` 10 to 13), the pre-check fails: a read that the Node.js `serialport` binding has
already started on a com0com port does not complete when data arrives; the data is delivered
only when the port is closed or the same port writes. A .NET `SerialPort` on the same pair
works in both directions, so the pair itself is linked correctly. Until this is solved (for
example by com0com parameters or another virtual serial driver), the serial suites are skipped
there.

## Known gaps

Spec behavior not yet implemented is marked `{ todo }`; the mark is removed once it is fixed.
