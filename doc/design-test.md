# Design: test suite

**How** the library is tested: what is tested where, how the suite runs, and the environment it
needs. A topic split out of [design.md](./design.md).

## Principles

- Tests through the public API (each class against a fake peer, the two classes end to end, the
  build output) check the behavior of the `spec-*` series, not the current code. Tests of the
  functions of `src/util.js` check the mechanics described in `design.md`.
- A rule implemented by a pure function of `src/util.js` is tested there, case by case. The class
  tests check only that the class applies it: one or two cases through the class, not the whole
  table again.
- Where the code does not yet meet the spec, the test still states the spec behavior and is
  marked `{ todo }`, so the suite shows what is missing without failing; the mark is removed once
  it is fixed.
- No extra test dependency: the suite uses the Node.js built-in runner (`node:test`,
  `node:assert/strict`).
- Tests import from `src/` directly, except the bundle test, so the source tests need no build.

## Layers

`test/util.test.js` covers `src/util.js`; `test/client.test.js` and `test/server.test.js` cover
each class alone; `test/tcp.test.js`, `test/serial.test.js` and `test/serial-bridge.test.js` run
the classes end to end over loopback TCP, a serial port pair and a simulated serial line;
`test/bundle.test.js` covers the build output `dist/modbus.js` with `prebuilds/`. Fixtures live in
`test/helpers.js` and `test/serial-bridge.js`.

## Commands

| Command              | What it does                                                          |
| -------------------- | --------------------------------------------------------------------- |
| `pnpm test`          | Runs `pnpm build`, then every `test/**/*.test.js` with `node --test`. |
| `pnpm test:coverage` | Same, with the built-in coverage report limited to `src/**`.         |

Running `node --test` directly also works; the bundle test is then skipped when `dist/modbus.js` is
missing or older than any file in `src/`.

## Fakes and isolation

- Servers listen on `127.0.0.1` with port `0`, so every test gets a free ephemeral port and test
  files can run in parallel.
- Client tests use a raw `node:net` server as a fake slave, so the exact bytes on the wire can be
  checked and malformed or out-of-order replies can be produced.
- Server tests feed frames to `on_data` through a fake socket or a fake serial port where no
  network is needed, and use a raw `node:net` socket where the real transport matters.
- Serial lifecycle tests replace the serial port factory of `src/serial.js` with one that makes a
  fake serial port (`set_serial_port_factory`, not part of the public API), so no serial hardware
  or native binding is needed.

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
