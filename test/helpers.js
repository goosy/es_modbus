// Shared test fixtures: in-memory vector, frame builders, fake peers.
import { createServer, Socket } from 'node:net';
import { once } from 'node:events';
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
 * An in-memory vector backed by one 65536-point table per kind and unit.
 * Every call is recorded in `calls` as `[name, ...args]`.
 */
export function create_memory_vector() {
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
	const vector = {
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
		set_register(addr, value, unit_id) {
			calls.push(['set_register', addr, value, unit_id]);
			unit(unit_id).holding[addr] = value;
		},
	};
	return { vector, unit, calls };
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

/** Starts a Modbus_Server on an ephemeral TCP port. */
export async function start_tcp_server(vector, options = {}) {
	const server = new Modbus_Server(vector, { host: HOST, port: 0, ...options });
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

/** Creates a TCP client that does not auto-reconnect and swallows `error` events. */
export function create_client(port, options = {}) {
	const client = new Modbus_Client(HOST, {
		port, reconnect_time: 0, timeout: 500, delay: 0, ...options,
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
	client.reconnect_time = 0;
	client.stream.destroy();
}

/** Builds a TCP response to a TCP request frame from a PDU body (`unit_id + PDU`). */
export function reply_to(request, body) {
	return tcp_frame(request.readUInt16BE(0), body);
}
