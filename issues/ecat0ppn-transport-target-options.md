---
id: ecat0ppn
opened: 2026-11-12T08:35:45.067Z
closed:
title: Select the Modbus_Client and Modbus_Server transport by a tcp / rtu_over_tcp / serial option
status: accepted      # open | accepted | fixed | rejected | wontfix
fixed_in: []        # commit IDs, backfilled at version commit time
labels: []
remote:
problem_title:
proposal_title:
decision_title:
---

## Problem

### Client

The `Modbus_Client` constructor is `new Modbus_Client(address, options)`, and its first parameter `address` does two jobs: its type selects the transport, and as a string its value is also the TCP host.

- A serial client must pass a non-string placeholder for `address`, for example `new Modbus_Client(null, { port: 'COM3' })`. The `null` means nothing by itself: a reader cannot see that it stands for "serial".
- When the host is missing from the configuration (`address` is `undefined`), the client silently switches to serial, and since `port` defaults to `502`, the error finally reported is `Invalid serial port`, which does not match the real cause (no host configured).
- The `port` option has two meanings: a network port number for TCP, a device path for serial. The `rtu` option applies only when `address` is a string. Callers have to remember how these options combine.
- Options that do not apply to the transport are silently ignored, for example `baud_rate` on a TCP client or `keep_alive` on a serial client. A misconfiguration raises no error, so it goes unnoticed.

### Server

`Modbus_Server` selects its transport by the type of the `port` option: a number is a TCP port, a string a serial path.

- `port` has two meanings here too. `host` applies only to TCP, and `rtu` is ignored for serial.
- The serial options are silently ignored on a TCP server, and so is `host` on a serial server.
- With nothing given, the server listens on `0.0.0.0:502`, an implicit choice that is easy to overlook.

The two sides also select the transport by different rules, so users have to remember two sets.

## Proposal

On both sides a key of the options names the transport, with a string target as its value:

```js
new Modbus_Client({ tcp: '10.0.0.5:502', timeout: 500 });
new Modbus_Client({ rtu_over_tcp: 'gateway:4001' });
new Modbus_Client({ serial: 'COM3', baud_rate: 19200, parity: 'even' });

new Modbus_Server(handler, { tcp: '0.0.0.0:502' });
new Modbus_Server(handler, { rtu_over_tcp: ':4001' });
new Modbus_Server(handler, { serial: 'COM4', baud_rate: 19200 });
```

### Rules common to both sides

- Exactly one of the properties `tcp`, `rtu_over_tcp` and `serial` must be given. With more than one, or none, the constructor throws synchronously. The server no longer has a default transport.
- The value of `tcp` and `rtu_over_tcp` is a `host:port` string:
  - an omitted port is `502`: `'10.0.0.5'` is the same as `'10.0.0.5:502'`;
  - an IPv6 address is enclosed in brackets: `'[::1]:502'`;
  - the port must be an integer in `1..65535`, otherwise it throws. Neither side accepts port `0`.
- The value of `serial` is the serial device path (a non-empty string).
- An option that does not apply to the selected transport is no longer ignored: the constructor throws synchronously (for example `Option baud_rate does not apply to tcp`). An option whose value is `undefined` or `null` counts as not given.

### Client

- The constructor takes a single options object. The `address` parameter and the `port` and `rtu` options are removed.
- The host part must not be empty, otherwise it throws.
- The transports each option applies to:

  | Option | `tcp` | `rtu_over_tcp` | `serial` |
  | --- | --- | --- | --- |
  | `baud_rate`, `parity`, `data_bits`, `stop_bits` | throws | throws | applies |
  | `reconnect_max`, `max_timeouts`, `keep_alive` | applies | applies | throws |
  | `turnaround` | throws | applies | applies |
  | `name`, `timeout`, `delay`, `silence`, `reconnect_time`, `modicon_zero_based` | applies | applies | applies |

### Server

- The constructor stays `new Modbus_Server(handler, options)`. The `host`, `port` and `rtu` options are removed.
- The host part may be omitted, which binds `0.0.0.0`: `':502'` is the same as `'0.0.0.0:502'`.
- The transports each option applies to:

  | Option | `tcp` | `rtu_over_tcp` | `serial` |
  | --- | --- | --- | --- |
  | `baud_rate`, `parity`, `data_bits`, `stop_bits` | throws | throws | applies |
  | `name`, `silence`, `unit_id` | applies | applies | applies |

Reason: both `host:port` and a serial path are a single string, the way people usually write them. With the transport named by the key, behavior is no longer inferred from the type of a value, and there is no need to tell whether `port` means a network port or a serial port. Both sides follow the same rules, so users remember one set. The whole options object can also be read as is from a JSON configuration. An option that does not apply is most likely a misconfiguration, and throwing at construction is what lets it be noticed on the spot. The server may omit the host because binding every interface is its most common choice, while a client has to name the machine it connects to.

The project has not had its official release yet, so this breaking change keeps no old form.

Alternatives not adopted:

- Selecting the transport on both sides by the type of `port`, as the server does now: `port` would still have two meanings.
- Passing the `host:port` string or serial path as the first positional parameter: a string alone cannot tell whether `plc1` is a host or a serial port.
- Static factories `Modbus_Client.tcp()` / `Modbus_Client.serial()`: they only rule out giving two transport keys at once; the target string format, extra transport keys and inapplicable options still need run-time checks, so they guarantee correct arguments no better than a strictly checking constructor, and they add a second set of construction entry points. If type declarations are provided later, factories can be added then as new API without breaking existing use.

## Decision

Accepted. Change both sides as proposed: the transport is selected by exactly one of the keys `tcp`, `rtu_over_tcp` and `serial`, an inapplicable option throws, and no factories are added. A string target matches how people write a connection target, both sides follow the same rules, and strict checking at construction exposes a misconfiguration when the object is built.
