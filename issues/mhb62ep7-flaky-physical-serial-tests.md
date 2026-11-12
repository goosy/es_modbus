---
id: mhb62ep7
opened: 2026-11-12T14:40:15.054Z
closed: 2026-11-12T19:33:28.537Z
title: Re-opening a serial port right after closing it fails intermittently, making serial tests on physical hardware unstable
status: fixed          # open | accepted | fixed | rejected | wontfix
fixed_in: []        # commit IDs, backfilled at version commit time
labels: [test]
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

When `test/serial.test.js` runs on physical hardware, tests fail intermittently. The cause is the timing of the serial driver, unrelated to the library's protocol handling. It does not occur with the com0com virtual serial ports.

The CH340 USB-to-serial chip (`COM4`, driver wch.cn 3.9.2024.9) occasionally reports `Access is denied` when it is re-opened right after being closed:

- Closing and immediately re-opening it 100 times in a row failed 5 times; after a failure, the port opened again within 26 to 38 ms.
- The same operation on com0com's `COM11` 200 times had no failure, so the problem is in the driver, not in serialport-rs.

The affected test is `stop() closes the port and emits stop; start() re-opens it`: it calls `server.start()` right after `server.stop()`, and occasionally reports:

```
Error: Access is denied.
  code: 'ERR_SERIALPORT_NOT_FOUND', path: 'COM4'
```

Between suites, a serial port is also closed and re-opened at once, which can fail the same way. A user of the library who calls `start()` right after `stop()` on a CH340 hits the same failure.

## Proposal

Change only `test/serial.test.js`; the library's behavior stays the same.

- When the tests open a serial port (`open_end()`, `start_serial_server()`) and the open fails, they retry briefly, for example every 20 ms for at most 500 ms. Only a failure that lasts past that limit is reported, so a port that is really in use still reports an error.
- The test `stop() closes the port and emits stop; start() re-opens it` checks that `stop()` closes the serial port and `start()` re-opens it, not whether the driver can re-open it at once. It waits 100 ms between `stop()` and `start()`, to avoid the driver's timing problem.
- The serial tests section of `doc/design-test.md` (and its Chinese version) states that opening a serial port is retried briefly.

Alternatives not adopted:

- Retrying the serial open in the library (`Modbus_Server.start()`, `Modbus_Client`): `Modbus_Client` already has a reconnect mechanism (`reconnect_time`), and `Modbus_Server.start()` rejecting with the error lets the caller decide how to handle it; retrying in the library would hide the error of a serial port that is really in use.

## Decision

Accepted. A serial driver such as the CH340 that occasionally fails to re-open a port right after closing it is a hardware timing problem; the tests avoid it by retrying briefly when they open a serial port and by waiting briefly between `stop()` and `start()`. The library's behavior stays the same: an open failure is still passed to the caller as an error.
