// End-to-end Modbus RTU over a pair of null-modem-linked serial ports (e.g. com0com).
//
// The pair is taken from MODBUS_SERIAL_PORTS ("<server port>,<peer port>", default
// "COM11,COM12"). The suite is skipped when the ports cannot be opened, or when
// MODBUS_SERIAL_PORTS is "none".
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SerialPort } from 'serialport';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { sleep, hex, rtu_frame, collect, create_memory_vector } from './helpers.js';

const BAUD_RATE = 19200;
const [SERVER_PATH, PEER_PATH] = (process.env.MODBUS_SERIAL_PORTS ?? 'COM11,COM12').split(',');

const open_port = (port) => new Promise((resolve, reject) => {
	port.open((error) => (error ? reject(error) : resolve()));
});
const close_port = (port) => new Promise((resolve) => {
	if (!port?.isOpen) return resolve();
	port.close(() => resolve());
});
const new_port = (path) => new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false });

/**
 * Returns false when the pair is usable, or the reason to skip the suite.
 * Usable means: both ports open, and a byte written on one side reaches a read that is
 * already pending on the other side (the way a server waits for requests).
 */
async function probe_ports() {
	if (SERVER_PATH === 'none' || !PEER_PATH) return 'MODBUS_SERIAL_PORTS is not set to a port pair';
	const ports = [new_port(SERVER_PATH), new_port(PEER_PATH)];
	try {
		for (const port of ports) await open_port(port);
		const received = collect(ports[1], 1, 500);
		await sleep(100); // let the read on the peer become pending
		ports[0].write(Buffer.from([0x55]));
		if ((await received).length === 0) {
			return `serial pair ${SERVER_PATH}/${PEER_PATH} does not deliver data to a pending read (see doc/spec-test.md, "Serial test environment")`;
		}
		return false;
	} catch (error) {
		return `serial pair ${SERVER_PATH}/${PEER_PATH} unavailable: ${error.message}`;
	} finally {
		for (const port of ports) await close_port(port);
	}
}

const skip = await probe_ports();

/** Writes a request on the peer port and collects up to `length` response bytes. */
async function exchange(peer, request, length, ms = 500) {
	const response = collect(peer, length, ms);
	peer.write(typeof request === 'string' ? rtu_frame(request) : request);
	return response;
}

const as_hex = (buffer) => buffer.toString('hex');

describe(`Modbus RTU server on ${SERVER_PATH}, raw peer on ${PEER_PATH}`, { skip }, () => {
	let memory;
	let server;
	let peer;
	before(async () => {
		memory = create_memory_vector();
		server = new Modbus_Server(memory.vector, { port: SERVER_PATH, baud_rate: BAUD_RATE, unit_id: [1, 2, 0x11] });
		server.on('error', () => { });
		const started = once(server, 'start');
		server.start();
		await started;
		peer = new_port(PEER_PATH);
		await open_port(peer);
	});
	after(async () => {
		await close_port(peer);
		if (server.serial_port.isOpen) {
			const stopped = once(server, 'stop');
			server.stop();
			await stopped;
		}
	});
	beforeEach(async () => {
		// let any stray bytes of a previous test drain
		await sleep(20);
		memory.calls.length = 0;
	});

	test('the serial server is started', () => {
		assert.equal(server.is_tcp, false);
		assert.equal(server.serial_port.isOpen, true);
	});

	test('FC 3 reads holding registers', async () => {
		memory.unit(0x11).holding.set([0xae41, 0x5652, 0x4340], 0x6b);
		const response = await exchange(peer, '1103006b0003', 11);
		assert.equal(as_hex(response), as_hex(rtu_frame('110306ae4156524340')));
		assert.deepEqual(memory.calls.map((c) => c[1]), [0x6b, 0x6c, 0x6d]);
	});

	test('FC 4 reads input registers', async () => {
		memory.unit(1).input[8] = 0x000a;
		const response = await exchange(peer, '010400080001', 7);
		assert.equal(as_hex(response), as_hex(rtu_frame('010402000a')));
	});

	test('FC 1 reads coils', async () => {
		memory.unit(1).coils.set([1, 0, 1, 1, 0, 0, 1, 1, 1, 0], 0x13);
		const response = await exchange(peer, '01010013000a', 7);
		assert.equal(as_hex(response), as_hex(rtu_frame('010102cd01')));
	});

	test('FC 2 reads discrete inputs', async () => {
		memory.unit(2).coils[0xc4] = 1;
		const response = await exchange(peer, '020200c40016', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('020203010000')));
	});

	test('FC 5 writes a single coil', async () => {
		const response = await exchange(peer, '010500acff00', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('010500acff00')));
		assert.equal(memory.unit(1).coils[0xac], 1);
	});

	test('FC 6 writes a single register', async () => {
		const response = await exchange(peer, '010600010003', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('010600010003')));
		assert.equal(memory.unit(1).holding[1], 3);
	});

	test('FC 15 writes multiple coils', async () => {
		const response = await exchange(peer, '010f0013000a02cd01', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('010f0013000a')));
		assert.deepEqual([...memory.unit(1).coils.subarray(0x13, 0x1d)], [1, 0, 1, 1, 0, 0, 1, 1, 1, 0]);
	});

	test('FC 16 writes multiple registers', async () => {
		const response = await exchange(peer, '01100001000204000a0102', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('011000010002')));
		assert.deepEqual([...memory.unit(1).holding.subarray(1, 3)], [0x000a, 0x0102]);
	});

	test('a written value reads back', async () => {
		await exchange(peer, '0210 0100 0002 04 cafe babe', 8);
		const response = await exchange(peer, '020301000002', 9);
		assert.equal(as_hex(response), as_hex(rtu_frame('020304cafebabe')));
	});

	test('a unit ID that is not accepted is not answered', async () => {
		const response = await exchange(peer, '070300000001', 1, 200);
		assert.equal(response.length, 0);
		assert.deepEqual(memory.calls, []);
	});

	test('receive and send events carry whole frames', async () => {
		const received = once(server, 'receive');
		const sent = once(server, 'send');
		await exchange(peer, '010300000001', 7);
		assert.equal(as_hex((await received)[0]), as_hex(rtu_frame('010300000001')));
		assert.equal(as_hex((await sent)[0]), as_hex(rtu_frame('0103020000')));
	});

	test('back-to-back requests', async () => {
		for (let i = 0; i < 20; i++) {
			const response = await exchange(peer, Buffer.from([1, 6, 0, 0x40, 0, i]).toString('hex'), 8);
			assert.equal(response.length, 8);
		}
		assert.equal(memory.unit(1).holding[0x40], 19);
	});

	test('a frame with a bad CRC is dropped', async () => {
		const frame = rtu_frame('010300000001');
		frame[frame.length - 1] ^= 0xff;
		const response = await exchange(peer, frame, 1, 200);
		assert.equal(response.length, 0);
	});

	test('a frame split across reads is reassembled', async () => {
		const frame = rtu_frame('010300000001');
		const response = collect(peer, 7, 500);
		peer.write(frame.subarray(0, 3));
		await new Promise((resolve) => peer.drain(resolve));
		await sleep(1);
		peer.write(frame.subarray(3));
		assert.equal(as_hex(await response), as_hex(rtu_frame('0103020000')));
	});

	test('two frames in one read are both answered', async () => {
		memory.unit(1).holding.set([0, 0], 0);
		const response = await exchange(peer, Buffer.concat([
			rtu_frame('010300000001'), rtu_frame('010300010001'),
		]), 14);
		assert.equal(as_hex(response), as_hex(Buffer.concat([
			rtu_frame('0103020000'), rtu_frame('0103020000'),
		])));
	});

	test('stop() closes the port and emits stop; start() re-opens it', async () => {
		const stopped = once(server, 'stop');
		server.stop();
		await stopped;
		assert.equal(server.serial_port.isOpen, false);
		const started = once(server, 'start');
		server.start();
		await started;
		assert.equal(server.serial_port.isOpen, true);
		const response = await exchange(peer, '010300000001', 7);
		assert.equal(response.length, 7);
	});
});

describe(`Modbus RTU client on ${PEER_PATH} <-> server on ${SERVER_PATH}`, { skip }, () => {
	let memory;
	let server;
	before(async () => {
		memory = create_memory_vector();
		server = new Modbus_Server(memory.vector, { port: SERVER_PATH, baud_rate: BAUD_RATE });
		server.on('error', () => { });
		const started = once(server, 'start');
		server.start();
		await started;
	});
	after(async () => {
		const stopped = once(server, 'stop');
		server.stop();
		await stopped;
	});

	test('reads and writes every table', async () => {
		const client = new Modbus_Client(null, { port: PEER_PATH, baud_rate: BAUD_RATE, timeout: 1000 });
		client.on('error', () => { });
		try {
			await client.connect();
			memory.unit(1).holding.set([1, 2], 0);
			memory.unit(1).input[0] = 3;
			assert.deepEqual(await client.read('40001,2'), hex('00010002'));
			assert.deepEqual(await client.read('30001'), hex('0003'));
			await client.write('40003', 7);
			await client.write('40004', hex('00080009'));
			await client.write('00001', true);
			await client.write('00002,3', hex('05'));
			assert.deepEqual([...memory.unit(1).holding.subarray(2, 5)], [7, 8, 9]);
			assert.deepEqual([...memory.unit(1).coils.subarray(0, 4)], [1, 1, 0, 1]);
			assert.deepEqual(await client.read('00001,4'), hex('0b'));
			assert.deepEqual(await client.read('10001,4'), hex('0b'));
		} finally {
			await close_port(client.stream);
		}
	});

	test('concurrent requests are serialized', async () => {
		const client = new Modbus_Client(null, { port: PEER_PATH, baud_rate: BAUD_RATE, timeout: 1000 });
		client.on('error', () => { });
		try {
			await client.connect();
			memory.unit(1).holding.set([10, 20, 30], 100);
			const values = await Promise.all([
				client.read('40101'), client.read('40102'), client.read('40103'),
			]);
			assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [10, 20, 30]);
		} finally {
			await close_port(client.stream);
		}
	});
});
