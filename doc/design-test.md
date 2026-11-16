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
each class alone; `test/tcp.test.js` and `test/serial.test.js` run the classes end to end over loopback TCP and
a serial port pair; `test/serial-bridge.test.js` checks the timing of the serial paths (bytes
paced at the baud rate, pauses longer than the line silence, a late response, a device that is
gone) over a simulated serial line between two fake serial ports;
`test/udp.test.js` covers the UDP family, each class against a raw UDP peer and the two end to
end over loopback UDP;
`test/bundle.test.js` covers the build output `dist/modbus.js` with `native/`. Fixtures, the simulated
serial line (`create_serial_bridge`) among them, live in `test/helpers.js`; its `parse_link()` of `test/helpers.js` parses
`MODBUS_SERIAL_PORTS` for both the serial tests and the serial test runner. The serial test
helpers have no tests of their own: a wrong value makes the serial run fail with the reason.

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
  with a fixed target and its `port` property is then set to `0` (`ephemeral_server` and
  `start_udp_server` in `test/helpers.js`).
- UDP tests use raw `node:dgram` sockets on `127.0.0.1` as the fake device or client
  (`start_fake_udp_device`, `raw_udp_socket`), so a reply can come from another port, be split
  across datagrams, or arrive late. A local port in use is made by binding a raw socket to it.
- Client tests use a raw `node:net` server as a fake slave, so the exact bytes on the wire can be
  checked and malformed or out-of-order replies can be produced.
- Server tests feed frames to `on_data` through a fake socket or a fake serial port where no
  network is needed, and use a raw `node:net` socket where the real transport matters.
- Serial lifecycle tests replace the serial port factory of `src/serial.js` with one that makes a
  fake serial port (`set_serial_port_factory`, not part of the public API), so no serial hardware
  or native binding is needed.

## Serial tests

The serial tests run over a link whose two ends are set by the environment variable
`MODBUS_SERIAL_PORTS`. They are off by default, since a machine need not have serial ports,
virtual or physical: when the variable is unset, the serial suites are skipped.

The variable takes one of three forms. The first end is always a serial device path; a second end
of digits only is a local UDP port, any other a serial device path. The usual way to set it is the
runner `pnpm test:serial` (see "Serial test runner" below); it can also be set by hand, e.g. to
run the serial tests under `node --test --experimental-test-coverage`.

| Form                           | Link                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `COM11,COM12`                  | Two serial ports linked like a null-modem cable: a com0com pair, or two physical ports wired together.                               |
| `COM3,502`                     | A serial port wired to a transparent serial-to-UDP converter that sends the serial data to UDP port 502 of the test machine.         |
| `COM3,502,192.168.1.10:4001`   | The same, naming the converter: datagrams go to that address and port, and only datagrams from that address are taken.               |

- **Transparent converters only.** The converter must pass bytes through unchanged. A Modbus
  RTU-to-TCP/UDP gateway is not supported: it rewrites the frames, so the tests could not see the
  bytes on the line. The tests speak RTU-over-UDP on the UDP end. How the converter packs the
  serial bytes into datagrams does not matter: RTU-over-UDP delimits the datagrams of one peer as
  one byte stream (see "Datagrams" in `spec-protocol.md`).
- **Converter setup.** The converter is set to send the serial data to the local UDP port on the
  test machine, and its serial side to the serial settings below. The tests bind that port on
  every local IPv4 address; each suite binds and releases it in turn. UDP has no connection, so a suite never waits for the converter.
- **Learned remote.** Without a remote, the pre-check learns it: the sender (address and port) of
  the datagrams that bring the probe from the serial port to the local port. From then on the run
  sends to that address and port and takes only datagrams from that address and port. A
  transparent converter sends only when bytes arrive on its serial side, so other converters on
  the LAN that send to the same port do not get in the way while their serial lines are quiet:
  only the converter wired to the serial port under test sends the probe (seen with two
  converters sending to `:502`, whichever was wired to the serial port). A datagram from another
  converter during the probe makes the pre-check fail, since the bytes received are not the
  probe; it is never taken for the remote silently.
- **Given remote.** The remote `<address>:<port>` is an IPv4 address (a host name is refused) and
  the port the converter receives on. It is needed in two cases: another converter sends to the
  same port while the run is on, e.g. its serial side is on a busy bus or it sends heartbeat or
  registration packets; or the converter sends from a source port other than the one it receives
  on, so the learned port does not reach it. With a given remote, datagrams go to that address
  and port, and a datagram from that address is taken whatever its source port
  (`any_source_port` on a `Modbus_Client`).
- **Response wait.** A raw peer waits up to 1 s for bytes that are due (a response, a request, a
  probe), the same as the `timeout` of the clients in these suites. A converter may hold serial
  bytes for hundreds of milliseconds before it sends them as a datagram (seen: about 400 ms a
  round trip). Bytes that arrive sooner end the wait, so a fast link pays nothing.
- **Serial settings.** The suites run at 9600 baud, 8 data bits, no parity, 1 stop bit (9600 8N1),
  the usual Modbus default. A converter's serial side must be set to the same.
- **Baud-rate sweep.** With two serial ports, a sweep runs first: at each of 1200, 2400, 4800,
  9600, 19200, 38400, 57600 and 115200 baud (8N1) it sends a request from the peer and checks the
  response. A rate that fails is not an error, since a port need not support every rate. The sweep
  always tries every rate and, when done, lists all the rates that worked; it passes when at least
  one worked. When none works, it fails and the other serial suites are not run. With a UDP end
  there is no sweep, since the converter's rate is fixed.
- **Suite baud rate with two serial ports.** 9600 is the industry default, so the other serial
  suites use it whenever the rates that worked include it. Only when that list lacks 9600 do they
  run at the first rate in it.
- **Roles.** With two serial ports, the server side opens the first and the peer (a raw serial
  port, or `Modbus_Client`) the second. With a UDP end, the library under test is on the serial
  port in both roles, and the UDP end is its peer: a raw socket, an RTU-over-UDP `Modbus_Client`
  (bound to the local port with `local`) or an RTU-over-UDP `Modbus_Server`. The end-to-end suite
  of the two classes therefore runs twice, once with each class on the serial port. An
  RTU-over-UDP server answers to the address and port a request came from, so the run with the
  server on the UDP end is skipped when the converter sends from another port than the given
  remote's.
- **Set means required.** Before the serial suites run, a pre-check opens every end. With a UDP
  end it also passes a probe (a read request that no one answers) through the converter each way
  and expects the same bytes within the response wait: first from the serial port to the local UDP port, which
  also gives the learned remote and the port the converter sends from; then from the UDP end to
  the serial port. When `MODBUS_SERIAL_PORTS` is set and an end cannot be used or a probe does
  not arrive, the serial suites fail with the reason; they are skipped only when the variable is
  unset.
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
It takes one of two forms, and the first argument is always a serial port:

| Form                                                          | Runs, in order                                       |
| ------------------------------------------------------------- | ---------------------------------------------------- |
| `pnpm test:serial COMn COMm`                                  | `COMn,COMm`, then the reverse direction `COMm,COMn`  |
| `pnpm test:serial COMn <local-udp-port> [<address>:<port>]`   | `COMn,<local-udp-port>[,<address>:<port>]`           |

- The arguments are the ends of `MODBUS_SERIAL_PORTS`, one each: `<local-udp-port>` is the UDP
  port the converter sends to, e.g. `pnpm test:serial COM4 502`, and the optional third argument
  names the converter (see "Given remote" above), e.g. `pnpm test:serial COM4 502
  192.168.89.2:4001`.
- A UDP end is one run: there is no direction to reverse, and both roles of the serial port are
  covered in it.
- Arguments that fit neither form, or that `MODBUS_SERIAL_PORTS` would refuse (a remote that is
  not an IPv4 address with a port), print the reason and the usage and exit with code 2; no test
  runs. The runner takes no options.
- Each run is a `node --test test/serial.test.js` child process with `MODBUS_SERIAL_PORTS` set
  for it only; the next run starts once it has exited, so every port it held has been released.
  There is no wait between runs: re-opening a serial port is covered by the open retry above.
  With two serial ports the baud-rate sweep runs in each direction.
- A failed run does not stop the others. At the end the runner lists each run as `pass` or `FAIL`
  and exits with code 1 when any failed.
