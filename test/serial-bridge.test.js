// The timing of the serial paths of Modbus_Client and Modbus_Server over a simulated serial line
// (create_serial_bridge in test/helpers.js): bytes paced at the baud rate, pauses longer than the
// line silence, late responses and a device that is gone. Each class's other serial behavior is
// covered by its own tests.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { set_serial_port_factory } from '../src/serial.js';
import {
	hex, rtu_frame, collect, create_memory_handler, create_serial_bridge, bridge_port_factory,
} from './helpers.js';

const as_hex = (buffer) => buffer.toString('hex');

/** Splits bytes at `at` with a pause of `ms` between the two parts. The line silence is at least 50 ms. */
const pause_at = (bytes, at, ms) => [bytes.subarray(0, at), ms, bytes.subarray(at)];

/** Starts a Modbus_Server on a bridge end. */
async function start_server(handler, path, options) {
	const server = new Modbus_Server(handler, { serial: path, ...options });
	server.on('error', () => { });
	const started = once(server, 'start');
	server.start();
	await started;
	return server;
}

/** Stops a Modbus_Server whose port is still open. */
async function stop_server(server) {
	if (!server?.serial_port?.isOpen) return;
	const stopped = once(server, 'stop');
	server.stop();
	await stopped;
}

before(() => set_serial_port_factory(bridge_port_factory));
after(() => set_serial_port_factory(null));

describe('Modbus_Client on a serial line, Modbus_Server on the other end', () => {
	let memory;
	let server;
	let bridge;
	let client;
	afterEach(async () => {
		await client?.disconnect();
		await stop_server(server);
		bridge?.close();
		client = server = bridge = undefined;
	});

	async function setup(line, { baud_rate = 19200, ...options } = {}) {
		bridge = create_serial_bridge('COM_A', 'COM_B', line);
		memory = create_memory_handler();
		server = await start_server(memory.handler, 'COM_B', { baud_rate, unit_id: [1, 2] });
		client = new Modbus_Client({ serial: 'COM_A', baud_rate, reconnect_time: 0, timeout: 300, ...options });
		client.on('error', () => { });
		await client.connect();
	}

	test('a response arriving byte by byte at the baud rate is reassembled', async () => {
		await setup({ to_a: { chunk: 1 } }, { baud_rate: 9600 });
		memory.unit(1).holding.set([0x1234, 0x5678], 0);
		assert.deepEqual(await client.read('40001,2'), hex('12345678'));
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

describe('Modbus_Server on a serial line, a raw peer on the other end', () => {
	let memory;
	let server;
	let bridge;
	afterEach(async () => {
		await stop_server(server);
		bridge?.close();
		server = bridge = undefined;
	});

	async function setup(line, options = {}) {
		bridge = create_serial_bridge('COM_A', 'COM_B', line);
		memory = create_memory_handler();
		server = await start_server(memory.handler, 'COM_A', { baud_rate: 19200, ...options });
		await new Promise((resolve) => bridge.b.open(resolve));
	}

	function exchange(request, length, ms = 300) {
		const response = collect(bridge.b, length, ms);
		bridge.b.write(rtu_frame(request));
		return response;
	}

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
});
