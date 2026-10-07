# Test suite

Defines the automated test suite: what it covers, how it is run, and the environment it needs.

## Goals

- Cover the three parts of the library: the codec in `src/util.js`, `Modbus_Server` and
  `Modbus_Client`, plus the build output `dist/modbus.js` (with `prebuilds/`) that the package
  publishes.
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

Running `node --test` directly also works; the bundle test is then skipped when `dist/modbus.js` is
missing or older than any file in `src/`.

## Layout

| File                  | Covers                                                                    |
| --------------------- | ------------------------------------------------------------------------- |
| `test/helpers.js`     | Shared fixtures: in-memory `vector`, RTU / MBAP frame builders, fake TCP slave, raw TCP peer, server and client set-up. Not a test file. |
| `test/util.test.js`   | Constants, `modbus_crc16`, `parse_modicon_range`, the RTU and TCP request / response parsers, the frame length functions and `split_frames`. |
| `test/client.test.js` | `Modbus_Client` against a fake TCP slave: construction, argument validation, frames on the wire, transaction matching, timeouts, pacing, queue overflow, events, connection and reconnect, the exponential reconnect back-off and its reset, dead-link detection, keep-alive, connection phase transitions (TCP and serial), RTU-over-TCP framing. |
| `test/server.test.js` | `Modbus_Server`: construction, unit IDs, every function code with TCP and RTU framing (through a fake socket / fake serial port), frame delimiting, exceptions, events, the TCP lifecycle on a real socket, and the `start()` / `stop()` promises: ordering, joining, restart, and who handles a failure (a child process checks that an unhandled one terminates). |
| `test/tcp.test.js`    | End to end: `Modbus_Client` against `Modbus_Server` over Modbus TCP on loopback. |
| `test/serial.test.js` | End to end over a serial port pair: `Modbus_Server` in RTU mode against a raw serial peer, and `Modbus_Client` in RTU mode against `Modbus_Server`. |
| `test/serial-bridge.test.js` | The serial paths over a simulated serial line (`test/serial-bridge.js`), always run: `Modbus_Client` on the serial end against an RTU-over-TCP `Modbus_Server`, and `Modbus_Server` on the serial end against a raw socket or an RTU-over-TCP client; bytes paced at the baud rate and chunked, corrupted, dropped, delayed or broken by a pause, noise, and an unplugged device. |
| `test/bundle.test.js` | The build output `dist/modbus.js`: it exports exactly `Modbus_Client` and `Modbus_Server`, `package.json` `exports` points at it, `serialport` is bundled with no outside import and no `__dirname`, `prebuilds/` and `THIRD_PARTY_LICENSES` are in place, importing it does not load the native binding while the first serial `start()` does, and the bundled classes complete a TCP round trip. |

## TCP tests

- Servers listen on `127.0.0.1` with port `0`, so every test gets a free ephemeral port and test
  files can run in parallel.
- Client-only tests use a raw `node:net` server as a fake slave, so the exact bytes on the wire
  can be checked and malformed or out-of-order replies can be produced.
- Server-only tests feed frames to `on_data` through a fake socket or a fake serial port where
  no network is needed, and use a raw `node:net` socket where the real transport matters.
- Serial lifecycle tests replace the serial port factory of `src/serial.js` with one that makes
  a fake serial port (`set_serial_port_factory`, not part of the public API), so no serial
  hardware or native binding is needed.
- End-to-end tests connect the two classes to each other.

## Serial tests

- The serial tests need a pair of serial ports linked like a null-modem cable, such as a
  com0com pair. The server side opens the first port, the peer (a raw `SerialPort`, or
  `Modbus_Client`) the second.
- The pair is set with the environment variable `MODBUS_SERIAL_PORTS="<server>,<peer>"`; the
  default is `COM11,COM12`. `MODBUS_SERIAL_PORTS=none` skips the serial tests.
- Before the serial tests run, a pre-check opens both ports. If either port cannot be opened, the
  serial suites are skipped with the reason, and the rest of the suite still runs.

### Serial test environment

The serial suites run on Windows 11 over a com0com 3.0.0.0 pair with default parameters.

On Windows with Node.js v26.4.0 and later, the serial tests fail. Since v26.4.0, Node.js no
longer runs the microtask queue and `process.nextTick` handlers after a native module calls into
JavaScript from async work; the module has to do it itself with `CallbackScope` or
`MakeCallback` ([nodejs/node#66158](https://github.com/nodejs/node/issues/66158), closed as not
planned; [nodejs/node-addon-api#1756](https://github.com/nodejs/node-addon-api/issues/1756)).
On Windows, `@serialport/bindings-cpp` 13 completes reads and writes with a plain call, so the
promise that delivers the result settles only when another macrotask runs, such as a timer,
closing the port, or another write
([serialport/node-serialport#3148](https://github.com/serialport/node-serialport/issues/3148)).
The serial driver is not the cause: through native Win32 calls, the same com0com pair completes
a pending read as soon as data arrives.

## Known gaps

Spec behavior not yet implemented is marked `{ todo }`; the mark is removed once it is fixed.
