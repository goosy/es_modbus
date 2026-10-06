// End-to-end: Modbus_Client against Modbus_Server over Modbus TCP on loopback.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	hex, create_memory_vector,
	start_tcp_server, stop_tcp_server, connect_client, close_client,
} from './helpers.js';

describe('TCP client <-> server', () => {
	let memory;
	let server;
	let client;
	before(async () => {
		memory = create_memory_vector();
		let port;
		({ server, port } = await start_tcp_server(memory.vector, { unit_id: [1, 2, 18] }));
		client = await connect_client(port, { timeout: 2000 });
	});
	after(async () => {
		close_client(client);
		await stop_tcp_server(server);
	});
	beforeEach(() => {
		memory.calls.length = 0;
	});

	test('FC 3 reads holding registers; Modicon 40001 is PDU address 0', async () => {
		memory.unit(1).holding.set([0x1234, 0x5678, 0x9abc], 0);
		assert.deepEqual(await client.read('40001,3'), hex('123456789abc'));
		assert.deepEqual(memory.calls.map((c) => c[1]), [0, 1, 2]);
	});

	test('FC 4 reads input registers', async () => {
		memory.unit(1).input[9998] = 0xbeef;
		assert.deepEqual(await client.read('39999'), hex('beef'));
		assert.deepEqual(memory.calls, [['get_input_register', 9998, 1]]);
	});

	test('FC 1 reads coils', async () => {
		memory.unit(1).coils.set([1, 0, 1, 1, 0, 0, 1, 1, 1, 0], 100);
		assert.deepEqual(await client.read('00101,10'), hex('cd01'));
	});

	test('FC 2 reads discrete inputs', async () => {
		memory.unit(2).coils[0] = 1;
		assert.deepEqual(await client.read('10001,3', 2), hex('01'));
		assert.deepEqual(memory.calls.map((c) => c[0]), ['get_coil', 'get_coil', 'get_coil']);
	});

	test('FC 5 writes a single coil', async () => {
		assert.equal(await client.write('00008', true), true);
		assert.equal(memory.unit(1).coils[7], 1);
		assert.equal(await client.write('00008', false), true);
		assert.equal(memory.unit(1).coils[7], 0);
	});

	test('FC 6 writes a single register', async () => {
		assert.equal(await client.write('40010', 65535), true);
		assert.equal(memory.unit(1).holding[9], 65535);
		assert.equal(await client.write('40010', hex('0102')), true);
		assert.equal(memory.unit(1).holding[9], 0x0102);
	});

	test('FC 15 writes multiple coils', async () => {
		assert.equal(await client.write('00201,10', hex('cd01')), true);
		assert.deepEqual([...memory.unit(1).coils.subarray(200, 210)], [1, 0, 1, 1, 0, 0, 1, 1, 1, 0]);
	});

	test('FC 16 writes multiple registers', async () => {
		assert.equal(await client.write('40101', hex('000a0102ffff')), true);
		assert.deepEqual([...memory.unit(1).holding.subarray(100, 103)], [0x000a, 0x0102, 0xffff]);
	});

	test('a written value reads back', async () => {
		await client.write('40500,2', hex('cafebabe'), 18);
		assert.deepEqual(await client.read('40500,2', 18), hex('cafebabe'));
	});

	test('maximum quantities', async () => {
		const words = Buffer.alloc(123 * 2);
		for (let i = 0; i < 123; i++) words.writeUInt16BE(i * 3, i * 2);
		assert.equal(await client.write('41001,123', words), true);
		assert.deepEqual((await client.read('41001,125')).subarray(0, 246), words);
		assert.equal((await client.read('41001,125')).length, 250);

		const bits = Buffer.alloc(1968 / 8, 0x5a);
		assert.equal(await client.write('01001,1968', bits), true);
		const read = await client.read('01001,2000');
		assert.equal(read.length, 250);
		assert.deepEqual(read.subarray(0, 246), bits);
	});

	test('units are routed by unit ID', async () => {
		memory.unit(1).holding[0] = 1;
		memory.unit(2).holding[0] = 2;
		memory.unit(18).holding[0] = 18;
		const values = await Promise.all([1, 2, 18].map((unit_id) => client.read('40001', unit_id)));
		assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [1, 2, 18]);
	});

	test('a unit ID the server does not accept rejects with exception 0x0B', async () => {
		await assert.rejects(client.read('40001', 3), (reason) => String(reason) === 'response error: 11');
	});

	test('many concurrent requests resolve with the right data', async () => {
		const holding = memory.unit(1).holding;
		for (let i = 0; i < 200; i++) holding[2000 + i] = i;
		// Frames are paced by timers (about 15 ms per frame on Windows even with delay 0),
		// so the timeout must cover the whole queue.
		client.timeout = 10000;
		const reads = [];
		for (let i = 0; i < 200; i++) reads.push(client.read(`4${2001 + i}`));
		try {
			const values = await Promise.all(reads);
			assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [...Array(200).keys()]);
		} finally {
			client.timeout = 2000;
		}
	});

	test('a wire trace shows matching send and receive frames', async () => {
		const client_sent = [];
		const server_received = [];
		const server_sent = [];
		const client_received = [];
		const on_client_send = (b) => client_sent.push(b.toString('hex'));
		const on_client_receive = (b) => client_received.push(b.toString('hex'));
		const on_server_send = (b) => server_sent.push(b.toString('hex'));
		const on_server_receive = (b) => server_received.push(b.toString('hex'));
		client.on('send', on_client_send);
		client.on('receive', on_client_receive);
		server.on('send', on_server_send);
		server.on('receive', on_server_receive);
		await client.read('40001');
		client.off('send', on_client_send);
		client.off('receive', on_client_receive);
		server.off('send', on_server_send);
		server.off('receive', on_server_receive);
		assert.deepEqual(server_received, client_sent);
		assert.deepEqual(client_received, server_sent);
	});
});

describe('TCP client <-> server lifecycle', () => {
	test('the client reconnects after the server restarts', async () => {
		const memory = create_memory_vector();
		memory.unit(1).holding[0] = 77;
		const { server, port } = await start_tcp_server(memory.vector);
		const client = await connect_client(port, { reconnect_time: 100, timeout: 2000 });
		try {
			const disconnected = new Promise((resolve) => client.once('disconnect', resolve));
			await stop_tcp_server(server);
			await disconnected;
			server.port = port; // listen again on the same port, not a new ephemeral one
			const reconnected = new Promise((resolve) => client.once('connect', resolve));
			const started = new Promise((resolve) => server.once('start', resolve));
			server.start();
			await started;
			await reconnected;
			assert.deepEqual(await client.read('40001'), hex('004d'));
		} finally {
			close_client(client);
			await stop_tcp_server(server);
		}
	});
});
