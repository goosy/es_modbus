// The serial paths of Modbus_Client and Modbus_Server over a simulated serial line
// (test/serial-bridge.js), with an RTU-over-TCP peer or a raw socket on the other end.
import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { set_serial_port_factory } from '../src/serial.js';
import {
	HOST, hex, rtu_frame, collect, create_memory_vector, start_tcp_server, stop_tcp_server, raw_connect,
} from './helpers.js';
import { create_serial_bridge, serial_port_factory } from './serial-bridge.js';

const as_hex = (buffer) => buffer.toString('hex');

/** Splits bytes at `at` with a pause of `ms` between the two parts. The line silence is at least 50 ms. */
const pause_at = (bytes, at, ms) => [bytes.subarray(0, at), ms, bytes.subarray(at)];

before(() => set_serial_port_factory(serial_port_factory));
after(() => set_serial_port_factory(null));

describe('Modbus_Client on a serial line, RTU-over-TCP server on the other end', () => {
	let memory;
	let server;
	let server_port;
	let bridge;
	let client;
	beforeEach(async () => {
		memory = create_memory_vector();
		({ server, port: server_port } = await start_tcp_server(memory.vector, { rtu: true, unit_id: [1, 2] }));
	});
	afterEach(async () => {
		await client?.disconnect();
		await bridge?.close();
		await stop_tcp_server(server);
		client = bridge = undefined;
	});

	async function setup(line, options = {}) {
		bridge = await create_serial_bridge({ serial: 'COM_A' }, { connect: server_port }, line);
		client = new Modbus_Client(null, {
			port: 'COM_A', baud_rate: 19200, reconnect_time: 0, timeout: 300, ...options,
		});
		client.on('error', () => { });
		await client.connect();
	}

	test('reads and writes every table', async () => {
		await setup();
		memory.unit(1).holding.set([1, 2], 0);
		memory.unit(1).input[0] = 3;
		assert.deepEqual(await client.read('40001,2'), hex('00010002'));
		assert.deepEqual(await client.read('30001'), hex('0003'));
		assert.equal(await client.write('40003', 7), true);
		assert.equal(await client.write('40004', hex('00080009')), true);
		assert.equal(await client.write('00001', true), true);
		assert.equal(await client.write('00002,3', hex('05')), true);
		assert.deepEqual([...memory.unit(1).holding.subarray(2, 5)], [7, 8, 9]);
		assert.deepEqual(await client.read('00001,4'), hex('0b'));
		assert.deepEqual(await client.read('10001,4'), hex('0b'));
	});

	test('concurrent requests are serialized', async () => {
		await setup();
		memory.unit(1).holding.set([10, 20, 30], 100);
		const values = await Promise.all([client.read('40101'), client.read('40102'), client.read('40103')]);
		assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [10, 20, 30]);
	});

	test('a response arriving byte by byte at the baud rate is reassembled', async () => {
		await setup({ to_a: { chunk: 1 } }, { baud_rate: 9600 });
		memory.unit(1).holding.set([0x1234, 0x5678], 0);
		assert.deepEqual(await client.read('40001,2'), hex('12345678'));
	});

	test('a response with a bad CRC times out, and the next request is answered', async () => {
		await setup({
			to_a: {
				tamper: (bytes, i) => {
					if (i === 0) bytes[bytes.length - 1] ^= 0xff;
					return bytes;
				},
			},
		});
		await assert.rejects(client.read('40001'), /timeout/);
		assert.deepEqual(await client.read('40001'), hex('0000'));
	});

	test('an unanswered request times out, and the next request is answered', async () => {
		await setup({ to_b: { tamper: (bytes, i) => (i === 0 ? null : bytes) } });
		await assert.rejects(client.read('40001'), /timeout/);
		assert.deepEqual(await client.read('40001'), hex('0000'));
	});

	test('a late response to a timed-out request does not settle the next one', async () => {
		await setup({ to_a: { tamper: (bytes, i) => (i === 0 ? [250, bytes] : bytes) } }, { timeout: 150 });
		memory.unit(1).holding[0] = 9;
		memory.unit(2).holding[0] = 5;
		const first = client.read('40001', 1);
		const second = client.read('40001', 2);
		await assert.rejects(first, /timeout/);
		assert.deepEqual(await second, hex('0005'));
	});

	test('a response broken by a pause longer than the line silence is discarded', async () => {
		await setup({ to_a: { tamper: (bytes, i) => (i === 0 ? pause_at(bytes, 3, 120) : bytes) } });
		await assert.rejects(client.read('40001'), /timeout/);
		assert.deepEqual(await client.read('40001'), hex('0000'));
	});

	test('noise before a response is skipped', async () => {
		await setup({ to_a: { tamper: (bytes) => [hex('ff00'), bytes] } });
		memory.unit(1).holding[0] = 7;
		assert.deepEqual(await client.read('40001'), hex('0007'));
	});

	test('unplugging the device rejects the outstanding request', async () => {
		await setup({ to_b: { tamper: () => null } }, { timeout: 2000 });
		const sent = once(client, 'send');
		const pending = client.read('40001');
		await sent;
		bridge.unplug();
		await assert.rejects(pending, { message: 'connection lost' });
		assert.equal(client.is_idle, true);
	});
});

describe('Modbus_Server on a serial line, a peer over TCP on the other end', () => {
	let memory;
	let server;
	let bridge;
	let peer;
	afterEach(async () => {
		peer?.destroy();
		if (server?.serial_port?.isOpen) {
			const stopped = once(server, 'stop');
			server.stop();
			await stopped;
		}
		await bridge?.close();
		peer = server = bridge = undefined;
	});

	async function setup(line, options = {}) {
		memory = create_memory_vector();
		bridge = await create_serial_bridge({ serial: 'COM_B' }, { listen: true }, line);
		server = new Modbus_Server(memory.vector, { port: 'COM_B', baud_rate: 19200, unit_id: [0, 1, 2], ...options });
		server.on('error', () => { });
		const started = once(server, 'start');
		server.start();
		await started;
	}

	async function exchange(request, length, ms = 300) {
		peer ??= await raw_connect(bridge.port);
		const response = collect(peer, length, ms);
		peer.write(typeof request === 'string' ? rtu_frame(request) : request);
		return response;
	}

	test('answers a request', async () => {
		await setup();
		memory.unit(1).holding.set([0xae41, 0x5652], 0x6b);
		const response = await exchange('0103006b0002', 9);
		assert.equal(as_hex(response), as_hex(rtu_frame('010304ae415652')));
	});

	test('a request arriving byte by byte at the baud rate is answered', async () => {
		await setup({ to_a: { chunk: 1 } }, { baud_rate: 9600 });
		const response = await exchange('010600010003', 8);
		assert.equal(as_hex(response), as_hex(rtu_frame('010600010003')));
		assert.equal(memory.unit(1).holding[1], 3);
	});

	test('a request broken by a pause longer than the line silence is dropped', async () => {
		await setup({ to_a: { tamper: (bytes, i) => (i === 0 ? pause_at(bytes, 3, 120) : bytes) } });
		assert.equal((await exchange('010600010003', 1, 200)).length, 0);
		assert.equal(memory.unit(1).holding[1], 0);
		assert.equal((await exchange('010300000001', 7)).length, 7);
	});

	test('noise before a request is skipped', async () => {
		await setup({ to_a: { tamper: (bytes) => [hex('ff00'), bytes] } });
		const response = await exchange('010300000001', 7);
		assert.equal(as_hex(response), as_hex(rtu_frame('0103020000')));
	});

	test('two requests in one chunk are both answered', async () => {
		await setup();
		const response = await exchange(Buffer.concat([rtu_frame('010300000001'), rtu_frame('020300000001')]), 14);
		assert.equal(as_hex(response), as_hex(Buffer.concat([rtu_frame('0103020000'), rtu_frame('0203020000')])));
	});

	test('a broadcast write is executed and not answered', async () => {
		await setup();
		assert.equal((await exchange('000600050007', 1, 200)).length, 0);
		assert.equal(memory.unit(0).holding[5], 7);
	});

	test('an RTU-over-TCP client reads and writes through the line', async () => {
		await setup({ to_b: { chunk: 2 } });
		const client = new Modbus_Client(HOST, { port: bridge.port, rtu: true, reconnect_time: 0, timeout: 300, delay: 0 });
		client.on('error', () => { });
		try {
			await client.connect();
			assert.equal(await client.write('40001,2', hex('00010002')), true);
			assert.deepEqual(await client.read('40001,2', 1), hex('00010002'));
			assert.deepEqual(await client.read('40001', 2), hex('0000'));
		} finally {
			await client.disconnect();
		}
	});
});
