---
id: svgqmfra
opened: 2026-11-15T15:00:47.072Z
closed:
title: Support the Modbus UDP and RTU-over-UDP transports
status: accepted      # open | accepted | fixed | rejected | wontfix
labels: []
remote:
---

## Problem

The library currently supports three transports: Modbus TCP, Modbus RTU over a serial port, and RTU over TCP. It does not support the two UDP variants:

- **Modbus UDP**: an MBAP header plus the PDU, carried in a UDP datagram.
- **RTU over UDP**: an RTU frame (with CRC16) carried in a UDP datagram.

Devices in the field use both: many serial device servers offer an RTU-over-UDP mode, and some PLCs, gateways and meters offer Modbus UDP. Mainstream Modbus libraries commonly support UDP. To reach such a device, users currently have to switch to another library or reconfigure the device for TCP, which not every device allows.

### Where devices send responses

UDP devices do not agree on where they send a response:

- Most devices reply from the port that received the request, to the source address and port of the request.
- The UDP mode of a transparent serial device server (the common form of RTU over UDP) does not understand Modbus: it sends the data received on its serial line from its configured local port to a configured destination IP and port, regardless of the source port of the request. A client that sends its request from an ephemeral port assigned by the system never receives the response.
- A few devices reply from a source port different from the port they listen on.

## Proposal

Add both transports to the client and the server, selected by new option keys `udp` and `rtu_over_udp`, in the same form as the existing `tcp`, `rtu_over_tcp` and `serial`.

Reasons:

- Frame encoding and decoding reuse the existing implementations: Modbus UDP uses the MBAP frame, RTU over UDP uses the RTU frame.
- One datagram is exactly one ADU, so no stream reassembly is needed.
- Node's built-in `dgram` is used, with no native addon, so the transports work on every platform and can be tested entirely over the local loopback.

Behavior that must be specified:

- **Connectionless**: with no connection there is no automatic reconnect. A lost datagram is detected only by the request timeout.
- **Local port**: the client uses an ephemeral port assigned by the system by default, and allows a fixed local address and port to be specified, to work with devices that reply to a fixed destination port.
- **Source filtering**: by default the client accepts only datagrams from the target address and port, and discards the rest; the check can be relaxed to the source IP only, to work with devices that reply from a port other than the one they listen on.
- **Server**: one socket serves several clients, and each response goes back to the source address and port of its request.
- **No automatic resend**: after a timeout the request fails, as with TCP, and the caller decides whether to retry. Some devices treat a write as a trigger command, so a resend would execute it twice.
- **Matching in Modbus UDP**: responses are matched to requests by transaction ID. Out-of-order, late (whose request has already timed out) and duplicate responses are all recognized and discarded.
- **Matching in RTU over UDP**: RTU frames carry no transaction ID, so, as on a serial line, only one request may be in flight at a time, and the unit ID, function code and response length are checked. If the response to a timed-out request arrives late and the next request happens to have the same unit ID and function code, the stale response is accepted without any way to detect it. To reduce this risk, late datagrams should be discarded for a while after a timeout before the next request is sent. This is a limitation of the protocol itself and must be stated in the documentation.

Rejected alternative: supporting Modbus UDP only, without RTU over UDP. Rejected because the UDP mode of serial device servers is mostly RTU over UDP, which is the more common use.

## Decision

Accepted: support Modbus UDP and RTU over UDP as proposed. Some devices in the field can only be reached over these two transports, and since frame encoding and decoding are fully reused, the cost of implementation and testing is low.
