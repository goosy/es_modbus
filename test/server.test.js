import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { SerialPort } from 'serialport';
import { Modbus_Server } from '../src/ModbusServer.js';
import {
	HOST, sleep, hex, rtu_frame, tcp_frame, collect,
	create_memory_vector, fake_socket,
	start_tcp_server, stop_tcp_server, raw_connect,
} from './helpers.js';

/** A SerialPort stand-in that records writes and is never opened. */
function fake_serial_port() {
	return Object.assign(Object.create(SerialPort.prototype), {
		written: [],
		write(buffer) {
			this.written.push(Buffer.from(buffer));
		},
	});
}

/** Sends one TCP request to a server through a fake socket; returns the written responses. */
function tcp_exchange(server, frame) {
	const socket = fake_socket();
	server.on_data(typeof frame === 'string' ? hex(frame) : frame, socket);
	return socket.written;
}

describe('Modbus_Server construction', () => {
	test('defaults', () => {
		const server = new Modbus_Server({});
		assert.equal(server.host, '0.0.0.0');
		assert.equal(server.port, 502);
		assert.equal(server.is_tcp, true);
		assert.ok(server.sockets instanceof Set);
		assert.equal(server.initialized, false);
		assert.equal(server.is_valid_unit_id(0), true);
		assert.equal(server.is_valid_unit_id(255), true);
	});

	test('a number port selects TCP', () => {
		const server = new Modbus_Server({}, { host: HOST, port: 1502 });
		assert.equal(server.host, HOST);
		assert.equal(server.port, 1502);
		assert.equal(server.is_tcp, true);
	});

	test('a SerialPort instance selects serial RTU', () => {
		const port = new SerialPort({ path: 'COM_NONEXISTENT', baudRate: 9600, autoOpen: false });
		const server = new Modbus_Server({}, { port });
		assert.equal(server.port, port);
		assert.equal(server.is_tcp, false);
		assert.equal(server.sockets, null);
	});

	test('a string port selects serial RTU on that device path', { todo: 'spec.md open question: serial parameters' }, () => {
		const server = new Modbus_Server({}, { port: 'COM_NONEXISTENT' });
		assert.equal(server.is_tcp, false);
		assert.equal(server.port.path, 'COM_NONEXISTENT');
	});

	test('an unsupported port type falls back to TCP port 502', () => {
		const server = new Modbus_Server({}, { port: {} });
		assert.equal(server.port, 502);
		assert.equal(server.is_tcp, true);
	});
});

describe('Modbus_Server unit IDs', () => {
	test('null, undefined, "all" and "*" accept every ID', () => {
		for (const value of [null, undefined, 'all', '*']) {
			const server = new Modbus_Server({}, { unit_id: value });
			assert.equal(server.accept_all_units, true, String(value));
			for (const id of [0, 1, 127, 255]) assert.equal(server.is_valid_unit_id(id), true);
		}
	});

	test('a number accepts only that ID', () => {
		const server = new Modbus_Server({}, { unit_id: 7 });
		assert.equal(server.is_valid_unit_id(7), true);
		assert.equal(server.is_valid_unit_id(8), false);
		assert.equal(server.is_valid_unit_id(0), false);
	});

	test('an array accepts exactly those IDs', () => {
		const server = new Modbus_Server({}, { unit_id: [1, 2, 255] });
		assert.deepEqual([0, 1, 2, 3, 255].map((id) => server.is_valid_unit_id(id)), [false, true, true, false, true]);
	});

	test('set_unit_ids replaces the accepted set', () => {
		const server = new Modbus_Server({}, { unit_id: 1 });
		server.set_unit_ids([5, 6]);
		assert.equal(server.is_valid_unit_id(1), false);
		assert.equal(server.is_valid_unit_id(5), true);
		server.set_unit_ids('*');
		assert.equal(server.is_valid_unit_id(1), true);
	});

	test('an ID outside 0..255 throws', () => {
		for (const value of [256, -1, 1.5, '1', [1, 300], [true]]) {
			assert.throws(() => new Modbus_Server({}, { unit_id: value }), /Invalid unit ID/, JSON.stringify(value));
		}
	});

	test('0 is an ordinary ID, not a synonym for every ID', () => {
		const server = new Modbus_Server({}, { unit_id: 0 });
		assert.equal(server.is_valid_unit_id(0), true);
		assert.equal(server.is_valid_unit_id(1), false);
	});
});

describe('Modbus_Server request handling (TCP framing)', () => {
	let memory;
	let server;
	beforeEach(() => {
		memory = create_memory_vector();
		server = new Modbus_Server(memory.vector, { port: 0 });
	});

	test('FC 1 reads coils packed LSB-first', () => {
		const coils = memory.unit(1).coils;
		for (const addr of [0x13, 0x15, 0x16, 0x19, 0x1a, 0x1c]) coils[addr] = 1;
		const [response] = tcp_exchange(server, tcp_frame(0x0102, '01010013000a'));
		// bits 0..9 starting at 0x13: 1 0 1 1 0 0 1 1 | 0 1  -> 0xcd, 0x02
		assert.equal(response.toString('hex'), tcp_frame(0x0102, '010102cd02').toString('hex'));
		assert.deepEqual(memory.calls.map((c) => c[1]), [...Array(10).keys()].map((i) => 0x13 + i));
	});

	test('FC 2 reads discrete inputs through get_coil', () => {
		memory.unit(2).coils[0] = 1;
		const [response] = tcp_exchange(server, tcp_frame(9, '020200000001'));
		assert.equal(response.toString('hex'), tcp_frame(9, '02020101').toString('hex'));
		assert.deepEqual(memory.calls, [['get_coil', 0, 2]]);
	});

	test('FC 3 reads holding registers', () => {
		memory.unit(1).holding.set([0x1234, 0xabcd], 100);
		const [response] = tcp_exchange(server, tcp_frame(1, '010300640002'));
		assert.equal(response.toString('hex'), tcp_frame(1, '0103041234abcd').toString('hex'));
		assert.deepEqual(memory.calls, [['get_holding_register', 100, 1], ['get_holding_register', 101, 1]]);
	});

	test('FC 4 reads input registers', () => {
		memory.unit(3).input[0xffff] = 7;
		const [response] = tcp_exchange(server, tcp_frame(1, '0304ffff0001'));
		assert.equal(response.toString('hex'), tcp_frame(1, '0304020007').toString('hex'));
		assert.deepEqual(memory.calls, [['get_input_register', 0xffff, 3]]);
	});

	test('FC 5 writes a single coil and echoes the request', () => {
		const [on] = tcp_exchange(server, tcp_frame(1, '010500acff00'));
		assert.equal(on.toString('hex'), tcp_frame(1, '010500acff00').toString('hex'));
		const [off] = tcp_exchange(server, tcp_frame(2, '010500ac0000'));
		assert.equal(off.toString('hex'), tcp_frame(2, '010500ac0000').toString('hex'));
		assert.deepEqual(memory.calls, [['set_coil', 0xac, true, 1], ['set_coil', 0xac, false, 1]]);
	});

	test('FC 6 writes a single register and echoes the request', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '01060001ffff'));
		assert.equal(response.toString('hex'), tcp_frame(1, '01060001ffff').toString('hex'));
		assert.deepEqual(memory.calls, [['set_register', 1, 0xffff, 1]]);
	});

	test('FC 15 writes multiple coils', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '010f0013000a02cd01'));
		assert.equal(response.toString('hex'), tcp_frame(1, '010f0013000a').toString('hex'));
		const written = memory.calls.map(([, addr, value]) => [addr, value]);
		const bits = [1, 0, 1, 1, 0, 0, 1, 1, 1, 0];
		assert.deepEqual(written, bits.map((bit, i) => [0x13 + i, bit === 1]));
	});

	test('FC 16 writes multiple registers', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '01100001000204000a0102'));
		assert.equal(response.toString('hex'), tcp_frame(1, '011000010002').toString('hex'));
		assert.deepEqual(memory.calls, [['set_register', 1, 0x000a, 1], ['set_register', 2, 0x0102, 1]]);
	});

	test('vector arguments have the specified types', () => {
		tcp_exchange(server, tcp_frame(1, '010500000000'));
		tcp_exchange(server, tcp_frame(1, '010600000005'));
		for (const [name, addr, value, unit_id] of memory.calls) {
			assert.equal(typeof addr, 'number', name);
			assert.equal(typeof unit_id, 'number', name);
			assert.equal(typeof value, name === 'set_coil' ? 'boolean' : 'number', name);
		}
	});

	test('the transaction and protocol IDs are echoed', () => {
		const [response] = tcp_exchange(server, tcp_frame(0xbeef, '010300000001'));
		assert.equal(response.readUInt16BE(0), 0xbeef);
		assert.equal(response.readUInt16BE(2), 0);
		assert.equal(response.readUInt16BE(4), response.length - 6);
	});

	test('coalesced requests are answered one by one', () => {
		const written = tcp_exchange(server, Buffer.concat([
			tcp_frame(1, '010300000001'), tcp_frame(2, '010600000009'), tcp_frame(3, '010300000001'),
		]));
		assert.deepEqual(written.map((r) => r.toString('hex')), [
			tcp_frame(1, '0103020000'), tcp_frame(2, '010600000009'), tcp_frame(3, '0103020009'),
		].map((b) => b.toString('hex')));
	});

	test('a unit ID that is not accepted gets exception 0x0B', () => {
		server.set_unit_ids([1]);
		const [response] = tcp_exchange(server, tcp_frame(4, '020300000001'));
		assert.equal(response.toString('hex'), tcp_frame(4, '02830b').toString('hex'));
		assert.deepEqual(memory.calls, []);
	});

	test('one vector backs several units', () => {
		memory.unit(18).holding[0] = 8018;
		memory.unit(19).holding[0] = 8019;
		const [a] = tcp_exchange(server, tcp_frame(1, '120300000001'));
		const [b] = tcp_exchange(server, tcp_frame(2, '130300000001'));
		assert.equal(a.readUInt16BE(9), 8018);
		assert.equal(b.readUInt16BE(9), 8019);
	});

	test('receive and send events carry whole frames', () => {
		const received = [];
		const sent = [];
		server.on('receive', (buffer) => received.push(buffer.toString('hex')));
		server.on('send', (buffer) => sent.push(buffer.toString('hex')));
		tcp_exchange(server, tcp_frame(1, '010300000001'));
		assert.deepEqual(received, [tcp_frame(1, '010300000001').toString('hex')]);
		assert.deepEqual(sent, [tcp_frame(1, '0103020000').toString('hex')]);
	});

	test('an unsupported function code gets exception 0x01 with the original code', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '010800000000'));
		assert.equal(response?.toString('hex'), tcp_frame(1, '018801').toString('hex'));
	});

	test('a malformed frame is dropped without a response', () => {
		assert.deepEqual(tcp_exchange(server, tcp_frame(1, '01030000000100')), []);
		assert.deepEqual(tcp_exchange(server, tcp_frame(1, '0110000000010200')), []);
	});

	test('a throwing vector is answered with exception 0x04', () => {
		server.vector = {
			...memory.vector,
			get_holding_register() {
				throw new Error('device failure');
			},
		};
		server.on('error', () => { });
		const [response] = tcp_exchange(server, tcp_frame(1, '010300000001'));
		assert.equal(response.toString('hex'), tcp_frame(1, '018304').toString('hex'));
	});

	test('a quantity outside the protocol limit gets exception 0x03', () => {
		const requests = [
			['010100000000', '018103'], ['0101000007d1', '018103'],
			['010200000000', '018203'], ['0102000007d1', '018203'],
			['010300000000', '018303'], ['01030000007e', '018303'],
			['01040000007e', '018403'], ['010300000100', '018303'],
			// An over-limit FC 15/16 request with a matching byte count does not fit in a PDU
			['010f00000000 00', '018f03'], ['010f000007b1 01 ff', '018f03'],
			['0110 0000 0000 00', '019003'], ['0110 0000 007c 02 0000', '019003'],
		];
		for (const [request, response] of requests) {
			const [written] = tcp_exchange(server, tcp_frame(1, request));
			assert.equal(written?.toString('hex'), tcp_frame(1, response).toString('hex'), request);
		}
		assert.deepEqual(memory.calls, []);
	});

	test('a byte count that does not match the quantity gets exception 0x03', () => {
		const [coils] = tcp_exchange(server, tcp_frame(1, '010f0000000a 01 cd'));
		assert.equal(coils.toString('hex'), tcp_frame(1, '018f03').toString('hex'));
		const [registers] = tcp_exchange(server, tcp_frame(1, '0110 0000 0002 02 0001'));
		assert.equal(registers.toString('hex'), tcp_frame(1, '019003').toString('hex'));
		assert.deepEqual(memory.calls, []);
	});

	test('an FC 5 value other than 0xFF00 or 0x0000 gets exception 0x03', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '010500001234'));
		assert.equal(response.toString('hex'), tcp_frame(1, '018503').toString('hex'));
		assert.deepEqual(memory.calls, []);
	});

	test('a range past address 65535 gets exception 0x02', () => {
		const requests = [
			['0103ffff0002', '018302'], ['0101fff00011', '018102'],
			['0110 ffff 0002 04 00010002', '019002'],
		];
		for (const [request, response] of requests) {
			const [written] = tcp_exchange(server, tcp_frame(1, request));
			assert.equal(written.toString('hex'), tcp_frame(1, response).toString('hex'), request);
		}
		assert.deepEqual(memory.calls, []);
	});

	test('a range may end at address 65535', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '0103fffe0002'));
		assert.equal(response.toString('hex'), tcp_frame(1, '01030400000000').toString('hex'));
	});

	test('the quantity is checked before the address', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, '0103ffff0080'));
		assert.equal(response.toString('hex'), tcp_frame(1, '018303').toString('hex'));
	});

	test('a throwing vector is reported through vector_error', () => {
		const failure = new Error('device failure');
		server.vector = {
			...memory.vector,
			set_coil() {
				throw failure;
			},
		};
		const reported = [];
		server.on('vector_error', (error, request) => reported.push([error, request.func_code]));
		const [response] = tcp_exchange(server, tcp_frame(1, '010f0000000a02cd01'));
		assert.equal(response.toString('hex'), tcp_frame(1, '018f04').toString('hex'));
		assert.deepEqual(reported, [[failure, 15]]);
	});

	test('a throwing vector without a vector_error listener does not throw', () => {
		server.vector = {
			...memory.vector,
			get_coil() {
				throw new Error('device failure');
			},
		};
		const [response] = tcp_exchange(server, tcp_frame(1, '010200000001'));
		assert.equal(response.toString('hex'), tcp_frame(1, '018204').toString('hex'));
	});

	test('an unsupported function code to a unit that is not accepted gets 0x0B', () => {
		server.set_unit_ids([1]);
		const [response] = tcp_exchange(server, tcp_frame(1, '020800000000'));
		assert.equal(response.toString('hex'), tcp_frame(1, '02880b').toString('hex'));
	});

	test('a request with an exception function code is dropped', () => {
		assert.deepEqual(tcp_exchange(server, tcp_frame(1, '018300000001')), []);
	});

	test('unit ID 0 is an ordinary unit on TCP', () => {
		memory.unit(0).holding[1] = 9;
		const [read] = tcp_exchange(server, tcp_frame(1, '000300010001'));
		assert.equal(read.toString('hex'), tcp_frame(1, '0003020009').toString('hex'));
		const [write] = tcp_exchange(server, tcp_frame(2, '000600010005'));
		assert.equal(write.toString('hex'), tcp_frame(2, '000600010005').toString('hex'));
		assert.deepEqual(memory.calls, [['get_holding_register', 1, 0], ['set_register', 1, 5, 0]]);
	});

	test('unit ID 0 that is not accepted gets exception 0x0B on TCP', () => {
		server.set_unit_ids([1]);
		const [response] = tcp_exchange(server, tcp_frame(1, '000600010005'));
		assert.equal(response.toString('hex'), tcp_frame(1, '00860b').toString('hex'));
		assert.deepEqual(memory.calls, []);
	});

	test('unit ID 255 is an ordinary unit on TCP', () => {
		const [response] = tcp_exchange(server, tcp_frame(1, 'ff0300000001'));
		assert.equal(response.toString('hex'), tcp_frame(1, 'ff03020000').toString('hex'));
	});
});

describe('Modbus_Server request handling (RTU framing)', () => {
	let memory;
	let port;
	let server;
	beforeEach(() => {
		memory = create_memory_vector();
		port = fake_serial_port();
		server = new Modbus_Server(memory.vector, { port });
	});

	test('responses carry a CRC and no MBAP', () => {
		memory.unit(0x11).holding.set([0xae41, 0x5652, 0x4340], 0x6b);
		server.on_data(rtu_frame('1103006b0003'));
		assert.deepEqual(port.written, [rtu_frame('110306 ae41 5652 4340')]);
	});

	test('every function code', () => {
		memory.unit(1).coils[0] = 1;
		memory.unit(1).input[0] = 3;
		const requests = [
			['010100000001', '01010101'],
			['010200000001', '01020101'],
			['010300000001', '0103020000'],
			['010400000001', '0104020003'],
			['01050001ff00', '01050001ff00'],
			['010600020007', '010600020007'],
			['010f 0010 0003 01 05', '010f00100003'],
			['0110 0020 0001 02 0102', '011000200001'],
		];
		for (const [request, response] of requests) {
			port.written.length = 0;
			server.on_data(rtu_frame(request));
			assert.equal(port.written[0]?.toString('hex'), rtu_frame(response).toString('hex'), request);
		}
	});

	/** Feeds one RTU request body to the server; returns what it wrote. */
	const rtu_exchange = (body) => {
		port.written.length = 0;
		server.on_data(rtu_frame(body));
		return port.written.map((b) => b.toString('hex'));
	};

	test('a unit ID that is not accepted is not answered', () => {
		server.set_unit_ids(1);
		assert.deepEqual(rtu_exchange('020300000001'), []);
		assert.deepEqual(rtu_exchange('020800000000'), []);
		assert.deepEqual(memory.calls, []);
	});

	test('a broadcast write is executed and not answered', () => {
		assert.deepEqual(rtu_exchange('000600010005'), []);
		assert.deepEqual(memory.calls, [['set_register', 1, 5, 0]]);
	});

	test('a broadcast read is ignored', () => {
		assert.deepEqual(rtu_exchange('000300010001'), []);
		assert.deepEqual(memory.calls, []);
	});

	test('a broadcast is not answered or executed when unit 0 is not accepted', () => {
		server.set_unit_ids([1]);
		assert.deepEqual(rtu_exchange('000600010005'), []);
		assert.deepEqual(memory.calls, []);
	});

	test('every write function is executed on a broadcast', () => {
		assert.deepEqual(rtu_exchange('00050003ff00'), []);
		assert.deepEqual(rtu_exchange('000f0010000201 03'), []);
		assert.deepEqual(rtu_exchange('00100020000102 0102'), []);
		assert.deepEqual(memory.calls, [
			['set_coil', 3, true, 0],
			['set_coil', 0x10, true, 0], ['set_coil', 0x11, true, 0],
			['set_register', 0x20, 0x0102, 0],
		]);
	});

	test('a broadcast is executed when unit 0 is the only accepted ID', () => {
		server.set_unit_ids(0);
		assert.deepEqual(rtu_exchange('000600010005'), []);
		assert.deepEqual(memory.calls, [['set_register', 1, 5, 0]]);
	});

	test('an invalid broadcast write is neither executed nor answered', () => {
		assert.deepEqual(rtu_exchange('000500011234'), []);
		assert.deepEqual(rtu_exchange('0010ffff000204 00010002'), []);
		assert.deepEqual(memory.calls, []);
	});

	test('a broadcast with an unsupported function code is not answered', () => {
		assert.deepEqual(rtu_exchange('000800000000'), []);
	});

	test('a throwing vector on a broadcast is reported but not answered', () => {
		server.vector = {
			...memory.vector,
			set_register() {
				throw new Error('device failure');
			},
		};
		let reported = 0;
		server.on('vector_error', () => reported++);
		assert.deepEqual(rtu_exchange('000600010005'), []);
		assert.equal(reported, 1);
	});

	test('a frame with a bad CRC is dropped', () => {
		const frame = rtu_frame('010300000001');
		frame[frame.length - 1] ^= 0xff;
		server.on_data(frame);
		assert.deepEqual(port.written, []);
	});

	test('an unsupported function code gets exception 0x01 with the original code', () => {
		server.on_data(rtu_frame('010800000000'));
		assert.deepEqual(port.written, [rtu_frame('018801')]);
	});

	test('an invalid quantity gets exception 0x03', () => {
		server.on_data(rtu_frame('010300000000'));
		assert.deepEqual(port.written, [rtu_frame('018303')]);
	});

	test('a malformed frame is dropped without a response', () => {
		server.on_data(rtu_frame('01030000000100'));
		server.on_data(hex('0103'));
		assert.deepEqual(port.written, []);
	});
});

describe('Modbus_Server TCP lifecycle', () => {
	let memory;
	let server;
	let port;
	beforeEach(async () => {
		memory = create_memory_vector();
		({ server, port } = await start_tcp_server(memory.vector));
	});
	afterEach(async () => {
		await stop_tcp_server(server);
	});

	test('start() listens and emits start', () => {
		assert.equal(server.initialized, true);
		assert.equal(server.server.listening, true);
	});

	test('answers requests over a real socket', async () => {
		memory.unit(1).holding[0] = 42;
		const socket = await raw_connect(port);
		socket.write(tcp_frame(7, '010300000001'));
		const response = await collect(socket, 11);
		assert.equal(response.toString('hex'), tcp_frame(7, '010302002a').toString('hex'));
		socket.destroy();
	});

	test('answers coalesced requests in one write', async () => {
		const socket = await raw_connect(port);
		socket.write(Buffer.concat([tcp_frame(1, '010300000001'), tcp_frame(2, '010300010001')]));
		const response = await collect(socket, 22);
		assert.equal(response.toString('hex'),
			Buffer.concat([tcp_frame(1, '0103020000'), tcp_frame(2, '0103020000')]).toString('hex'));
		socket.destroy();
	});

	test('socket_connect and socket_disconnect events track sockets', async () => {
		const connected = once(server, 'socket_connect');
		const socket = await raw_connect(port);
		await connected;
		assert.equal(server.sockets.size, 1);
		const disconnected = once(server, 'socket_disconnect');
		socket.destroy();
		await disconnected;
		assert.equal(server.sockets.size, 0);
	});

	test('socket_error is emitted on a per-connection error', async () => {
		const connected = once(server, 'socket_connect');
		const socket = await raw_connect(port);
		const [server_socket] = await connected;
		const socket_error = once(server, 'socket_error');
		server_socket.destroy(new Error('boom'));
		const [error] = await socket_error;
		assert.equal(error.message, 'boom');
		socket.destroy();
	});

	test('stop() destroys live sockets and emits stop', async () => {
		const socket = await raw_connect(port);
		await sleep(20);
		const closed = once(socket, 'close');
		const stopped = once(server, 'stop');
		server.stop();
		await Promise.all([closed, stopped]);
		assert.equal(server.sockets.size, 0);
		assert.equal(server.server.listening, false);
	});

	test('start() again re-opens the listener', async () => {
		await stop_tcp_server(server);
		const started = once(server, 'start');
		server.start();
		await started;
		assert.equal(server.server.listening, true);
		const socket = await raw_connect(server.server.address().port);
		socket.write(tcp_frame(1, '010300000001'));
		assert.equal((await collect(socket, 11)).length, 11);
		socket.destroy();
	});

	test('start() while listening restarts the listener', async () => {
		const restarted = once(server, 'start');
		server.start();
		await restarted;
		assert.equal(server.server.listening, true);
	});

	test('error is emitted when the port is in use', async () => {
		const other = new Modbus_Server(memory.vector, { host: HOST, port });
		const error = once(other, 'error');
		other.start();
		const [reason] = await error;
		assert.equal(reason.code, 'EADDRINUSE');
	});

	test('the response to one client is not sent to another', async () => {
		const a = await raw_connect(port);
		const b = await raw_connect(port);
		a.write(tcp_frame(1, '010300000001'));
		const [to_a, to_b] = await Promise.all([collect(a, 11), collect(b, 1, 100)]);
		assert.equal(to_a.length, 11);
		assert.equal(to_b.length, 0);
		a.destroy();
		b.destroy();
	});
});

describe('Modbus_Server RTU-over-TCP', () => {
	test('rtu: true serves RTU frames on TCP sockets', { todo: 'design.md RTU / serial: no rtu_over_tcp mode' }, async () => {
		const memory = create_memory_vector();
		memory.unit(1).holding[0] = 5;
		const { server, port } = await start_tcp_server(memory.vector, { rtu: true });
		try {
			const socket = await raw_connect(port);
			socket.write(rtu_frame('010300000001'));
			const response = await collect(socket, 7, 300);
			socket.destroy();
			assert.equal(response.toString('hex'), rtu_frame('0103020005').toString('hex'));
		} finally {
			await stop_tcp_server(server);
		}
	});
});
