---
id: akh9t866
opened: 2026-11-16T05:50:46.406Z
closed: 2026-11-16T10:13:50.442Z
title: Drop the TCP converter from the serial tests and use a UDP converter
status: fixed       # open | accepted | fixed | rejected | wontfix
labels: [test]
remote:
---

## Problem

With only one serial port, the serial tests use a transparent serial-to-TCP converter as the other end of the line, and speak RTU-over-TCP on the TCP end. The converter is only a tool to drive the other end of the line; what is under test is the serial transport. The TCP transport itself is already covered by the loopback tests.

TCP has connections, and converters handle them in different ways, so the tests have built up a set of mechanisms that have nothing to do with serial ports (see "Serial tests" and "Serial test runner" in `doc/design-test.md`):

- **Two modes, two runs**: a converter's TCP server mode and TCP client mode are tested separately, and the command line has two kinds of end for them, `:port` and `host:port`.
- **Remote pool**: some converters keep only one connection in server mode (the Teclast converter) and drop a new one when the suites close and open connections right after another, so at least two remote ends must be given and taken in turn.
- **TCP wait**: some converters in client mode reconnect a fixed ~15 s after a close (InHand IR315), so every suite waits, and the wait limit is 30 s for that reason.
- **Settle time**: some converters reset a connection that receives data in its first tens of milliseconds (InHand IR315), hence the option `--settle` and the environment variable `MODBUS_CONVERTER_SETTLE_MS`.
- **Converter address**: several converters on the LAN may connect to the same port of the test machine, hence `:port@address`, where the tests close the connections from other addresses one by one.

All of these come from connection semantics and make up a large part of the serial test documents and code; every connection quirk of a converter shows up as a serial test failure, which is easily mistaken for a defect of the library.

The library now supports RTU-over-UDP (issue#svgqmfra). UDP has no connection, so none of the problems above exist there.

## Proposal

The serial tests drop the TCP converter and use a transparent serial-to-UDP converter instead, speaking RTU-over-UDP on the UDP end. This is a replacement, not an addition: both forms of TCP end, the remote pool, the TCP wait, the settle time (`--settle`, `MODBUS_CONVERTER_SETTLE_MS`) and `:port@address` are all removed, together with their code, tests and documents. Keeping both kinds of end would double the combinations to maintain and to run, while a TCP end adds no coverage of the serial transport.

The command line takes two forms, and the first argument is always a serial port:

```
pnpm test:serial <serial> <serial>
pnpm test:serial <serial> <local-udp-port> [<remote-host>:<remote-port>]
```

- The first form is unchanged: two serial ports wired together, one run in each direction.
- The second form: the serial port is wired to a converter, and the tests bind the local UDP port `<local-udp-port>` (e.g. `502`); the converter must be set to send the serial data to this port of the test machine. There is one run only, with no converter modes to tell apart.
- Without the third argument, the tests learn the remote IP address and port from a datagram the converter sends to the local port, and from then on send to and accept from that address and port only.
- The third argument names the remote, for two cases: several converters on the LAN send to the same port of the test machine; or the converter sends from a source port other than the port it receives on. When it is given, the tests send datagrams to `<remote-host>:<remote-port>` and accept only datagrams from that IP address, whatever their source port.

The forms of `MODBUS_SERIAL_PORTS` change accordingly, to express the same two kinds of link.

The requirement on the converter is the same as now: it is transparent and passes bytes through unchanged. A Modbus RTU-to-TCP/UDP gateway is not supported. How the converter packs the serial bytes into datagrams does not matter: RTU-over-UDP delimits the datagrams of one peer as one byte stream, so a frame split across several datagrams is handled too.

Alternatives not adopted:

- Keep the TCP end and add a UDP end. Not adopted for the reason above: the combinations double, and the connection mechanisms would all stay.
- Keep the TCP end and remove only some mechanisms such as the settle time. Not adopted because each mechanism matches a defect of a real converter, which could no longer be tested without it.

## Decision

Accepted: the converter end of the serial tests changes from TCP to UDP as proposed, and every mechanism of the TCP end is removed. The converter is only a tool to drive the other end of the line, and UDP has no connection, so the mechanisms and failures that came from connections go away with it.
