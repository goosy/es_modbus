// A simulated serial line between two byte endpoints, for tests.
//
// The line passes bytes unchanged between its ends `a` and `b`; per direction it can pace them
// at a baud rate, split them into chunks, delay, pause, alter, drop or inject bytes. RTU and
// RTU-over-TCP carry the same bytes, so one end can be a serial port and the other a TCP
// socket: the class under test sits on the serial end, its peer on the TCP end, either way round.
//
// Endpoints:
//   { serial: path }          a fake serial port. Modbus_Client / Modbus_Server get it for `path`
//                             through `serial_port_factory`, installed with
//                             set_serial_port_factory(serial_port_factory).
//   { stream }                an open stream with write() and `data` events, e.g. a SerialPort
//                             on one side of a virtual serial pair.
//   { connect: port, host? }  a TCP connection to a listening peer (an RTU-over-TCP server).
//   { listen: true, host? }   a TCP server on an ephemeral port, `bridge.port`, for a connecting
//                             peer (an RTU-over-TCP client or a raw socket); the last accepted
//                             socket is the endpoint.
//
// Line options, one object per direction (`to_a`: bytes delivered to `a`, `to_b`: to `b`):
//   char_time  ms each byte takes on the line. Defaults to the character time of a fake serial
//              end at the baud rate it was opened with (0 when there is none).
//   chunk      the most bytes delivered in one `data` event (default: all bytes of a write
//              together, once its last byte is on the line).
//   latency    ms before a write's first byte goes on the line.
//   tamper     (bytes, index) => result, called for each write in this direction (`index`
//              counts them from 0). Returns the bytes to send, an array of byte Buffers and
//              pauses in ms (e.g. [head, 20, tail]), null to drop the write, or undefined to
//              send it unchanged.
// Writes in one direction never overtake each other: a write starts once the previous is on
// the line.
//
// Usage:
//   set_serial_port_factory(serial_port_factory);
//   const bridge = await create_serial_bridge(
//       { serial: 'COM_A' }, { connect: server_port }, { to_a: { chunk: 1 } });
//   const client = new Modbus_Client(null, { port: 'COM_A', baud_rate: 19200, reconnect_time: 0 });
//   ...
//   bridge.inject('a', Buffer.from([0x00]));   // noise toward `a`
//   bridge.unplug();                           // the device is gone
//   await bridge.close();
//   set_serial_port_factory(null);

import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { Fake_Serial_Port } from './helpers.js';

const HOST = '127.0.0.1';

// Fake serial ends by path, for `serial_port_factory`
const serial_ends = new Map();

/** A factory for set_serial_port_factory(): the fake serial end of a bridge, by path. */
export async function serial_port_factory(settings) {
	const port = serial_ends.get(settings.path);
	if (!port) throw new Error(`No serial bridge end for ${settings.path}`);
	port.settings = settings;
	return port;
}

class Bridge_Serial_Port extends Fake_Serial_Port {
	on_bytes = null;

	write(buffer) {
		super.write(buffer);
		this.on_bytes?.(Buffer.from(buffer));
	}
}

/** One direction of the line: paces bytes in order and hands them to `deliver`. */
class Line {
	#options;
	#char_time;
	#deliver;
	#queue = []; // { at, bytes }, in delivery order
	#timer = null;
	#free_at = 0; // when the last scheduled byte is off the line
	#writes = 0;

	constructor(options, char_time, deliver) {
		this.#options = options;
		this.#char_time = char_time;
		this.#deliver = deliver;
	}

	write(bytes) {
		const { tamper } = this.#options;
		let result = tamper ? tamper(bytes, this.#writes) : bytes;
		this.#writes++;
		if (result === null) return;
		result ??= bytes;
		this.send(Array.isArray(result) ? result : [result]);
	}

	// Puts segments (Buffers and pauses in ms) on the line, untampered
	send(segments) {
		const { chunk = Number.POSITIVE_INFINITY, latency = 0 } = this.#options;
		const char_time = this.#options.char_time ?? this.#char_time();
		let at = Math.max(performance.now() + latency, this.#free_at);
		for (const segment of segments) {
			if (typeof segment === 'number') {
				at += segment;
				continue;
			}
			for (let i = 0; i < segment.length; i += chunk) {
				const bytes = segment.subarray(i, i + chunk);
				at += bytes.length * char_time;
				this.#queue.push({ at, bytes });
			}
		}
		this.#free_at = at;
		this.#pump();
	}

	#pump() {
		if (this.#timer || this.#queue.length === 0) return;
		const wait = Math.max(0, this.#queue[0].at - performance.now());
		this.#timer = setTimeout(() => {
			this.#timer = null;
			// Timers fire on whole ms: deliver everything due within this one
			const now = performance.now() + 1;
			while (this.#queue.length > 0 && this.#queue[0].at <= now) {
				this.#deliver(this.#queue.shift().bytes);
			}
			this.#pump();
		}, wait);
	}

	clear() {
		clearTimeout(this.#timer);
		this.#timer = null;
		this.#queue.length = 0;
	}
}

/** The time one character takes at the settings a fake serial port was opened with. */
function serial_char_time(settings) {
	if (!settings) return 0;
	const { baudRate, parity, dataBits, stopBits } = settings;
	return (1 + dataBits + (parity === 'none' ? 0 : 1) + stopBits) * 1000 / baudRate;
}

/** Makes an endpoint: `{ deliver(bytes), unplug(), close(), serial_port? }`, wired to `on_bytes`. */
async function make_end(spec, on_bytes, bridge) {
	if (spec.serial !== undefined) {
		if (serial_ends.has(spec.serial)) throw new Error(`Serial bridge end ${spec.serial} exists`);
		const port = new Bridge_Serial_Port(null);
		port.on_bytes = on_bytes;
		serial_ends.set(spec.serial, port);
		const drop = () => {
			if (serial_ends.get(spec.serial) === port) serial_ends.delete(spec.serial);
		};
		return {
			serial_port: port,
			deliver: (bytes) => {
				if (port.isOpen) port.emit('data', bytes);
			},
			unplug: () => {
				if (!port.isOpen) return;
				port.isOpen = false;
				port.emit('close');
			},
			close: drop,
		};
	}

	const stream_end = (stream) => {
		stream.on('data', on_bytes);
		return {
			deliver: (bytes) => {
				if (!stream.destroyed) stream.write(bytes);
			},
			unplug: () => stream.destroy(),
			close: () => stream.destroy(),
		};
	};

	if (spec.stream) return stream_end(spec.stream);

	if (spec.connect !== undefined) {
		const socket = connect(spec.connect, spec.host ?? HOST);
		socket.on('error', () => { });
		await once(socket, 'connect');
		return stream_end(socket);
	}

	if (spec.listen) {
		const server = createServer();
		let socket = null;
		server.on('connection', (accepted) => {
			socket?.destroy();
			socket = accepted;
			socket.on('error', () => { });
			socket.on('data', on_bytes);
		});
		server.listen(0, spec.host ?? HOST);
		await once(server, 'listening');
		bridge.port = server.address().port;
		return {
			deliver: (bytes) => {
				if (socket && !socket.destroyed) socket.write(bytes);
			},
			unplug: () => socket?.destroy(),
			close: () => {
				socket?.destroy();
				return new Promise((resolve) => server.close(() => resolve()));
			},
		};
	}

	throw new Error('Invalid serial bridge endpoint');
}

/**
 * Links endpoints `a` and `b` through a simulated serial line (see the top of this file).
 * Returns `{ port, a, b, inject(to, bytes), unplug(), close() }`; `a` / `b` are the fake serial
 * ports of serial ends (undefined for others), `port` the TCP port of a listening end.
 */
export async function create_serial_bridge(a_spec, b_spec, { to_a = {}, to_b = {} } = {}) {
	const bridge = { port: undefined };
	const lines = {};
	const ends = {};
	// The character time of the fake serial end, once it was opened
	const char_time = () => serial_char_time(ends.a.serial_port?.settings ?? ends.b.serial_port?.settings);

	ends.a = await make_end(a_spec, (bytes) => lines.b.write(bytes), bridge);
	try {
		ends.b = await make_end(b_spec, (bytes) => lines.a.write(bytes), bridge);
	} catch (error) {
		await ends.a.close();
		throw error;
	}
	lines.a = new Line(to_a, char_time, (bytes) => ends.a.deliver(bytes));
	lines.b = new Line(to_b, char_time, (bytes) => ends.b.deliver(bytes));

	return Object.assign(bridge, {
		a: ends.a.serial_port,
		b: ends.b.serial_port,
		/** Puts bytes on the line toward end `to` ('a' or 'b'), bypassing `tamper`. */
		inject(to, ...segments) {
			lines[to].send(segments);
		},
		/** Drops the bytes on the line and disconnects both ends, as when the device is gone. */
		unplug() {
			lines.a.clear();
			lines.b.clear();
			ends.a.unplug();
			ends.b.unplug();
		},
		async close() {
			lines.a.clear();
			lines.b.clear();
			await Promise.all([ends.a.close(), ends.b.close()]);
		},
	});
}
