// Shared test fixtures: in-memory handler, frame builders, fake peers.
import { createServer, Socket, isIP } from 'node:net';
import { createSocket } from 'node:dgram';
import { once, EventEmitter } from 'node:events';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { modbus_crc16 } from '../src/util.js';

export const HOST = '127.0.0.1';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Converts a hex string (spaces allowed) to a Buffer. */
export const hex = (str) => Buffer.from(str.replace(/\s+/g, ''), 'hex');

/** Appends the Modbus CRC-16 (little-endian) to an RTU frame body. */
export function rtu_frame(body) {
	const pdu = typeof body === 'string' ? hex(body) : body;
	const frame = Buffer.alloc(pdu.length + 2);
	pdu.copy(frame);
	frame.writeUInt16LE(modbus_crc16(pdu), pdu.length);
	return frame;
}

/** Prepends an MBAP header to `unit_id + PDU` (the body). */
export function tcp_frame(tid, body, pid = 0) {
	const pdu = typeof body === 'string' ? hex(body) : body;
	const frame = Buffer.alloc(pdu.length + 6);
	frame.writeUInt16BE(tid, 0);
	frame.writeUInt16BE(pid, 2);
	frame.writeUInt16BE(pdu.length, 4);
	pdu.copy(frame, 6);
	return frame;
}

/**
 * An in-memory handler backed by one 65536-point table per kind and unit.
 * Every call is recorded in `calls` as `[name, ...args]`.
 */
export function create_memory_handler() {
	const units = new Map();
	const calls = [];
	const unit = (unit_id) => {
		if (!units.has(unit_id)) {
			units.set(unit_id, {
				coils: new Uint8Array(65536),
				holding: new Uint16Array(65536),
				input: new Uint16Array(65536),
			});
		}
		return units.get(unit_id);
	};
	const handler = {
		get_coil(addr, unit_id) {
			calls.push(['get_coil', addr, unit_id]);
			return unit(unit_id).coils[addr] === 1;
		},
		set_coil(addr, value, unit_id) {
			calls.push(['set_coil', addr, value, unit_id]);
			unit(unit_id).coils[addr] = value ? 1 : 0;
		},
		get_holding_register(addr, unit_id) {
			calls.push(['get_holding_register', addr, unit_id]);
			return unit(unit_id).holding[addr];
		},
		get_input_register(addr, unit_id) {
			calls.push(['get_input_register', addr, unit_id]);
			return unit(unit_id).input[addr];
		},
		set_holding_register(addr, value, unit_id) {
			calls.push(['set_holding_register', addr, value, unit_id]);
			unit(unit_id).holding[addr] = value;
		},
	};
	return { handler, unit, calls };
}

/** A stand-in for a server-side TCP socket that records what is written. */
export function fake_socket() {
	return {
		written: [],
		write(buffer) {
			this.written.push(Buffer.from(buffer));
		},
	};
}

/**
 * A serial port stand-in for set_serial_port_factory(): open(callback) / close(callback)
 * complete asynchronously like the real port, and writes are recorded. `settings` holds what
 * it was created with; `fail_open` makes the next open fail.
 */
export class Fake_Serial_Port extends EventEmitter {
	isOpen = false;
	opens = 0;
	written = [];
	fail_open = false;
	constructor(settings) {
		super();
		this.settings = settings;
	}

	open(callback) {
		this.opens++;
		setImmediate(() => {
			if (this.fail_open) {
				const error = new Error('open failed');
				if (callback) callback(error);
				else this.emit('error', error);
				return;
			}
			this.isOpen = true;
			this.emit('open');
			callback?.(null);
		});
	}

	close(callback) {
		setImmediate(() => {
			this.isOpen = false;
			this.emit('close');
			callback?.(null);
		});
	}

	write(buffer) {
		this.written.push(Buffer.from(buffer));
	}
}

// A simulated serial line between two fake serial ports, for tests of the timing of the serial
// paths. Each end is a Fake_Serial_Port by path: Modbus_Client / Modbus_Server get it through
// `bridge_port_factory`, installed with set_serial_port_factory(bridge_port_factory), and a test
// can also open it itself as a raw peer. The line passes the bytes written at one end to the
// other, paced at the character time of the settings an end was opened with (0 when neither
// was). Line options, one object per direction (`to_a`: bytes delivered to `a`, `to_b`: to `b`):
//   chunk   the most bytes delivered in one `data` event (default: all bytes of a write
//           together, once its last byte is on the line).
//   tamper  (bytes, index) => result, called for each write in this direction (`index` counts
//           them from 0). Returns the bytes to send, an array of byte Buffers and pauses in ms
//           (e.g. [head, 20, tail]), null to drop the write, or undefined to send it unchanged.
// Writes in one direction never overtake each other: a write starts once the previous is on
// the line.

// The ends of the open bridges by path, for `bridge_port_factory`
const bridge_ends = new Map();

/** A factory for set_serial_port_factory(): the end of a serial bridge, by path. */
export async function bridge_port_factory(settings) {
	const port = bridge_ends.get(settings.path);
	if (!port) throw new Error(`No serial bridge end for ${settings.path}`);
	port.settings = settings;
	return port;
}

class Bridge_Serial_Port extends Fake_Serial_Port {
	line = null; // the direction away from this end

	write(buffer) {
		super.write(buffer);
		this.line.write(Buffer.from(buffer));
	}
}

/** One direction of the line: paces bytes in order and hands them to the port at its end. */
class Line {
	#options;
	#char_time;
	#port;
	#queue = []; // { at, bytes }, in delivery order
	#timer = null;
	#free_at = 0; // when the last scheduled byte is off the line
	#writes = 0;

	constructor(options, char_time, port) {
		this.#options = options;
		this.#char_time = char_time;
		this.#port = port;
	}

	write(bytes) {
		const { tamper } = this.#options;
		let result = tamper ? tamper(bytes, this.#writes) : bytes;
		this.#writes++;
		if (result === undefined) result = bytes;
		if (result === null) return;
		const segments = Array.isArray(result) ? result : [result];
		const { chunk = Number.POSITIVE_INFINITY } = this.#options;
		const char_time = this.#char_time();
		let at = Math.max(performance.now(), this.#free_at);
		for (const segment of segments) {
			if (typeof segment === 'number') {
				at += segment;
				continue;
			}
			for (let i = 0; i < segment.length; i += chunk) {
				const part = segment.subarray(i, i + chunk);
				at += part.length * char_time;
				this.#queue.push({ at, bytes: part });
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
				const { bytes } = this.#queue.shift();
				if (this.#port.isOpen) this.#port.emit('data', bytes);
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

/**
 * Links fake serial ports at `a_path` and `b_path` through a simulated line (see above).
 * Returns `{ a, b, unplug(), close() }`: `a` and `b` are the two ports; unplug() drops the bytes
 * on the line and closes both ports, as when the device is gone; close() removes the bridge.
 */
export function create_serial_bridge(a_path, b_path, { to_a = {}, to_b = {} } = {}) {
	const a = new Bridge_Serial_Port(null);
	const b = new Bridge_Serial_Port(null);
	const char_time = () => serial_char_time(a.settings ?? b.settings);
	b.line = new Line(to_a, char_time, a);
	a.line = new Line(to_b, char_time, b);
	bridge_ends.set(a_path, a);
	bridge_ends.set(b_path, b);
	const clear = () => {
		a.line.clear();
		b.line.clear();
	};
	return {
		a,
		b,
		unplug() {
			clear();
			for (const port of [a, b]) {
				if (!port.isOpen) continue;
				port.isOpen = false;
				port.emit('close');
			}
		},
		close() {
			clear();
			bridge_ends.delete(a_path);
			bridge_ends.delete(b_path);
		},
	};
}

/**
 * Collects bytes from a stream until at least `length` bytes arrived or `ms` elapsed.
 * Resolves with everything collected (possibly empty).
 */
export function collect(stream, length, ms = 500) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		const finish = () => {
			clearTimeout(timer);
			stream.off('data', on_data);
			resolve(Buffer.concat(chunks));
		};
		const on_data = (chunk) => {
			chunks.push(chunk);
			size += chunk.length;
			if (size >= length) finish();
		};
		const timer = setTimeout(finish, ms);
		stream.on('data', on_data);
	});
}

/**
 * Makes a TCP-family Modbus_Server on HOST that listens on an ephemeral port, which the public
 * options do not accept: the server is built with a fixed target, then its `port` is set to 0.
 * `rtu_over_tcp: true` selects RTU-over-TCP.
 */
export function ephemeral_server(handler, { rtu_over_tcp = false, ...options } = {}) {
	const transport = rtu_over_tcp ? 'rtu_over_tcp' : 'tcp';
	const server = new Modbus_Server(handler, { [transport]: `${HOST}:502`, ...options });
	server.port = 0;
	return server;
}

/** Starts a Modbus_Server on an ephemeral TCP port (options as for `ephemeral_server`). */
export async function start_tcp_server(handler, options = {}) {
	const server = ephemeral_server(handler, options);
	server.on('error', () => { });
	server.on('socket_error', () => { });
	const started = once(server, 'start');
	server.start();
	await started;
	return { server, port: server.server.address().port };
}

/** Stops a Modbus_Server and waits for its `stop` event. */
export async function stop_tcp_server(server) {
	if (!server.server?.listening) return;
	const stopped = once(server, 'stop');
	server.stop();
	await stopped;
}

/** Opens a raw TCP connection to a port. */
export async function raw_connect(port) {
	const socket = new Socket();
	socket.on('error', () => { });
	socket.connect(port, HOST);
	await once(socket, 'connect');
	return socket;
}

/**
 * Starts a raw TCP server standing in for a Modbus slave.
 * `responder(frame, socket)` returns a reply Buffer, an array of them, or nothing.
 * Every received chunk is recorded in `frames` with its arrival time.
 */
export async function start_fake_server(responder = () => undefined) {
	const frames = [];
	const sockets = new Set();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.on('error', () => { });
		socket.on('close', () => sockets.delete(socket));
		socket.on('data', (frame) => {
			frames.push({ frame, time: performance.now() });
			const reply = responder(frame, socket);
			for (const buffer of [reply].flat()) {
				if (buffer) socket.write(buffer);
			}
		});
	});
	server.listen(0, HOST);
	await once(server, 'listening');
	return {
		port: server.address().port,
		frames,
		sockets,
		async close() {
			for (const socket of sockets) socket.destroy();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}

/** Returns a TCP port that nothing listens on. */
export async function closed_port() {
	const server = createServer();
	server.listen(0, HOST);
	await once(server, 'listening');
	const { port } = server.address();
	await new Promise((resolve) => server.close(resolve));
	return port;
}

/**
 * Creates a TCP client to HOST that does not auto-reconnect and swallows `error` events.
 * `rtu_over_tcp: true` selects RTU-over-TCP.
 */
export function create_client(port, { rtu_over_tcp = false, ...options } = {}) {
	const transport = rtu_over_tcp ? 'rtu_over_tcp' : 'tcp';
	const client = new Modbus_Client({
		[transport]: `${HOST}:${port}`, reconnect_time: 0, timeout: 500, delay: 0, ...options,
	});
	client.on('error', () => { });
	return client;
}

/** Creates a TCP client and waits until it is connected. */
export async function connect_client(port, options = {}) {
	const client = create_client(port, options);
	await client.connect();
	return client;
}

/** Tears a client down without triggering a reconnect. */
export function close_client(client) {
	return client.disconnect();
}

/**
 * Starts a UDP-family Modbus_Server on HOST that binds an ephemeral port (see `ephemeral_server`).
 * `rtu_over_udp: true` selects RTU-over-UDP.
 */
export async function start_udp_server(handler, { rtu_over_udp = false, ...options } = {}) {
	const transport = rtu_over_udp ? 'rtu_over_udp' : 'udp';
	const server = new Modbus_Server(handler, { [transport]: `${HOST}:502`, ...options });
	server.port = 0;
	server.on('error', () => { });
	await server.start();
	return { server, port: server.udp_socket.address().port };
}

/** Opens a raw UDP socket on HOST, bound to `port` (an ephemeral one by default). */
export async function raw_udp_socket(port = 0) {
	const socket = createSocket('udp4');
	socket.on('error', () => { });
	socket.bind(port, HOST);
	await once(socket, 'listening');
	return socket;
}

/** Returns a UDP port that nothing is bound to. */
export async function free_udp_port() {
	const socket = await raw_udp_socket();
	const { port } = socket.address();
	await new Promise((resolve) => socket.close(resolve));
	return port;
}

/**
 * Starts a raw UDP socket standing in for a Modbus device. `responder(frame, remote)` returns a
 * reply Buffer, an array of them (each sent as its own datagram), or nothing; replies go back
 * to the sender. Every received datagram is recorded in `frames` with its sender and arrival
 * time.
 */
export async function start_fake_udp_device(responder = () => undefined) {
	const frames = [];
	const socket = await raw_udp_socket();
	socket.on('message', (frame, remote) => {
		frames.push({ frame, remote, time: performance.now() });
		const reply = responder(frame, remote);
		for (const buffer of [reply].flat()) {
			if (buffer) socket.send(buffer, remote.port, remote.address);
		}
	});
	return {
		port: socket.address().port,
		frames,
		socket,
		close: () => new Promise((resolve) => socket.close(resolve)),
	};
}

/**
 * Creates a UDP client to HOST that does not auto-reconnect and swallows `error` events.
 * `rtu_over_udp: true` selects RTU-over-UDP.
 */
export function create_udp_client(port, { rtu_over_udp = false, ...options } = {}) {
	const transport = rtu_over_udp ? 'rtu_over_udp' : 'udp';
	const client = new Modbus_Client({
		[transport]: `${HOST}:${port}`, reconnect_time: 0, timeout: 500, delay: 0, ...options,
	});
	client.on('error', () => { });
	return client;
}

/** Receives the next datagram on a raw UDP socket, or null after `ms`. */
export function next_datagram(socket, ms = 500) {
	return new Promise((resolve) => {
		const on_message = (message) => {
			clearTimeout(timer);
			resolve(message);
		};
		const timer = setTimeout(() => {
			socket.off('message', on_message);
			resolve(null);
		}, ms);
		socket.once('message', on_message);
	});
}

/** Builds a TCP response to a TCP request frame from a PDU body (`unit_id + PDU`). */
export function reply_to(request, body) {
	return tcp_frame(request.readUInt16BE(0), body);
}

/**
 * Parses MODBUS_SERIAL_PORTS, `<serial>,<serial>` or `<serial>,<local-udp-port>[,<address>:<port>]`,
 * into `{ first, second }`. The first end is `{ serial: path }`; the second is `{ serial: path }`
 * or a UDP end `{ udp: port, remote, any_port }`: `remote` the converter as `{ host, port }`, null
 * until it is learned, and `any_port` true for a given remote, whose datagrams are taken whatever
 * their source port. Throws on an invalid value.
 */
export function parse_link(spec) {
	const [first, second, remote, ...rest] = spec.split(',');
	const invalid = (reason) => new Error(`Invalid MODBUS_SERIAL_PORTS "${spec}": ${reason}`);
	if (!first || !second || rest.length > 0) throw invalid('expected two or three ends');
	if (!/^\d+$/.test(second)) {
		if (remote !== undefined) throw invalid('two serial ports take no remote');
		return { first: { serial: first }, second: { serial: second } };
	}
	if (remote === undefined) return { first: { serial: first }, second: { udp: Number(second), remote: null, any_port: false } };
	const [, host, port] = /^(.*):(\d+)$/.exec(remote) ?? [];
	if (isIP(host) !== 4) throw invalid(`the remote "${remote}" is not "<IPv4 address>:<port>"`);
	return { first: { serial: first }, second: { udp: Number(second), remote: { host, port: Number(port) }, any_port: true } };
}
