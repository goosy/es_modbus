import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { Modbus_Server } from '../src/ModbusServer.js';
import { set_serial_port_factory } from '../src/serial.js';
import {
	HOST, sleep, hex, rtu_frame, tcp_frame, collect,
	create_memory_vector, fake_socket, Fake_Serial_Port,
	start_tcp_server, stop_tcp_server, raw_connect,
} from './helpers.js';

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
		assert.equal(server.protocol, 'tcp');
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
		assert.equal(server.protocol, 'tcp');
	});

	test('a number port with rtu: true selects RTU-over-TCP', () => {
		const server = new Modbus_Server({}, { port: 1502, rtu: true });
		assert.equal(server.is_tcp, true);
		assert.equal(server.protocol, 'rtu_over_tcp');
		assert.ok(server.sockets instanceof Set);
	});

	test('a string port selects serial RTU on that device path, with default serial settings', () => {
		const server = new Modbus_Server({}, { port: 'COM_NONEXISTENT' });
		assert.equal(server.is_tcp, false);
		assert.equal(server.protocol, 'rtu');
		assert.equal(server.port, 'COM_NONEXISTENT');
		assert.equal(server.sockets, null);
		assert.equal(server.serial_port, null);
		assert.deepEqual(server.serial_settings, {
			path: 'COM_NONEXISTENT', baudRate: 9600, parity: 'none', dataBits: 8, stopBits: 1,
		});
	});

	test('the flat serial options set the serial settings', () => {
		const server = new Modbus_Server({}, {
			port: 'COM_NONEXISTENT', baud_rate: 19200, parity: 'even', data_bits: 7, stop_bits: 2,
		});
		assert.deepEqual(server.serial_settings, {
			path: 'COM_NONEXISTENT', baudRate: 19200, parity: 'even', dataBits: 7, stopBits: 2,
		});
	});

	test('parity accepts 0 = none, 1 = odd, 2 = even', () => {
		for (const [code, name] of [[0, 'none'], [1, 'odd'], [2, 'even']]) {
			const server = new Modbus_Server({}, { port: 'COM_NONEXISTENT', parity: code });
			assert.equal(server.serial_settings.parity, name);
		}
	});

	test('an invalid serial option throws at construction', () => {
		const cases = [
			...[3, -1, 'EVEN', 'mark', true].map((parity) => [{ parity }, /Invalid parity/]),
			...[0, 9600.5, '9600'].map((baud_rate) => [{ baud_rate }, /Invalid baud rate/]),
			...[4, 9, '8'].map((data_bits) => [{ data_bits }, /Invalid data bits/]),
			...[0, 3, '1'].map((stop_bits) => [{ stop_bits }, /Invalid stop bits/]),
			[{ port: '' }, /Invalid serial port/],
		];
		for (const [options, error] of cases) {
			assert.throws(
				() => new Modbus_Server({}, { port: 'COM_NONEXISTENT', ...options }),
				error,
				JSON.stringify(options),
			);
		}
	});

	test('a port that is neither a number nor a string throws', () => {
		for (const port of [{}, [], true]) {
			assert.throws(() => new Modbus_Server({}, { port }), /Invalid port/);
		}
	});
});

describe('Modbus_Server serial lifecycle', () => {
	let created;
	// Records every port it creates in `created`
	const recording_factory = async (settings) => {
		const port = new Fake_Serial_Port(settings);
		created.push(port);
		return port;
	};
	before(() => set_serial_port_factory(recording_factory));
	after(() => set_serial_port_factory(null));
	beforeEach(() => {
		created = [];
	});

	test('start() creates the serial port from the settings and opens it', async () => {
		const server = new Modbus_Server({}, { port: 'COM9', baud_rate: 19200 });
		server.start();
		await once(server, 'start');
		assert.equal(created.length, 1);
		assert.equal(server.serial_port, created[0]);
		assert.equal(created[0].settings.path, 'COM9');
		assert.equal(created[0].settings.baudRate, 19200);
		assert.equal(created[0].isOpen, true);
		assert.equal(server.initialized, true);
	});

	test('stop() closes the port; start() re-opens the same port', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		server.start();
		await once(server, 'start');
		server.stop();
		await once(server, 'stop');
		assert.equal(created[0].isOpen, false);
		server.start();
		await once(server, 'start');
		assert.equal(created.length, 1);
		assert.equal(created[0].opens, 2);
	});

	test('start() on an open port closes and re-opens it', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		server.start();
		await once(server, 'start');
		const stopped = once(server, 'stop');
		server.start();
		await stopped;
		await once(server, 'start');
		assert.equal(created[0].opens, 2);
	});

	test('an open failure is emitted as error', async () => {
		set_serial_port_factory(async (settings) => Object.assign(new Fake_Serial_Port(settings), { fail_open: true }));
		try {
			const server = new Modbus_Server({}, { port: 'COM9' });
			server.start();
			const [error] = await once(server, 'error');
			assert.equal(error.message, 'open failed');
		} finally {
			set_serial_port_factory(recording_factory);
		}
	});

	test('a port that cannot be created is emitted as error, and a later start() retries', async () => {
		let attempts = 0;
		set_serial_port_factory(async (settings) => {
			if (++attempts === 1) throw new Error('no native binding');
			return new Fake_Serial_Port(settings);
		});
		try {
			const server = new Modbus_Server({}, { port: 'COM9' });
			server.start();
			const [error] = await once(server, 'error');
			assert.equal(error.message, 'no native binding');
			server.start();
			await once(server, 'start');
			assert.equal(attempts, 2);
		} finally {
			set_serial_port_factory(recording_factory);
		}
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

	test('a frame split across reads is reassembled, with a buffer per socket', () => {
		const a = fake_socket();
		const b = fake_socket();
		const frame_a = tcp_frame(1, '010300000001');
		const frame_b = tcp_frame(2, '010300000001');
		server.on_data(frame_a.subarray(0, 5), a);
		server.on_data(frame_b.subarray(0, 9), b);
		assert.deepEqual([a.written, b.written], [[], []]);
		server.on_data(frame_a.subarray(5), a);
		server.on_data(frame_b.subarray(9), b);
		assert.deepEqual(a.written.map((r) => r.readUInt16BE(0)), [1]);
		assert.deepEqual(b.written.map((r) => r.readUInt16BE(0)), [2]);
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

	test('a request that fails check_request gets its exception, without a vector call', () => {
		// The rules are tested on check_request() in util.test.js
		const requests = [['010300000000', '018303'], ['0103ffff0002', '018302']];
		for (const [request, response] of requests) {
			const [written] = tcp_exchange(server, tcp_frame(1, request));
			assert.equal(written.toString('hex'), tcp_frame(1, response).toString('hex'), request);
		}
		assert.deepEqual(memory.calls, []);
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
		port = new Fake_Serial_Port();
		server = new Modbus_Server(memory.vector, { port: 'COM9' });
		server.serial_port = port;
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

	test('leftover bytes are discarded once the line is silent', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		server.set_rtu();
		port.emit('data', hex('0103'));
		t.mock.timers.tick(50);
		port.emit('data', rtu_frame('010300000001'));
		assert.deepEqual(port.written, [rtu_frame('0103020000')]);
	});

	test('the silence option sets the silence on a serial port', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		server = new Modbus_Server(memory.vector, { port: 'COM9', silence: 200 });
		server.serial_port = port;
		server.set_rtu();
		port.emit('data', rtu_frame('010800000000'));
		t.mock.timers.tick(199);
		assert.deepEqual(port.written, []);
		t.mock.timers.tick(1);
		assert.deepEqual(port.written, [rtu_frame('018801')]);
	});

	test('the silence is 3.5 character times when that is longer than 50 ms', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		// 300 baud, 8E1: 11 bits a character, 3.5 characters = 128.3 ms
		server = new Modbus_Server(memory.vector, { port: 'COM9', baud_rate: 300, parity: 'even' });
		server.serial_port = port;
		server.set_rtu();
		port.emit('data', rtu_frame('010800000000'));
		t.mock.timers.tick(128);
		assert.deepEqual(port.written, []);
		t.mock.timers.tick(1);
		assert.deepEqual(port.written, [rtu_frame('018801')]);
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
	test('rtu is ignored for a serial port', () => {
		const server = new Modbus_Server({}, { port: 'COM_NONEXISTENT', rtu: true });
		assert.equal(server.protocol, 'rtu');
		assert.equal(server.sockets, null);
	});

	/** Sends one RTU request body through a fake socket; returns the written responses as hex. */
	const rtu_socket_exchange = (server, body) => {
		const socket = fake_socket();
		server.on_data(rtu_frame(body), socket);
		return socket.written.map((b) => b.toString('hex'));
	};

	test('responses carry a CRC and go to the socket', () => {
		const memory = create_memory_vector();
		memory.unit(1).holding[0] = 5;
		const server = new Modbus_Server(memory.vector, { port: 1502, rtu: true });
		assert.deepEqual(rtu_socket_exchange(server, '010300000001'), [rtu_frame('0103020005').toString('hex')]);
	});

	test('an unsupported function code gets exception 0x01 at once', () => {
		const server = new Modbus_Server(create_memory_vector().vector, { port: 1502, rtu: true });
		assert.deepEqual(rtu_socket_exchange(server, '010800000000'), [rtu_frame('018801').toString('hex')]);
	});

	test('frames are delimited by length: split and coalesced', () => {
		const server = new Modbus_Server(create_memory_vector().vector, { port: 1502, rtu: true });
		const socket = fake_socket();
		const frame = rtu_frame('010300000001');
		server.on_data(Buffer.concat([frame, frame.subarray(0, 4)]), socket);
		server.on_data(Buffer.concat([frame.subarray(4), frame]), socket);
		assert.deepEqual(socket.written.map((b) => b.toString('hex')), Array(3).fill(rtu_frame('0103020000').toString('hex')));
	});

	test('the silence option sets the silence on TCP', (t) => {
		t.mock.timers.enable({ apis: ['setTimeout'] });
		const server = new Modbus_Server(create_memory_vector().vector, { port: 1502, rtu: true, silence: 10 });
		const socket = fake_socket();
		server.on_data(Buffer.concat([hex('011000000078f0'), rtu_frame('010300000001')]), socket);
		t.mock.timers.tick(9);
		assert.deepEqual(socket.written, []);
		t.mock.timers.tick(1);
		assert.equal(socket.written.length, 1);
	});

	test('an invalid silence throws at construction', () => {
		for (const silence of [0, -5, '50']) {
			assert.throws(() => new Modbus_Server({}, { port: 1502, silence }), /Invalid silence/);
			assert.throws(() => new Modbus_Server({}, { port: 'COM9', silence }), /Invalid silence/);
		}
	});

	test('an MBAP frame is not served', () => {
		const server = new Modbus_Server(create_memory_vector().vector, { port: 1502, rtu: true });
		const socket = fake_socket();
		server.on_data(tcp_frame(1, '010300000001'), socket);
		assert.deepEqual(socket.written, []);
	});

	test('serial bus semantics: a non-accepted unit and a broadcast are not answered', () => {
		const memory = create_memory_vector();
		const server = new Modbus_Server(memory.vector, { port: 1502, rtu: true, unit_id: [0, 1] });
		assert.deepEqual(rtu_socket_exchange(server, '020300000001'), []);
		assert.deepEqual(rtu_socket_exchange(server, '000600010005'), []);
		assert.equal(memory.unit(0).holding[1], 5);
	});

	test('rtu: true serves RTU frames on TCP sockets', async () => {
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

/** Records the server events in `events`, in order. */
function record_events(server, names = ['start', 'stop', 'error']) {
	const events = [];
	for (const name of names) server.on(name, () => events.push(name));
	return events;
}

/** Waits until the pending promise jobs and `unhandledRejection` checks have run. */
function settle() {
	return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

describe('Modbus_Server start() / stop() promises (TCP)', () => {
	let server;
	afterEach(async () => {
		await server?.stop();
	});

	test('start() resolves after start, stop() after stop', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		const events = record_events(server);
		await server.start();
		assert.deepEqual(events, ['start']);
		assert.equal(server.server.listening, true);
		await server.stop();
		assert.deepEqual(events, ['start', 'stop']);
		assert.equal(server.server.listening, false);
	});

	test('stop() resolves at once when not started', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		const events = record_events(server);
		await server.stop();
		await server.start();
		await server.stop();
		await server.stop();
		assert.deepEqual(events, ['start', 'stop']);
	});

	test('stop() destroys the live sockets before it resolves', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		await server.start();
		const socket = await raw_connect(server.server.address().port);
		await sleep(20);
		const closed = once(socket, 'close');
		await server.stop();
		assert.equal(server.sockets.size, 0);
		await closed;
	});

	test('start() while started restarts: stop, then start; live sockets are destroyed', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		await server.start();
		const socket = await raw_connect(server.server.address().port);
		await sleep(20);
		const closed = once(socket, 'close');
		const events = record_events(server);
		await server.start();
		assert.deepEqual(events, ['stop', 'start']);
		assert.equal(server.server.listening, true);
		await closed;
	});

	test('a start() during a start joins it; a stop() during a stop joins it', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		const events = record_events(server);
		const a = server.start();
		const b = server.start();
		assert.equal(a, b);
		await a;
		const c = server.stop();
		const d = server.stop();
		assert.equal(c, d);
		await c;
		assert.deepEqual(events, ['start', 'stop']);
	});

	test('start(); stop(); start(); runs in call order', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		const events = record_events(server);
		await Promise.all([server.start(), server.stop(), server.start()]);
		assert.deepEqual(events, ['start', 'stop', 'start']);
		assert.equal(server.server.listening, true);
	});

	test('a start() from the start listener restarts instead of joining', async () => {
		server = new Modbus_Server({}, { host: HOST, port: 0 });
		const events = record_events(server);
		let restarted;
		server.once('start', () => {
			restarted = server.start();
		});
		await server.start();
		await restarted;
		assert.deepEqual(events, ['start', 'stop', 'start']);
	});

	describe('a port in use', () => {
		let other;
		beforeEach(async () => {
			other = new Modbus_Server({}, { host: HOST, port: 0 });
			await other.start();
		});
		afterEach(async () => {
			await other.stop();
		});

		test('without an error listener, start() rejects and nothing is emitted', async () => {
			server = new Modbus_Server({}, { host: HOST, port: other.server.address().port });
			await assert.rejects(server.start(), { code: 'EADDRINUSE' });
			assert.equal(server.server.listening, false);
		});

		test('with an error listener, the error is emitted and the rejection is handled', async () => {
			server = new Modbus_Server({}, { host: HOST, port: other.server.address().port });
			const errors = [];
			server.on('error', (error) => errors.push(error));
			const unhandled = [];
			const on_unhandled = (reason) => unhandled.push(reason);
			process.on('unhandledRejection', on_unhandled);
			try {
				// Not awaited, as code written before start() returned a promise
				server.start();
				await once(server, 'error');
				await settle();
			} finally {
				process.off('unhandledRejection', on_unhandled);
			}
			assert.equal(errors.length, 1);
			assert.equal(errors[0].code, 'EADDRINUSE');
			assert.deepEqual(unhandled, []);
		});

		test('with an error listener, an awaiting caller also gets the rejection', async () => {
			server = new Modbus_Server({}, { host: HOST, port: other.server.address().port });
			server.on('error', () => { });
			await assert.rejects(server.start(), { code: 'EADDRINUSE' });
		});

		test('a later start() retries', async () => {
			server = new Modbus_Server({}, { host: HOST, port: other.server.address().port });
			await assert.rejects(server.start());
			await other.stop();
			await server.start();
			assert.equal(server.server.listening, true);
		});

		test('handled by nobody, the failure terminates the process', async () => {
			const url = new URL('../src/ModbusServer.js', import.meta.url).href;
			const script = `import { Modbus_Server } from '${url}';
				new Modbus_Server({}, { host: '${HOST}', port: ${other.server.address().port} }).start();`;
			const [exit_code, stderr] = await new Promise((resolve) => {
				execFile(process.execPath, ['--input-type=module', '-e', script], (error, _, stderr) => {
					resolve([error?.code ?? 0, stderr]);
				});
			});
			assert.notEqual(exit_code, 0);
			assert.match(stderr, /EADDRINUSE/);
		});
	});
});

describe('Modbus_Server start() / stop() promises (serial)', () => {
	before(() => set_serial_port_factory(async (settings) => new Fake_Serial_Port(settings)));
	after(() => set_serial_port_factory(null));

	test('start() resolves after start, stop() after stop', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		const events = record_events(server);
		await server.start();
		assert.deepEqual(events, ['start']);
		assert.equal(server.serial_port.isOpen, true);
		await server.stop();
		assert.deepEqual(events, ['start', 'stop']);
		assert.equal(server.serial_port.isOpen, false);
	});

	test('start() while open closes and re-opens the port', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		await server.start();
		const events = record_events(server);
		await server.start();
		assert.deepEqual(events, ['stop', 'start']);
		assert.equal(server.serial_port.opens, 2);
		await server.stop();
	});

	test('stop() resolves at once after the port closed by itself', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		await server.start();
		const stopped = once(server, 'stop');
		server.serial_port.close();
		await stopped;
		const events = record_events(server);
		await server.stop();
		assert.deepEqual(events, []);
	});

	test('an open failure rejects start(); without a listener nothing is emitted', async () => {
		const server = new Modbus_Server({}, { port: 'COM9' });
		const ports = [];
		set_serial_port_factory(async (settings) => {
			const port = Object.assign(new Fake_Serial_Port(settings), { fail_open: true });
			ports.push(port);
			return port;
		});
		try {
			await assert.rejects(server.start(), /open failed/);
			// The port was created; the next start() opens it again
			ports[0].fail_open = false;
			await server.start();
			assert.equal(ports.length, 1);
			await server.stop();
		} finally {
			set_serial_port_factory(async (settings) => new Fake_Serial_Port(settings));
		}
	});

	test('a creation failure rejects start(); a start() from the error listener retries', async () => {
		let attempts = 0;
		set_serial_port_factory(async (settings) => {
			if (++attempts === 1) throw new Error('no native binding');
			return new Fake_Serial_Port(settings);
		});
		const server = new Modbus_Server({}, { port: 'COM9' });
		let retried;
		server.once('error', () => {
			retried = server.start();
		});
		await assert.rejects(server.start(), /no native binding/);
		await retried;
		assert.equal(attempts, 2);
		assert.equal(server.serial_port.isOpen, true);
		await server.stop();
	});
});
