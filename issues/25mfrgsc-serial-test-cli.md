---
id: 25mfrgsc
opened: 2026-11-12T14:53:10.701Z
closed: 2026-11-12T19:47:41.151Z
title: Serial tests have no command-line entry with arguments and test only one link per run
status: fixed           # open | accepted | fixed | rejected | wontfix
fixed_in: [9fab5ce] # commit IDs, backfilled at version commit time
labels: [test]
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

The serial tests `test/serial.test.js` take their link only from the environment variable `MODBUS_SERIAL_PORTS="<first>,<second>"`; `package.json` has no script for them.

- How to set an environment variable depends on the shell (PowerShell needs `$env:MODBUS_SERIAL_PORTS=...` first, sh can put it before the command), which makes running them by hand inconvenient.
- A run tests only one link, with fixed roles:
  - With two serial ports, the server side is on the first end and the peer on the second; the reverse direction is not tested. Testing it takes another run with the two ends swapped.
  - With a TCP end, the class on the serial port depends on the connection direction: the server for `host:port` (the tests connect to the converter), the client for `:port` (the converter connects to the tests). Testing both directions takes two runs, one with each form.
- When the tests connect to the converter (`host:port`), one run connects 4 times in a row: the pre-check, the two raw-stream suites, and the `Modbus_Client` of the last suite, each right after the previous connection closed. A converter that keeps only one connection drops the new one while the old one is not yet released. Measured: a Hongdian DTU gateway keeps one connection per channel, and about half of the reconnects made right after a close are reset; alternating between two channels (502, 503) with no pause worked in 20 of 20 attempts.

## Proposal

Add a script `pnpm test:serial` that takes all the ends at once; a runner expands them by the directions of the serial port and runs them one after another. The serial port is what is tested; a TCP end is only the serial port's peer and need not be tested one by one.

### Arguments

Only two forms are allowed, and the first argument must be a serial port (without `:`):

| Form | Runs, in order |
|---|---|
| `pnpm test:serial COMn COMm` | `COMn,COMm`, then the reverse direction `COMm,COMn` |
| `pnpm test:serial COMn [:port] [host:port ...]` | `COMn,:port` when `:port` is given; then, when remote ends are given, `COMn,<remote pool>` |

- The local listening end `:port` is optional; when given, it comes right after the serial port, and there is only one. The listening port on the computer is fully under control and needs no pool.
- It may be followed by zero or more remote ends `host:port`, which form a remote pool. One is usually enough; more are given to cope with a converter that does not support several connections.
- At least one of `:port` and a remote end is given; to test only one direction, leave out the other.
- For example, `pnpm test:serial COM4 :502 192.168.89.2:502 192.168.89.2:503` makes two runs: `COM4,:502`, then `COM4,192.168.89.2:502|192.168.89.2:503`.
- Mixing the two forms (e.g. `COM4 COM5 :502`) is not supported. It would need the first serial port physically connected to another serial port and to a converter at the same time, which is too much trouble to build.
- When the number of arguments is wrong, the first argument is not a serial port, the forms are mixed, or a `:port` is not right after the serial port or appears more than once, the runner prints the usage and exits with a non-zero code without running any test.

### Remote pool

- The second end of `MODBUS_SERIAL_PORTS` may be several remote ends separated by `|`, e.g. `COM4,192.168.89.2:502|192.168.89.2:503`. A local listening end is still a single one and cannot be mixed with remote ends.
- Each time the tests open a remote end (the pre-check, the raw-stream suites, the `rtu_over_tcp` of `Modbus_Client`), they take the next one in the pool, cycling through it. Two consecutive connections therefore go to different remote ends.
- A remote end in the pool that a run does not use is not an error; the tests are only concerned with the serial port.

### Running

- Each run starts its own `node --test test/serial.test.js` child process, with `MODBUS_SERIAL_PORTS` set for it only. Once a run's process has exited, the serial ports and TCP connections it held are certainly released, and only then does the next run start.
- With two serial ports, the baud-rate sweep runs in each direction.
- The runner does not wait between runs. The timing problem of re-opening a serial port is handled by issue#mhb62ep7 when the tests open a serial port; on the TCP side the hardware meets the requirement below, and the tests do not wait for it.
- When a run fails, the remaining runs still go ahead; at the end the runner summarizes the result of each run and exits with a non-zero code if any failed.
- The serial tests section of `doc/design-test.md` (and its Chinese version) describes the script and the remote pool, and states the connection requirement on a converter: a converter in TCP server mode must accept at least 2 Modbus over TCP connections; when it does not, give at least 2 remote ends (e.g. different channels of one gateway). The reason is that the suites open and close their own TCP ends, one right after another, without waiting for the converter to release a connection.

### Relation to issue#mhb62ep7

This issue handles the command-line entry point, expanding the runs and the remote pool. The timing problem of re-opening a serial port right after closing it is handled by issue#mhb62ep7, which retries briefly when the tests open a serial port, both between runs and within a run.

Alternatives not adopted:

- One run per TCP end: the serial port is what is tested, and testing each TCP end would only repeat the same serial tests.
- Taking from the remote pool per process (each run uses one end of the pool): a serial port has only one run in the remote direction, so the extra remote ends would never be used and could not cope with a converter that does not support several connections.
- Extending `MODBUS_SERIAL_PORTS` to several links and switching between them in one test process: the module-level state of `test/serial.test.js` (the link, the suite baud rate) would have to be reset per link, and releasing the ports and connections would rely only on the `after()` hooks, which is less reliable than process isolation.
- Merging with issue#mhb62ep7: that is a timing problem of the serial driver, while this issue is only about test tooling; the two have different rulings and completion criteria.

## Decision

Accepted. The approach has been settled: `pnpm test:serial` handles only the serial tests, runs one child process per direction of the serial port, and does not wait between runs; the remote ends form a pool, and the tests take the next one each time they connect. It is an improvement to the test tooling only and does not involve the library's behavior; the timing problem of re-opening a serial port is handled by issue#mhb62ep7.
