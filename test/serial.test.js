// End-to-end Modbus RTU over a serial link (see design-test.md, "Serial tests").
//
// MODBUS_SERIAL_PORTS="<first>,<second>" sets the two ends of the link; when it is unset the
// suites are skipped. Both ends are serial ports linked like a null-modem cable, or the first is
// a serial port and the second the TCP end of a transparent serial-to-TCP converter: "host:port"
// connects to the converter, ":port" listens for it. With two serial ports a baud-rate sweep
// runs first, and the suites run at 9600 baud, or at the first rate that worked when 9600 did
// not. A link that is set but cannot be used fails the run.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { SerialPort } from 'serialport-rs';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { sleep, hex, rtu_frame, collect, create_memory_handler } from './helpers.js';

// The default settings of every suite: 9600 8N1, the usual Modbus default
const DEFAULT_BAUD_RATE = 9600;
const SWEEP_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
// The baud rate of the suites: the default, unless the sweep shows it does not work on the link
let suite_baud_rate = DEFAULT_BAUD_RATE;
// How long to wait for a TCP end: a connection to the converter, or the converter connecting
const TCP_WAIT_MS = 10000;

/**
 * Parses MODBUS_SERIAL_PORTS into `{ first, second }`. The first end is `{ serial: path }`; the
 * second is `{ serial: path }`, `{ host, port }` (connect) or `{ listen: port }`. Throws on an
 * invalid value.
 */
function parse_link(spec) {
	const ends = spec.split(',').map((end) => end.trim());
	const invalid = (reason) => new Error(`Invalid MODBUS_SERIAL_PORTS "${spec}": ${reason}`);
	if (ends.length !== 2 || ends.includes('')) throw invalid('expected "<first>,<second>"');
	const [first, second] = ends;
	if (first.includes(':')) throw invalid('the first end must be a serial port');
	if (!second.includes(':')) return { first: { serial: first }, second: { serial: second } };
	const index = second.lastIndexOf(':');
	const host = second.slice(0, index);
	const port = Number(second.slice(index + 1));
	if (!Number.isInteger(port) || port < 1 || port > 0xffff) throw invalid(`bad TCP port in "${second}"`);
	return { first: { serial: first }, second: host === '' ? { listen: port } : { host, port } };
}

const end_name = (end) => end.serial ?? (end.listen ? `:${end.listen}` : `${end.host}:${end.port}`);

const with_timeout = (promise, ms, message) => {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

const open_port = (port) => new Promise((resolve, reject) => {
	port.open((error) => (error ? reject(error) : resolve()));
});
const close_port = (port) => new Promise((resolve) => {
	if (!port?.isOpen) return resolve();
	port.close(() => resolve());
});
const new_port = (path, baud_rate = suite_baud_rate) => new SerialPort({ path, baudRate: baud_rate, autoOpen: false });

/** Opens a raw stream on an end of the link: a serial port, or a TCP socket to or from the converter. */
async function open_end(end, baud_rate = suite_baud_rate) {
	if (end.serial) {
		const port = new_port(end.serial, baud_rate);
		await open_port(port);
		return port;
	}
	if (end.host) {
		const socket = connect(end.port, end.host);
		socket.on('error', () => { });
		await with_timeout(once(socket, 'connect'), TCP_WAIT_MS, `no connection to ${end_name(end)}`);
		return socket;
	}
	// The converter connects to us; once it has, stop accepting so the port is free again
	const server = createServer();
	server.listen(end.listen);
	try {
		await once(server, 'listening');
		const [socket] = await with_timeout(
			once(server, 'connection'), TCP_WAIT_MS, `the converter did not connect to :${end.listen}`);
		socket.on('error', () => { });
		return socket;
	} finally {
		server.close();
	}
}

/** Closes a raw stream opened by open_end(). */
async function close_end(stream) {
	if (stream instanceof SerialPort) return close_port(stream);
	if (stream.destroyed) return;
	const closed = once(stream, 'close');
	stream.destroy();
	await closed;
}

/** Writes on a raw stream and waits until the bytes have left it. */
async function send(stream, buffer) {
	await new Promise((resolve, reject) => stream.write(buffer, (error) => (error ? reject(error) : resolve())));
	if (stream instanceof SerialPort) await new Promise((resolve) => stream.drain(resolve));
}

/** Writes a request on a raw stream and collects up to `length` response bytes. */
async function exchange(stream, request, length, ms = 500) {
	const response = collect(stream, length, ms);
	stream.write(typeof request === 'string' ? rtu_frame(request) : request);
	return response;
}

/** Starts a Modbus_Server on a serial port. */
async function start_serial_server(handler, path, options = {}) {
	const server = new Modbus_Server(handler, { port: path, baud_rate: suite_baud_rate, ...options });
	server.on('error', () => { });
	await server.start();
	return server;
}

/** Opens both ends of the link once; throws the reason when an end cannot be used. */
async function check_link(link) {
	const first = await open_end(link.first);
	await close_end(first);
	const second = await open_end(link.second);
	await close_end(second);
}

/**
 * Tries each sweep baud rate over two serial ports: a server on the first port answers a
 * request from a raw peer on the second. Returns `{ baud_rate, error }` per rate, `error` null
 * when the rate worked.
 */
async function run_sweep(link) {
	const results = [];
	for (const baud_rate of SWEEP_BAUD_RATES) {
		const memory = create_memory_handler();
		memory.unit(1).holding[0] = baud_rate & 0xffff;
		let server;
		let peer;
		let error = null;
		try {
			server = await start_serial_server(memory.handler, link.first.serial, { baud_rate });
			peer = await open_end(link.second, baud_rate);
			const response = await exchange(peer, '010300000001', 7);
			const expected = rtu_frame(Buffer.from([1, 3, 2, (baud_rate >> 8) & 0xff, baud_rate & 0xff]));
			if (!response.equals(expected)) {
				error = `response ${response.toString('hex') || '(none)'}, expected ${expected.toString('hex')}`;
			}
		} catch (cause) {
			error = cause.message;
		} finally {
			if (peer) await close_end(peer);
			await server?.stop();
		}
		results.push({ baud_rate, error });
	}
	return results;
}

const link_spec = process.env.MODBUS_SERIAL_PORTS;
let link = null;
let link_error = null;
if (link_spec) {
	try {
		link = parse_link(link_spec);
		await check_link(link);
	} catch (error) {
		link_error = error.message;
	}
}
const sweep = link && !link_error && link.second.serial ? await run_sweep(link) : null;
const worked = sweep?.filter(({ error }) => !error).map(({ baud_rate }) => baud_rate);
// Two serial ports: the suites keep the default whenever it worked, else take the first rate that did
if (worked?.length > 0 && !worked.includes(DEFAULT_BAUD_RATE)) suite_baud_rate = worked[0];

let skip = false;
if (!link_spec) skip = 'MODBUS_SERIAL_PORTS is not set';
else if (link_error) skip = 'the serial link cannot be used';
else if (worked?.length === 0) skip = 'no baud rate worked in the sweep';

const first_name = link ? end_name(link.first) : 'first end';
const second_name = link ? end_name(link.second) : 'second end';

test(link_spec ? `serial link ${link_spec} can be used` : 'serial link can be used', { skip: !link_spec && skip }, () => {
	if (link_error) assert.fail(link_error);
});

test('baud-rate sweep', { skip: (!sweep && (skip || 'the link has a TCP end')) }, (t) => {
	for (const { baud_rate, error } of sweep) {
		if (error) t.diagnostic(`${baud_rate} failed: ${error}`);
	}
	t.diagnostic(`baud rates that worked: ${worked.join(', ') || 'none'}`);
	if (worked.length > 0) t.diagnostic(`the suites run at ${suite_baud_rate} baud`);
	assert.ok(worked.length > 0, 'no baud rate worked');
});

const as_hex = (buffer) => buffer.toString('hex');

describe(`Modbus RTU server on ${first_name}, raw peer on ${second_name}`, { skip }, () => {
	let memory;
	let server;
	let peer;
	before(async () => {
		memory = create_memory_handler();
		server = await start_serial_server(memory.handler, link.first.serial, { unit_id: [1, 2, 0x11] });
		peer = await open_end(link.second);
	});
	after(async () => {
		if (peer) await close_end(peer);
		await server?.stop();
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
		await send(peer, frame.subarray(0, 3));
		await sleep(1);
		await send(peer, frame.subarray(3));
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

// The client sits on a serial end: the second with two serial ports, else the first. The raw
// slave is on the other end.
const client_on_second = !link || Boolean(link.second.serial);
const client_name = client_on_second ? second_name : first_name;
const slave_name = client_on_second ? first_name : second_name;

describe(`Modbus RTU client on ${client_name}, raw slave on ${slave_name}`, { skip }, () => {
	let slave;
	let client;
	before(async () => {
		slave = await open_end(client_on_second ? link.first : link.second);
		const path = (client_on_second ? link.second : link.first).serial;
		client = new Modbus_Client(null, { port: path, baud_rate: suite_baud_rate, timeout: 1000, reconnect_time: 0 });
		client.on('error', () => { });
		await client.connect();
	});
	after(async () => {
		await client?.disconnect();
		if (slave) await close_end(slave);
	});

	/**
	 * Answers the next request on the raw slave: waits for `request.length` bytes, records them,
	 * and writes `reply` in the given parts. Resolves with the request received.
	 */
	async function answer(request_length, ...reply_parts) {
		const request = await collect(slave, request_length, 1000);
		for (const part of reply_parts) await send(slave, part);
		return request;
	}

	test('requests go out as RTU frames and responses are decoded', async () => {
		const [value, request] = await Promise.all([
			client.read('40001,2'),
			answer(8, rtu_frame('01030400010002')),
		]);
		assert.equal(as_hex(request), as_hex(rtu_frame('010300000002')));
		assert.deepEqual(value, hex('00010002'));

		const [, write_request] = await Promise.all([
			client.write('40003', 7),
			answer(8, rtu_frame('010600020007')),
		]);
		assert.equal(as_hex(write_request), as_hex(rtu_frame('010600020007')));
	});

	test('a response split across reads is reassembled', async () => {
		const response = rtu_frame('010402002a');
		const [value] = await Promise.all([
			client.read('30001'),
			answer(8, response.subarray(0, 3), response.subarray(3)),
		]);
		assert.deepEqual(value, hex('002a'));
	});
});

/**
 * Starts the two classes on the link: with two serial ports the server on the first and the
 * client on the second; with a TCP end the class on the serial port is the one whose peer can
 * take the TCP end, the server when the tests connect to the converter (an RTU-over-TCP client
 * connects), the client when the converter connects to the tests (an RTU-over-TCP server listens).
 */
async function start_pair(handler) {
	const client_options = { timeout: 1000, reconnect_time: 0 };
	if (link.second.serial) {
		const server = await start_serial_server(handler, link.first.serial);
		const client = new Modbus_Client(null, { port: link.second.serial, baud_rate: suite_baud_rate, ...client_options });
		return { server, client };
	}
	if (link.second.host) {
		const server = await start_serial_server(handler, link.first.serial);
		const client = new Modbus_Client(link.second.host, { port: link.second.port, rtu: true, ...client_options });
		return { server, client };
	}
	const server = new Modbus_Server(handler, { port: link.second.listen, rtu: true });
	server.on('error', () => { });
	server.on('socket_error', () => { });
	const converter = once(server, 'socket_connect');
	await server.start();
	await with_timeout(converter, TCP_WAIT_MS, `the converter did not connect to :${link.second.listen}`);
	const client = new Modbus_Client(null, { port: link.first.serial, baud_rate: suite_baud_rate, ...client_options });
	return { server, client };
}

function pair_title() {
	if (!link || link.second.serial) return `Modbus RTU client on ${second_name} <-> server on ${first_name}`;
	if (link.second.host) return `Modbus RTU server on ${first_name} <-> RTU-over-TCP client to ${second_name}`;
	return `Modbus RTU client on ${first_name} <-> RTU-over-TCP server on ${second_name}`;
}

describe(pair_title(), { skip }, () => {
	let memory;
	let server;
	let client;
	before(async () => {
		memory = create_memory_handler();
		({ server, client } = await start_pair(memory.handler));
		client.on('error', () => { });
		await client.connect();
	});
	after(async () => {
		await client?.disconnect();
		await server?.stop();
	});

	test('reads and writes every table', async () => {
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
	});

	test('concurrent requests are serialized', async () => {
		memory.unit(1).holding.set([10, 20, 30], 100);
		const values = await Promise.all([
			client.read('40101'), client.read('40102'), client.read('40103'),
		]);
		assert.deepEqual(values.map((v) => v.readUInt16BE(0)), [10, 20, 30]);
	});
});
