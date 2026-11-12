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
`test/bundle.test.js` covers the build output `dist/modbus.js` with `native/`. Fixtures live in
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
  files can run in parallel. The public options do not accept port `0`, so a test server is built
  with a fixed target and its `port` property is then set to `0` (`ephemeral_server` in
  `test/helpers.js`).
- Client tests use a raw `node:net` server as a fake slave, so the exact bytes on the wire can be
  checked and malformed or out-of-order replies can be produced.
- Server tests feed frames to `on_data` through a fake socket or a fake serial port where no
  network is needed, and use a raw `node:net` socket where the real transport matters.
- Serial lifecycle tests replace the serial port factory of `src/serial.js` with one that makes a
  fake serial port (`set_serial_port_factory`, not part of the public API), so no serial hardware
  or native binding is needed.

## Serial tests

The serial tests run over a link whose two ends are set by the environment variable
`MODBUS_SERIAL_PORTS="<first>,<second>"`. They are off by default, since a machine need not have
serial ports, virtual or physical: when the variable is unset, the serial suites are skipped.

The variable takes one of four forms. An end containing `:` is a TCP end; any other end is a
serial device path. The usual way to set it is the runner `pnpm test:serial` (see "Serial test
runner" below); it can also be set by hand, e.g. to run the serial tests under
`node --test --experimental-test-coverage`.

| Form                                           | Link                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `COM11,COM12`                                  | Two serial ports linked like a null-modem cable: a com0com pair, or two physical ports wired together.    |
| `COM3,192.168.1.10:4001`                       | A serial port wired to a transparent serial-to-TCP converter in TCP server mode; the tests connect to it. |
| `COM3,192.168.1.10:4001\|192.168.1.10:4002`     | The same, with a remote pool: several `host:port` ends separated by `\|`, taken in turn.                  |
| `COM3,:4001`                                   | The same, with the converter in TCP client mode; the tests listen on the port and wait for it.            |

- **Transparent converters only.** A TCP end must be a converter that passes bytes through
  unchanged. A Modbus RTU-to-TCP gateway is not supported: it rewrites the frames, so the tests
  could not see the bytes on the line. The tests speak RTU-over-TCP on a TCP end.
- **Converter connections.** A converter in TCP server mode must accept at least 2 Modbus over
  TCP connections. The suites open and close their own TCP ends, one right after another, and do
  not wait for a converter to release a connection; a converter that keeps only one connection
  drops the new one while it still holds the old. For such a converter, give at least 2 remote
  ends (e.g. different channels of one gateway) as a remote pool.
- **Remote pool.** Each time the tests connect to a remote end (the pre-check, a raw-stream suite,
  the `rtu_over_tcp` target of a `Modbus_Client`), they take the next end of the pool, cycling
  through it, so two consecutive connections go to different ends. An end the run does not reach
  is not an error: what is under test is the serial port. A listening end `:port` is always a
  single one and cannot be in a pool.
- **Serial settings.** The suites run at 9600 baud, 8 data bits, no parity, 1 stop bit (9600 8N1),
  the usual Modbus default. A converter's serial side must be set to the same.
- **Baud-rate sweep.** With two serial ports, a sweep runs first: at each of 1200, 2400, 4800,
  9600, 19200, 38400, 57600 and 115200 baud (8N1) it sends a request from the peer and checks the
  response. A rate that fails is not an error, since a port need not support every rate. The sweep
  always tries every rate and, when done, lists all the rates that worked; it passes when at least
  one worked. When none works, it fails and the other serial suites are not run. With a TCP end
  there is no sweep, since the converter's rate is fixed.
- **Suite baud rate with two serial ports.** 9600 is the industry default, so the other serial
  suites use it whenever the rates that worked include it. Only when that list lacks 9600 do they
  run at the first rate in it.
- **Roles.** With two serial ports, the server side opens the first and the peer (a raw serial
  port, or `Modbus_Client`) the second. With a TCP end, the library under test is on the serial
  port in both roles, and the TCP end is its peer: a client, a server or a raw socket, whichever
  the connection direction allows (`Modbus_Server` only listens; `Modbus_Client` only connects).
- **Set means required.** Before the serial suites run, a pre-check opens every serial end and
  connects to (the next end of a remote pool) or waits for the TCP end. When `MODBUS_SERIAL_PORTS` is set and an end cannot be
  used, the serial suites fail with the reason; they are skipped only when the variable is unset.
- **Re-opening a serial port.** A serial port just closed may refuse to re-open for a few tens of
  milliseconds (seen with a CH340 driver: `Access is denied`). Whenever the tests open a serial
  port, whether as a raw stream, through `Modbus_Server.start()` or through a serial
  `Modbus_Client`, a failure is retried every 20 ms for up to 500 ms; only a failure that lasts
  longer is reported, so a port that is really in use still fails. The restart test pauses 100 ms
  between `stop()` and `start()`, since it checks the two calls, not the driver. The library itself
  does not retry: an open failure is passed to the caller.

### Serial test runner

`pnpm test:serial` (`test/run-serial.js`) runs the serial tests over every direction of a serial
port in one command. It handles only the serial tests; the other tests run with `pnpm test`.
It takes one of two forms, and the first argument is always a serial port (no `:`):

| Form                                            | Runs, in order                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `pnpm test:serial COMn COMm`                    | `COMn,COMm`, then the reverse direction `COMm,COMn`                               |
| `pnpm test:serial COMn [:port] [host:port ...]` | `COMn,:port` when `:port` is given; then `COMn,<pool>` when remote ends are given |

- `:port` is optional; when given, it comes right after the serial port, and there is only one.
  Any number of remote ends `host:port` may follow and form the remote pool of one run. At least
  one of the two must be given; leaving one out tests only the other direction.
- The two forms cannot be mixed (e.g. `COM4 COM5 :502`): that would need the first serial port
  wired to another serial port and to a converter at the same time.
- Arguments that fit neither form print the usage and exit with code 2; no test runs.
- Each run is a `node --test test/serial.test.js` child process with `MODBUS_SERIAL_PORTS` set for
  it only; the next run starts once it has exited, so every port and connection it held has been
  released. There is no wait between runs: re-opening a serial port is covered by the open retry
  above, and the TCP side by the converter requirement. With two serial ports the baud-rate sweep
  runs in each direction.
- A failed run does not stop the others. At the end the runner lists each run as `pass` or `FAIL`
  and exits with code 1 when any failed.
