# es-modbus

[中文](./README.zh-cn.md)

A small Modbus client and server for Node.js, as ES modules, with no runtime dependencies.

- **Transports:** Modbus TCP, Modbus RTU on a serial port, and RTU over TCP.
- **Function codes:** 1, 2, 3, 4, 5, 6, 15, 16, and exception responses.
- **Client:** Promise-based reads and writes, per-request timeout, send pacing, automatic
  reconnect with exponential back-off, and dead-link detection on TCP.
- **Server:** one instance can serve several unit IDs; the data stays in your own `handler`.

## Installation

```sh
pnpm add es-modbus
```

Node.js 20.11 or later is required. The serial port support ships as prebuilt native addons for
Windows, macOS, Linux (glibc and musl) and Android; it is loaded only when a serial port is first
used, so TCP works on any platform.

## Client

```js
import { Modbus_Client } from 'es-modbus';

// Modbus TCP
const client = new Modbus_Client({ tcp: '192.168.1.10:502', timeout: 1000 });

// 2 holding registers at 40001, from unit 1
const data = await client.read('40001,2', 1);
console.log(data.readUInt16BE(0), data.readUInt16BE(2));

// write one holding register, and 16 coils
await client.write('40010', 1234, 1);
await client.write('00001,16', Buffer.from([0xff, 0x00]), 1);

await client.disconnect();
```

Exactly one of `tcp`, `rtu_over_tcp` and `serial` selects the transport. The first two take a
`host:port` string (the port defaults to `502`, an IPv6 host is written `[::1]:502`), `serial`
takes the device path:

```js
// RTU over TCP, e.g. a serial-to-Ethernet gateway
const gateway = new Modbus_Client({ rtu_over_tcp: '192.168.1.20:4001' });

// RTU on a serial port
const serial = new Modbus_Client({ serial: 'COM3', baud_rate: 19200, parity: 'even' });
```

### Ranges

A range is a start address and a length, in one of two forms:

- a **Modicon string**, `"<address>[,<length>]"`, 5 or 6 digits; the leading digit selects the
  table. Point numbers are 1-based, unless the client is created with `modicon_zero_based: true`.

  | Leading digit | Table             | Read FC | Write FC |
  | ------------- | ----------------- | ------- | -------- |
  | `0`           | coils             | 1       | 5, 15    |
  | `1`           | discrete inputs   | 2       | —        |
  | `3`           | input registers   | 4       | —        |
  | `4`           | holding registers | 3       | 6, 16    |

- a **structured PDU range**, `[func_code, pdu_addr, length]` or
  `{ func_code, pdu_addr, length }`, where `pdu_addr` is the 0-based address on the wire.

`"40257,2"`, `"400257,2"` and `[3, 256, 2]` all name the same two holding registers.

### Results and errors

- `read(range, unit_id = 1)` resolves with the raw payload `Buffer`: big-endian register words,
  or coil bits packed LSB first. Decoding is up to the caller.
- `write(range, value, unit_id = 1)` resolves with `true` when the response echoes the request.
  `value` is a `boolean` for one coil, an integer `0..65535` for one register, or a `Buffer` for
  several.
- Both reject with an `Error`: `transaction 0x<id> timeout`, `response error: <code>` for an
  exception response, `connection lost`, or `queue overflow`.
- An invalid argument (range, length, unit ID, value) throws synchronously.

### Main options

| Option           | Default | Meaning                                                        |
| ---------------- | ------- | -------------------------------------------------------------- |
| `tcp`, `rtu_over_tcp`, `serial` | — | The transport and its target; exactly one is required. |
| `timeout`        | `1000`  | Response timeout per request, ms.                              |
| `delay`          | `20`    | Minimum gap between frames, ms.                                |
| `reconnect_time` | `10000` | Initial reconnect delay, ms; `> 0` also connects at once.      |
| `reconnect_max`  | `60000` | Upper bound of the reconnect delay, ms.                        |
| `max_timeouts`   | `3`     | TCP: close a link after this many timeouts in a row; `0` = off. |
| `baud_rate`, `parity`, `data_bits`, `stop_bits` | `9600`, `'none'`, `8`, `1` | Serial line settings. |

An option that does not apply to the chosen transport, such as `baud_rate` on a TCP client,
throws at construction.

Events: `connect`, `disconnect`, `error`, `timeout`, `send`, `receive`, `data`, `data_error`.

## Server

The server holds no data: each request calls a function of your `handler`, with PDU (0-based)
addresses and the unit ID.

```js
import { Modbus_Server, Modbus_Exception } from 'es-modbus';

const holding = new Uint16Array(100);

const handler = {
	get_coil: (addr, unit_id) => false,
	get_input_register: (addr, unit_id) => 0,
	get_holding_register: (addr, unit_id) => holding[addr] ?? 0,
	set_coil: (addr, value, unit_id) => {},
	set_holding_register(addr, value, unit_id) {
		if (addr >= holding.length) throw new Modbus_Exception(0x02);
		holding[addr] = value;
	},
};

const server = new Modbus_Server(handler, { tcp: ':502', unit_id: [1, 2] });
server.on('handler_error', (error) => console.error(error));
await server.start();
```

The server selects its transport the same way as the client; an empty host, as in `':502'`,
binds `0.0.0.0`. For RTU on a serial port use e.g. `{ serial: '/dev/ttyUSB0', baud_rate: 19200 }`,
and for RTU over TCP `{ rtu_over_tcp: ':4001' }`.

- **Single-point methods:** `get_coil`, `get_discrete_input` (optional; without it FC 2 reads the
  coils), `get_holding_register`, `get_input_register`, `set_coil`, `set_holding_register`.
- **Batch methods (optional):** `get_coils`, `get_discrete_inputs`, `get_holding_registers`,
  `get_input_registers`, `set_coils`, `set_holding_registers`. When present, one request calls
  them once with all its points, e.g. to update a multi-register value in one step. A batch read
  may return an `Array` or a typed array, such as a view of your storage.
- The `handler` is synchronous; keep the data in memory.
- A register value must be an integer `0..65535`.
- To reject a request, throw an error whose `exception_code` is `0x01`, `0x02`, `0x03`, `0x04` or
  `0x06`, for example a `Modbus_Exception`. Anything else thrown answers `0x04` and is reported
  through `handler_error`.

Events: `start`, `stop`, `error`, `socket_connect`, `socket_disconnect`, `socket_error`, `send`,
`receive`, `handler_error`.

## Documentation

The full behavior is specified in [doc/spec.md](./doc/spec.md): the
[client](./doc/spec-client.md), the [server](./doc/spec-server.md) and the
[protocol](./doc/spec-protocol.md). Changes are listed in [CHANGELOG.md](./CHANGELOG.md).

## License

ISC
