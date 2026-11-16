// The UDP family: Modbus UDP and RTU-over-UDP, client and server, on loopback.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import {
	HOST, hex, sleep, rtu_frame, tcp_frame, reply_to, create_memory_handler,
	start_udp_server, raw_udp_socket, free_udp_port, start_fake_udp_device, create_udp_client,
	next_datagram,
} from './helpers.js';

describe('Modbus UDP client <-> server', () => {
	let memory;
	let server;
	let client;
	before(async () => {
		memory = create_memory_handler();
		let port;
		({ server, port } = await start_udp_server(memory.handler, { unit_id: [1, 2] }));
		client = create_udp_client(port, { timeout: 2000 });
		await client.connect();
	});
	after(async () => {
		await client.disconnect();
		await server.stop();
	});
	beforeEach(() => {
		memory.calls.length = 0;
	});

	test('reads and writes registers and coils', async () => {
		assert.equal(await client.write('40001,2', hex('cafebabe')), true);
		assert.deepEqual(await client.read('40001,2'), hex('cafebabe'));
		assert.equal(await client.write('00003', true, 2), true);
		assert.deepEqual(await client.read('00001,3', 2), hex('04'));
	});

	test('a unit ID the server does not accept rejects with exception 0x0B', async () => {
		await assert.rejects(client.read('40001', 3), { message: 'response error: 11' });
	});

	test('concurrent requests are matched by transaction ID', async () => {
		const holding = memory.unit(1).holding;
		for (let i = 0; i < 20; i++) holding[100 + i] = i;
		const values = await Promise.all([...Array(20).keys()].map((i) => client.read(`400${101 + i}`)));
		assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [...Array(20).keys()]);
	});

	test('a wire trace shows matching send and receive frames', async () => {
		const trace = { client_sent: [], server_received: [], server_sent: [], client_received: [] };
		const record = (list) => (buffer) => trace[list].push(buffer.toString('hex'));
		const listeners = [
			[client, 'send', record('client_sent')],
			[client, 'receive', record('client_received')],
			[server, 'send', record('server_sent')],
			[server, 'receive', record('server_received')],
		];
		for (const [emitter, event, listener] of listeners) emitter.on(event, listener);
		await client.read('40001');
		for (const [emitter, event, listener] of listeners) emitter.off(event, listener);
		assert.equal(trace.client_sent.length, 1);
		assert.deepEqual(trace.server_received, trace.client_sent);
		assert.deepEqual(trace.client_received, trace.server_sent);
	});
});

describe('RTU-over-UDP client <-> server', () => {
	let memory;
	let server;
	let client;
	before(async () => {
		memory = create_memory_handler();
		let port;
		({ server, port } = await start_udp_server(memory.handler, { rtu_over_udp: true, unit_id: [0, 1] }));
		client = create_udp_client(port, { rtu_over_udp: true, timeout: 300 });
		await client.connect();
	});
	after(async () => {
		await client.disconnect();
		await server.stop();
	});

	test('reads and writes registers', async () => {
		assert.equal(await client.write('40011,2', hex('01020304')), true);
		assert.deepEqual(await client.read('40011,2'), hex('01020304'));
	});

	test('a broadcast write is executed and never answered', async () => {
		const sent = [];
		const on_send = (frame) => sent.push(frame);
		server.on('send', on_send);
		try {
			assert.equal(await client.write('40021', 0x1234, 0), true);
			await sleep(50);
			assert.equal(memory.unit(0).holding[20], 0x1234);
			assert.deepEqual(sent, []);
		} finally {
			server.off('send', on_send);
		}
	});

	test('a unit ID the server does not accept is not answered', async () => {
		await assert.rejects(client.read('40001', 5), /timeout/);
	});
});

describe('UDP client', () => {
	test('connect binds the socket; disconnect closes it; connect binds again', async () => {
		const device = await start_fake_udp_device();
		const client = create_udp_client(device.port);
		try {
			const connected = once(client, 'connect');
			await client.connect();
			await connected;
			assert.equal(client.is_connected, true);
			const disconnected = once(client, 'disconnect');
			await client.disconnect();
			await disconnected;
			assert.equal(client.is_disconnected, true);
			await client.connect();
			assert.equal(client.is_connected, true);
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('the constructor binds at once when reconnect_time > 0', async () => {
		const device = await start_fake_udp_device();
		const client = create_udp_client(device.port, { reconnect_time: 100 });
		try {
			await once(client, 'connect');
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('a request is sent to the target, and the reply resolves it', async () => {
		const device = await start_fake_udp_device((frame) => reply_to(frame, '01 03 02 1234'));
		const client = create_udp_client(device.port);
		try {
			assert.deepEqual(await client.read('40001'), hex('1234'));
			assert.deepEqual(device.frames[0].frame.subarray(6), hex('01 03 0000 0001'));
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('a datagram from another source port is discarded unless any_source_port is set', async () => {
		const other = await raw_udp_socket();
		const reply_from_other = (frame, remote) => {
			other.send(reply_to(frame, '01 03 02 5678'), remote.port, remote.address);
		};
		const device = await start_fake_udp_device(reply_from_other);
		const strict = create_udp_client(device.port, { timeout: 200 });
		const loose = create_udp_client(device.port, { any_source_port: true });
		try {
			const received = [];
			strict.on('receive', (frame) => received.push(frame));
			await assert.rejects(strict.read('40001'), /timeout/);
			assert.deepEqual(received, []);
			assert.deepEqual(await loose.read('40001'), hex('5678'));
		} finally {
			await strict.disconnect();
			await loose.disconnect();
			await device.close();
			await new Promise((resolve) => other.close(resolve));
		}
	});

	test('local binds the given address and port', async () => {
		const local_port = await free_udp_port();
		const device = await start_fake_udp_device((frame) => reply_to(frame, '01 06 0000 0001'));
		const client = create_udp_client(device.port, { local: `${HOST}:${local_port}` });
		try {
			assert.equal(await client.write('40001', 1), true);
			assert.equal(device.frames[0].remote.port, local_port);
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('a local port in use fails the connect, emits error and rejects the requests', async () => {
		const occupied = await raw_udp_socket();
		const device = await start_fake_udp_device();
		const client = create_udp_client(device.port, { local: `${HOST}:${occupied.address().port}` });
		const errors = [];
		client.on('error', (error) => errors.push(error));
		try {
			await assert.rejects(client.connect(), { code: 'EADDRINUSE' });
			assert.equal(errors[0].code, 'EADDRINUSE');
			assert.equal(client.is_idle, true);
			await assert.rejects(client.read('40001'), { message: 'connection lost' });
		} finally {
			await client.disconnect();
			await device.close();
			await new Promise((resolve) => occupied.close(resolve));
		}
	});

	test('a failed bind is retried after the back-off', async () => {
		const occupied = await raw_udp_socket();
		const local = `${HOST}:${occupied.address().port}`;
		const device = await start_fake_udp_device();
		// Not `once()`, which rejects on the `error` the failed bind emits first
		const client = create_udp_client(device.port, { local, reconnect_time: 50 });
		const next = (event) => new Promise((resolve) => client.once(event, resolve));
		// The bind starts after the host lookup, so the listener is in time
		const disconnected = next('disconnect');
		let occupied_open = true;
		try {
			await disconnected;
			assert.equal(client.is_backing_off, true);
			const connected = next('connect');
			await new Promise((resolve) => occupied.close(resolve));
			occupied_open = false;
			await connected;
		} finally {
			await client.disconnect();
			await device.close();
			if (occupied_open) occupied.close();
		}
	});

	test('a socket error after the bind leaves the socket open', async () => {
		const device = await start_fake_udp_device((frame) => reply_to(frame, '01 03 02 0001'));
		const client = create_udp_client(device.port);
		try {
			await client.connect();
			let disconnected = false;
			client.on('disconnect', () => {
				disconnected = true;
			});
			client.stream.emit('error', new Error('unreachable'));
			await sleep(20);
			assert.equal(disconnected, false);
			assert.deepEqual(await client.read('40001'), hex('0001'));
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('timeouts are not counted: the socket stays open', async () => {
		const device = await start_fake_udp_device();
		const client = create_udp_client(device.port, { timeout: 30 });
		try {
			await client.connect();
			let disconnected = false;
			client.on('disconnect', () => {
				disconnected = true;
			});
			for (let i = 0; i < 4; i++) await assert.rejects(client.read('40001'), /timeout/);
			assert.equal(disconnected, false);
			assert.equal(client.is_connected, true);
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('UDP: a datagram is delimited on its own', async () => {
		// The first reply is split across two datagrams, which are not joined; the second has
		// bytes left after its frame, which are discarded
		const device = await start_fake_udp_device((frame) => {
			const reply = reply_to(frame, '01 03 02 abcd');
			return device.frames.length === 1
				? [reply.subarray(0, 5), reply.subarray(5)]
				: Buffer.concat([reply, hex('0000')]);
		});
		const client = create_udp_client(device.port, { timeout: 200 });
		try {
			await assert.rejects(client.read('40001'), /timeout/);
			assert.deepEqual(await client.read('40001'), hex('abcd'));
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('RTU-over-UDP: a response split across datagrams is joined', async () => {
		const reply = rtu_frame('01 03 04 01020304');
		const device = await start_fake_udp_device(() => [reply.subarray(0, 4), reply.subarray(4)]);
		const client = create_udp_client(device.port, { rtu_over_udp: true });
		try {
			assert.deepEqual(await client.read('40001,2'), hex('01020304'));
		} finally {
			await client.disconnect();
			await device.close();
		}
	});

	test('RTU-over-UDP: after a timeout the next frame waits max(delay, turnaround)', async () => {
		// The first request is answered late, after its timeout and before the next request
		let timed_out_at = 0;
		const device = await start_fake_udp_device((frame, remote) => {
			if (device.frames.length > 1) return rtu_frame('01 03 02 bbbb');
			setTimeout(() => {
				device.socket.send(rtu_frame('01 03 02 aaaa'), remote.port, remote.address);
			}, 120);
		});
		const client = create_udp_client(device.port, { rtu_over_udp: true, timeout: 80, turnaround: 200 });
		try {
			await client.connect();
			client.on('timeout', () => {
				timed_out_at = performance.now();
			});
			const first = client.read('40001');
			const second = client.read('40001');
			await assert.rejects(first, /timeout/);
			assert.deepEqual(await second, hex('bbbb'));
			assert.ok(device.frames[1].time - timed_out_at >= 190, 'the next frame waits for the turnaround');
		} finally {
			await client.disconnect();
			await device.close();
		}
	});
});

describe('UDP server', () => {
	test('start binds the socket and stop closes it', async () => {
		const { handler } = create_memory_handler();
		const { server } = await start_udp_server(handler);
		assert.notEqual(server.udp_socket, null);
		const stopped = once(server, 'stop');
		await server.stop();
		await stopped;
		assert.equal(server.udp_socket, null);
		await server.stop();
	});

	test('a restart binds a new socket', async () => {
		const memory = create_memory_handler();
		memory.unit(1).holding[0] = 9;
		const { server } = await start_udp_server(memory.handler);
		try {
			const first = server.udp_socket;
			await server.start();
			assert.notEqual(server.udp_socket, first);
			const peer = await raw_udp_socket();
			peer.send(tcp_frame(1, '01 03 0000 0001'), server.udp_socket.address().port, HOST);
			assert.deepEqual(await next_datagram(peer), tcp_frame(1, '01 03 02 0009'));
			peer.close();
		} finally {
			await server.stop();
		}
	});

	test('an address in use rejects start()', async () => {
		const occupied = await raw_udp_socket();
		const server = new Modbus_Server({}, { udp: `${HOST}:${occupied.address().port}` });
		try {
			await assert.rejects(server.start(), { code: 'EADDRINUSE' });
			assert.equal(server.udp_socket, null);
		} finally {
			await new Promise((resolve) => occupied.close(resolve));
		}
	});

	test('each response goes to the address and port of its request', async () => {
		const memory = create_memory_handler();
		memory.unit(1).holding[0] = 1;
		memory.unit(2).holding[0] = 2;
		const { server, port } = await start_udp_server(memory.handler);
		const peers = [await raw_udp_socket(), await raw_udp_socket()];
		try {
			const replies = peers.map((peer) => next_datagram(peer));
			peers[0].send(tcp_frame(7, '01 03 0000 0001'), port, HOST);
			peers[1].send(tcp_frame(8, '02 03 0000 0001'), port, HOST);
			assert.deepEqual(await replies[0], tcp_frame(7, '01 03 02 0001'));
			assert.deepEqual(await replies[1], tcp_frame(8, '02 03 02 0002'));
		} finally {
			for (const peer of peers) peer.close();
			await server.stop();
		}
	});

	test('UDP: a request split across datagrams is not served', async () => {
		const { handler, calls } = create_memory_handler();
		const { server, port } = await start_udp_server(handler);
		const peer = await raw_udp_socket();
		try {
			const request = tcp_frame(1, '01 03 0000 0001');
			const reply = next_datagram(peer, 200);
			peer.send(request.subarray(0, 6), port, HOST);
			peer.send(request.subarray(6), port, HOST);
			assert.equal(await reply, null);
			assert.deepEqual(calls, []);
		} finally {
			peer.close();
			await server.stop();
		}
	});

	test('RTU-over-UDP: the datagrams of each peer are one byte stream', async () => {
		const memory = create_memory_handler();
		memory.unit(1).holding[0] = 0x0101;
		memory.unit(1).holding[1] = 0x0202;
		const { server, port } = await start_udp_server(memory.handler, { rtu_over_udp: true });
		const peers = [await raw_udp_socket(), await raw_udp_socket()];
		try {
			const requests = [rtu_frame('01 03 0000 0001'), rtu_frame('01 03 0001 0001')];
			const replies = peers.map((peer) => next_datagram(peer));
			// The halves of the two peers' requests interleave
			peers[0].send(requests[0].subarray(0, 3), port, HOST);
			peers[1].send(requests[1].subarray(0, 3), port, HOST);
			await sleep(10);
			peers[0].send(requests[0].subarray(3), port, HOST);
			peers[1].send(requests[1].subarray(3), port, HOST);
			assert.deepEqual(await replies[0], rtu_frame('01 03 02 0101'));
			assert.deepEqual(await replies[1], rtu_frame('01 03 02 0202'));
		} finally {
			for (const peer of peers) peer.close();
			await server.stop();
		}
	});

	test('RTU-over-UDP: the bytes left after a silence are discarded', async () => {
		const memory = create_memory_handler();
		memory.unit(1).holding[0] = 0x0303;
		const { server, port } = await start_udp_server(memory.handler, { rtu_over_udp: true, silence: 20 });
		const peer = await raw_udp_socket();
		try {
			const request = rtu_frame('01 03 0000 0001');
			peer.send(request.subarray(0, 3), port, HOST);
			await sleep(60);
			const reply = next_datagram(peer);
			peer.send(request, port, HOST);
			assert.deepEqual(await reply, rtu_frame('01 03 02 0303'));
		} finally {
			peer.close();
			await server.stop();
		}
	});
});

describe('UDP options', () => {
	test('the client options that do not apply to the UDP family throw', () => {
		const cases = [
			[{ udp: 'h' }, 'keep_alive', 1000],
			[{ udp: 'h' }, 'max_timeouts', 1],
			[{ udp: 'h' }, 'silence', 10],
			[{ udp: 'h' }, 'turnaround', 10],
			[{ rtu_over_udp: 'h' }, 'baud_rate', 9600],
			[{ tcp: 'h' }, 'local', ':4001'],
			[{ serial: 'COM9' }, 'any_source_port', true],
		];
		for (const [transport, name, value] of cases) {
			const [kind] = Object.keys(transport);
			assert.throws(
				() => new Modbus_Client({ ...transport, [name]: value, reconnect_time: 0 }),
				{ message: `Option ${name} does not apply to ${kind}` },
				`${name} on ${kind}`,
			);
		}
	});

	test('RTU-over-UDP takes turnaround, silence and reconnect_max', () => {
		const client = new Modbus_Client({
			rtu_over_udp: 'h', turnaround: 10, silence: 10, reconnect_max: 1000, reconnect_time: 0,
		});
		assert.equal(client.protocol, 'rtu_over_udp');
		assert.equal(client.turnaround, 10);
	});

	test('local and any_source_port values are checked', () => {
		assert.throws(() => new Modbus_Client({ udp: 'h', local: 'h:0', reconnect_time: 0 }), /Invalid host: h:0/);
		assert.throws(
			() => new Modbus_Client({ udp: 'h', any_source_port: 1, reconnect_time: 0 }),
			/Invalid any_source_port: 1/,
		);
		assert.throws(() => new Modbus_Client({ udp: ':502', reconnect_time: 0 }), /Invalid host/);
	});

	test('the server options that do not apply to the UDP family throw', () => {
		assert.throws(() => new Modbus_Server({}, { udp: ':502', silence: 10 }), /Option silence does not apply to udp/);
		assert.throws(
			() => new Modbus_Server({}, { rtu_over_udp: ':502', parity: 'even' }),
			/Option parity does not apply to rtu_over_udp/,
		);
		const server = new Modbus_Server({}, { rtu_over_udp: ':4001', silence: 10 });
		assert.deepEqual([server.protocol, server.host, server.port], ['rtu_over_udp', '0.0.0.0', 4001]);
		assert.equal(server.is_udp, true);
		assert.equal(server.is_tcp, false);
	});
});
