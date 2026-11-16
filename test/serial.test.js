// End-to-end Modbus RTU over a serial link (see design-test.md, "Serial tests").
//
// MODBUS_SERIAL_PORTS sets the two ends of the link; when it is unset the suites are skipped.
// "<serial>,<serial>": both ends are serial ports linked like a null-modem cable.
// "<serial>,<local-udp-port>[,<remote-address>:<remote-port>]": a serial port wired to a
// transparent serial-to-UDP converter that sends the serial data to the local UDP port; the tests
// speak RTU-over-UDP there. The converter's address and port are learned from what it sends,
// unless they are given. With two serial ports a baud-rate sweep runs first, and the suites run
// at 9600 baud, or at the first rate that worked when 9600 did not. A link that is set but cannot
// be used fails the run.
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createSocket } from 'node:dgram';
import { SerialPort } from 'serialport-rs';
import { Modbus_Client } from '../src/ModbusClient.js';
import { Modbus_Server } from '../src/ModbusServer.js';
import { sleep, hex, rtu_frame, collect, create_memory_handler, parse_link } from './helpers.js';

// The default settings of every suite: 9600 8N1, the usual Modbus default
const DEFAULT_BAUD_RATE = 9600;
const SWEEP_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
// The baud rate of the suites: the default, unless the sweep shows it does not work on the link
let suite_baud_rate = DEFAULT_BAUD_RATE;
// The bytes the pre-check passes through a converter, each way: a read request no one answers
const PROBE = rtu_frame('010300000001');
// How long a raw peer waits for bytes that are due: a converter may hold serial bytes for
// hundreds of ms before it sends them (seen: about 400 ms a round trip). Bytes that arrive
// sooner end the wait, so a fast link pays nothing.
const RESPONSE_WAIT_MS = 1000;
// A serial port just closed may refuse to re-open for a few tens of ms (seen with a CH340
// driver), so opening a serial port is retried at this interval up to this limit
const OPEN_RETRY_INTERVAL_MS = 20;
const OPEN_RETRY_LIMIT_MS = 500;
// The pause between stop() and start() in the restart test, for the same driver timing
const RESTART_PAUSE_MS = 100;

const with_timeout = (promise, ms, message) => {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Opens a serial port by calling `open` until it resolves. A failure is retried every
 * OPEN_RETRY_INTERVAL_MS; once OPEN_RETRY_LIMIT_MS have passed, the last error is thrown, so a
 * port that is really in use still fails.
 */
async function retry_open(open) {
	const deadline = Date.now() + OPEN_RETRY_LIMIT_MS;
	for (;;) {
		try {
			return await open();
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await sleep(OPEN_RETRY_INTERVAL_MS);
		}
	}
}

const open_port = (port) => retry_open(() => new Promise((resolve, reject) => {
	port.open((error) => (error ? reject(error) : resolve()));
}));
const close_port = (port) => new Promise((resolve) => {
	if (!port?.isOpen) return resolve();
	port.close(() => resolve());
});
const new_port = (path, baud_rate = suite_baud_rate) => new SerialPort({ path, baudRate: baud_rate, autoOpen: false });

/**
 * The UDP end of the link as a raw stream: a socket bound to the local port, with write() and
 * `data` events like a serial port. Datagrams go to the end's remote. Until the remote is known
 * every datagram is taken; then only those from its address, and from its port unless the end's
 * `any_port`. `source` is the sender of the last datagram taken.
 */
class Udp_End extends EventEmitter {
	source = null;
	#end;
	#socket;

	constructor(end) {
		super();
		this.#end = end;
		this.#socket = createSocket('udp4');
		this.#socket.on('error', () => { });
		this.#socket.on('message', (bytes, source) => {
			const { remote } = end;
			if (remote && (source.address !== remote.host || (!end.any_port && source.port !== remote.port))) return;
			this.source = source;
			this.emit('data', bytes);
		});
	}

	async open() {
		// A port in use makes the socket emit `error`, which rejects this
		const bound = once(this.#socket, 'listening');
		this.#socket.bind(this.#end.udp);
		await bound;
	}

	write(buffer, callback) {
		const { host, port } = this.#end.remote;
		this.#socket.send(buffer, port, host, callback);
	}

	close() {
		return new Promise((resolve) => this.#socket.close(resolve));
	}
}

/** Opens a raw stream on an end of the link: a serial port, or the local UDP port. */
async function open_end(end, baud_rate = suite_baud_rate) {
	if (end.serial) {
		const port = new_port(end.serial, baud_rate);
		await open_port(port);
		return port;
	}
	const udp_end = new Udp_End(end);
	await udp_end.open();
	return udp_end;
}

/** Closes a raw stream opened by open_end(). */
const close_end = (stream) => (stream instanceof SerialPort ? close_port(stream) : stream.close());

/** Writes on a raw stream and waits until the bytes have left it. */
async function send(stream, buffer) {
	await new Promise((resolve, reject) => stream.write(buffer, (error) => (error ? reject(error) : resolve())));
	if (stream instanceof SerialPort) await new Promise((resolve) => stream.drain(resolve));
}

/** Writes a request on a raw stream and collects up to `length` response bytes. */
async function exchange(stream, request, length, ms = RESPONSE_WAIT_MS) {
	const response = collect(stream, length, ms);
	stream.write(typeof request === 'string' ? rtu_frame(request) : request);
	return response;
}

/** Starts a Modbus_Server on a serial port. */
async function start_serial_server(handler, path, options = {}) {
	const server = new Modbus_Server(handler, { serial: path, baud_rate: suite_baud_rate, ...options });
	server.on('error', () => { });
	await retry_open(() => server.start());
	return server;
}

/** Sends the probe into `from` and checks that it comes out of `to`; throws `message()` when not. */
async function pass_probe(from, to, message) {
	const received = collect(to, PROBE.length, RESPONSE_WAIT_MS);
	await send(from, PROBE);
	const bytes = await received;
	if (!bytes.equals(PROBE)) throw new Error(`${message()} (received ${bytes.toString('hex') || 'nothing'})`);
}

/**
 * Opens both ends of the link once; throws the reason when an end cannot be used. With a UDP end
 * the probe goes through the converter each way: first from the serial port, which tells where
 * the converter sends from (the end's `remote` when none was given, and its `source_port`).
 */
async function check_link({ first, second }) {
	const port = await open_end(first);
	let peer;
	try {
		peer = await open_end(second);
		if (second.serial) return;
		const converter = second.remote ? `the converter at ${second.remote.host}` : 'a converter';
		await pass_probe(port, peer, () => `${first.serial} did not reach UDP port ${second.udp} through ${converter}`);
		second.source_port = peer.source.port;
		second.remote ??= { host: peer.source.address, port: peer.source.port };
		const hint = second.any_port ? '' : '; if it receives on another port than it sends from, give its address and port';
		await pass_probe(peer, port, () => `${second.remote.host}:${second.remote.port} did not reach ${first.serial}${hint}`);
	} finally {
		if (peer) await close_end(peer);
		await close_end(port);
	}
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

const end_name = (end) => end.serial ?? `UDP port ${end.udp}`;
const first_name = link ? end_name(link.first) : 'first end';
const second_name = link ? end_name(link.second) : 'second end';

test(link_spec ? `serial link ${link_spec} can be used` : 'serial link can be used', { skip: !link_spec && skip }, () => {
	if (link_error) assert.fail(link_error);
});

test('baud-rate sweep', { skip: (!sweep && (skip || 'the link has a UDP end')) }, (t) => {
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
		// exchange() has already waited for the response, so the events are due by now; a link
		// that lost the request must fail the test, not hang the run
		const [receive_frame] = await with_timeout(received, 500, 'no receive event');
		const [send_frame] = await with_timeout(sent, 500, 'no send event');
		assert.equal(as_hex(receive_frame), as_hex(rtu_frame('010300000001')));
		assert.equal(as_hex(send_frame), as_hex(rtu_frame('0103020000')));
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
		const response = collect(peer, 7, RESPONSE_WAIT_MS);
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
		// The test is about stop() and start(), not about how soon a driver can re-open a port
		await sleep(RESTART_PAUSE_MS);
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
		client = new Modbus_Client({ serial: path, baud_rate: suite_baud_rate, timeout: 1000, reconnect_time: 0 });
		client.on('error', () => { });
		await retry_open(() => client.connect());
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
		const request = await collect(slave, request_length, RESPONSE_WAIT_MS);
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

const CLIENT_OPTIONS = { timeout: 1000, reconnect_time: 0 };
const serial_client = (path) => new Modbus_Client({ serial: path, baud_rate: suite_baud_rate, ...CLIENT_OPTIONS });

/**
 * The pairs of the two classes on the link, each `{ title, skip, start_server(handler),
 * make_client() }`: `start_server` resolves with a running server, `make_client` returns a client
 * not yet connected. With two serial ports: the server on the first, the client on the second.
 * With a UDP end the serial port takes each class in turn and its RTU-over-UDP counterpart the
 * UDP end. An RTU-over-UDP server answers to the port a request came from, so that pair is
 * skipped for a converter that receives on another port.
 */
function pairs() {
	if (skip) return [{ title: 'Modbus RTU client <-> server', skip }];
	const { first, second } = link;
	if (second.serial) {
		return [{
			title: `Modbus RTU client on ${second_name} <-> server on ${first_name}`,
			start_server: (handler) => start_serial_server(handler, first.serial),
			make_client: () => serial_client(second.serial),
		}];
	}
	return [{
		title: `Modbus RTU server on ${first_name} <-> RTU-over-UDP client on ${second_name}`,
		start_server: (handler) => start_serial_server(handler, first.serial),
		make_client: () => new Modbus_Client({
			rtu_over_udp: `${second.remote.host}:${second.remote.port}`, local: `:${second.udp}`,
			any_source_port: second.any_port, ...CLIENT_OPTIONS,
		}),
	}, {
		title: `Modbus RTU client on ${first_name} <-> RTU-over-UDP server on ${second_name}`,
		skip: second.source_port !== second.remote.port
			&& `the converter sends from port ${second.source_port} and receives on ${second.remote.port}`,
		start_server: async (handler) => {
			const server = new Modbus_Server(handler, { rtu_over_udp: `:${second.udp}` });
			server.on('error', () => { });
			await server.start();
			return server;
		},
		make_client: () => serial_client(first.serial),
	}];
}

pairs().forEach((pair) => describe(pair.title, { skip: pair.skip }, () => {
	let memory;
	let server;
	let client;
	before(async () => {
		memory = create_memory_handler();
		server = await pair.start_server(memory.handler);
		client = pair.make_client();
		client.on('error', () => { });
		// A serial port just closed by the suite before may not open at once
		await retry_open(() => client.connect());
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
}));
