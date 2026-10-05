# Protocol: framing, ranges, function codes

Covers the wire-level rules shared by client and server.

## Transports and framing

| Transport      | Selected when                              | Framing                                             |
| -------------- | ------------------------------------------ | -------------------------------------------------- |
| TCP            | client address is a string, `rtu: false`  | MBAP header (7 bytes) + PDU.                        |
| RTU-over-TCP   | client address is a string, `rtu: true`   | RTU framing (unit ID + PDU + CRC16) carried on a TCP socket. |
| RTU            | client address is not a string            | RTU framing on a serial port.                       |

The server's transport is selected by `options.port` and `options.rtu` (see `spec-server.md`).

### MBAP header (TCP)

| Offset | Field              | Notes                                        |
| ------ | ------------------ | -------------------------------------------- |
| 0–1    | Transaction ID     | Echoed by the responder; used for matching.  |
| 2–3    | Protocol ID        | Always `0`; a non-zero value is invalid.     |
| 4–5    | Length             | Byte count of everything after this field (unit ID + PDU). Must be 3–253. |
| 6      | Unit ID            | Unit address (see "Unit ID").               |
| 7…     | PDU                | Function code + function data.               |

### RTU frame

`[unit_id: 1][function_code: 1][function data: n][crc16: 2 LE]`. The PDU length (everything
except the trailing 2 CRC bytes) must be 3–253. RTU has no transaction field.

### Unit ID

The meaning of the unit ID depends on the transport, following common Modbus practice:

- **Serial bus** (RTU, and RTU-over-TCP, which carries a serial line). `0` is the broadcast
  address: a broadcast write is executed by every slave and answered by none. `1..247` are
  individual slave addresses. `248..255` are reserved by the Modbus serial line specification and
  should not be assigned to a slave. A slave answers only requests addressed to itself.
- **TCP.** There is no broadcast; `0` is an ordinary unit ID. The unit ID selects a unit behind
  the server, as through a gateway. By convention (Modbus TCP implementation guide) `0xFF` (255)
  addresses the server itself when no unit routing is needed; this library treats it as an
  ordinary unit ID.

### Frame delimiting

- **TCP.** A single read may contain several coalesced frames. Receivers must split such a read
  into individual frames using the MBAP length field and process each frame separately; a
  malformed header ends the extraction.
- **RTU (serial).** Frames are separated by a silent interval of at least 3.5 character times.
  A receiver must collect incoming bytes until that silence elapses and treat the collected
  bytes as one frame. A single read may carry only part of a frame.
- **RTU-over-TCP.** A stream has no inter-frame silence; frame boundaries come from the length
  implied by the function code and, where present, the byte count.

## Range notation

`read` and `write` take a **range**: a start address and a length, together with the table (or
the function code) it applies to. A range given to the client takes one of two forms, **decided
strictly by JavaScript type** and never by guessing from its value:

- a **Modicon string**, such as `"40001,73"`: a Modicon address with an optional length;
- a **structured PDU range**, an array or an object that carries a function code, a PDU address
  and a length.

A numeric string is a Modicon string and must match the notation below; a `number` is never read
as Modicon. For example `"40001"` is Modicon, while the `pdu_addr` `40001` is the PDU address
40001.

### Modicon string

The string matches `^(\d{5,6})(,(\d{1,4}))?$`:

- **5-digit form.** The leading digit is the table selector; the remaining 4 digits are the
  point number.
- **6-digit form.** The leading digit is the table selector; the remaining 5 digits are the
  point number.
- Both forms select the same tables below and are told apart by digit count, so `"40001"` and
  `"400001"` name the same register.
- Optional `,N` suffix — a length (register/coil count), 1–4 digits.

| Leading digit | Table              | Read FC | Single-write FC | Multi-write FC |
| ------------- | ------------------ | ------- | --------------- | -------------- |
| `0`           | coils              | 1       | 5               | 15             |
| `1`           | discrete inputs    | 2       | —               | —              |
| `3`           | input registers    | 4       | —               | —              |
| `4`           | holding registers  | 3       | 6               | 16             |

Examples: `"40001"` → 1 holding register at 40001; `"40001,73"` → 73 holding registers starting
at 40001; `"400001,73"` → the same range in 6-digit form; `"00001,16"` → 16 coils.

A string that does not match the notation, or whose leading digit is not one of `0, 1, 3, 4`, is
not a valid range.

**Numbering base.** Modicon point numbers are **1-based by default**. The client chooses the base
when it is constructed (1-based, or 0-based on request) and it stays fixed for the client's
lifetime. The base applies to Modicon strings only, never to a structured PDU range.

| Base              | 5-digit point | 6-digit point | PDU address |
| ----------------- | ------------- | ------------- | ----------- |
| 1-based (default) | `1..9999`     | `1..65536`    | `point - 1` |
| 0-based           | `0..9999`     | `0..65535`    | `point`     |

### Structured PDU range

An array `[func_code, pdu_addr, length]` or an object `{ func_code, pdu_addr, length }`:

- `func_code` — a `number`, the decimal function code, one of `1, 2, 3, 4, 5, 6, 15, 16`.
- `pdu_addr` — a `number`, an integer in `0..65535`. PDU addresses are **always 0-based**: this
  is the address as carried on the wire, sent unchanged. The numbering base above does not apply.
- `length` — a `number`, an integer `>= 1`.

Every field must be a `number`; any other type (a numeric string, `boolean`, `bigint`, …) or an
out-of-range value makes the range invalid.

The length is also subject to the quantity limits below (exactly `1` for FC 5 and 6), and the
range must end within the PDU address space: `pdu_addr + length - 1 <= 65535`. The same two rules
apply to a Modicon string after its conversion to a PDU address. The client reports a violation
with its own message rather than as an invalid range (see `spec-client.md`).

Example: `[3, 256, 2]` and `{ func_code: 3, pdu_addr: 256, length: 2 }` both mean 2 holding
registers starting at PDU address 256, which is `"40257,2"` in 1-based Modicon notation.

### Address conversion on the wire

- **Client.** A Modicon string is converted to the PDU address `point - 1` (1-based numbering, the
  default) or `point` (0-based numbering); the PDU address of a structured PDU range is sent
  unchanged.
- **Server.** The server works in PDU addresses only. It performs no conversion and Modicon
  notation never appears on the server side: the `vector` receives the raw on-wire (0-based) PDU
  address as a `number`.

## Function codes and PDU shapes

Supported: `1, 2, 3, 4, 5, 6, 15, 16`. Any other code (in a request, or a non-exception
response) is rejected.

| FC | Operation                | Request data                          | Response data                         |
| -- | ------------------------ | ------------------------------------- | ------------------------------------- |
| 1  | Read Coils               | start addr, quantity                  | byte count + packed bits              |
| 2  | Read Discrete Inputs     | start addr, quantity                  | byte count + packed bits              |
| 3  | Read Holding Registers   | start addr, quantity                  | byte count + register words          |
| 4  | Read Input Registers     | start addr, quantity                  | byte count + register words          |
| 5  | Write Single Coil        | addr, `0xFF00` / `0x0000`             | echo of addr + value                 |
| 6  | Write Single Register    | addr, 16-bit value                    | echo of addr + value                 |
| 15 | Write Multiple Coils     | start addr, quantity, byte count, packed bits | start addr + quantity        |
| 16 | Write Multiple Registers | start addr, quantity, byte count, register words | start addr + quantity     |

A frame whose PDU length does not match its function code (exactly, for fixed-size functions;
`7 + byte_count` for the multiple-write requests) is rejected.

### Quantity limits

The Modbus protocol limits how many points one request may carry:

| FC | Maximum quantity |
| -- | ---------------- |
| 1, 2 | 2000 coils / discrete inputs |
| 3, 4 | 125 registers |
| 15   | 1968 coils |
| 16   | 123 registers |

The client rejects a request that exceeds its limit (see `spec-client.md`); the server answers
it with exception `0x03` (see "Exception responses").

### Bit packing

Coil values are packed LSB-first: coil *i* of the request occupies bit `i & 7` of byte `i >> 3`.
Read responses report `ceil(quantity / 8)` data bytes.

## CRC-16 (Modbus)

Polynomial `0xA001`, initial value `0xFFFF`, no final XOR. The 16-bit result is written
**little-endian** as the last two bytes of an RTU frame. A received RTU frame whose CRC does not
match is rejected.

## Exception responses

An exception response is `[unit_id][function_code | 0x80][exception_code]` (RTU adds CRC, TCP
adds MBAP). The client surfaces it by rejecting the pending transaction with
`` `response error: ${exception_code}` ``. Exception codes the server emits:

| Code   | Meaning                                   | When the server sends it                    |
| ------ | ----------------------------------------- | ------------------------------------------ |
| `0x01` | Illegal Function                          | Function code not in the supported set.     |
| `0x02` | Illegal Data Address                      | The requested range ends past address 65535. |
| `0x03` | Illegal Data Value                        | A quantity outside the limits above (`>= 1` and at most the maximum), a byte count that does not match the quantity (FC 15/16), or an FC 5 value other than `0xFF00` / `0x0000`. |
| `0x04` | Server Device Failure                     | A `vector` function threw while serving the request. |
| `0x0B` | Gateway Target Device Failed To Respond   | TCP only: request addressed to a unit ID the server is not configured to accept. On a serial bus such a request is not answered. |

For a supported function code the server checks the request in this order, as the Modbus
application protocol does: the data values (`0x03`), then the address range (`0x02`), and only
then calls the `vector` (`0x04` if it throws). A request that fails a check is not executed.
