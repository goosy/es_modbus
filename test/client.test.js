import { describe, test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Modbus_Client } from '../src/ModbusClient.js';
import {
    HOST, sleep, hex, rtu_frame, tcp_frame, reply_to,
    start_fake_server, closed_port,
    create_client, connect_client, close_client,
} from './helpers.js';

/** A default slave reply for every TCP request frame in a received chunk. */
function auto_reply(chunk) {
    return split_frames([{ frame: chunk }]).map(reply_one);
}

/** A valid response to one TCP request frame, for each function code. */
function reply_one(request) {
    const unit_id = request[6];
    const func_code = request[7];
    const head = Buffer.from([unit_id, func_code]);
    switch (func_code) {
        case 1:
        case 2: {
            const count = Math.ceil(request.readUInt16BE(10) / 8);
            return reply_to(request, Buffer.concat([head, Buffer.from([count]), Buffer.alloc(count, 0xa5)]));
        }
        case 3:
        case 4: {
            const count = request.readUInt16BE(10) * 2;
            const data = Buffer.alloc(count);
            for (let i = 0; i < count / 2; i++) data.writeUInt16BE(i + 1, i * 2);
            return reply_to(request, Buffer.concat([head, Buffer.from([count]), data]));
        }
        default:
            return reply_to(request, request.subarray(6, 12));
    }
}

/** Splits every captured chunk into TCP frames using the MBAP length field. */
function split_frames(frames) {
    const result = [];
    for (const { frame } of frames) {
        let rest = frame;
        while (rest.length >= 6) {
            const size = 6 + rest.readUInt16BE(4);
            result.push(rest.subarray(0, size));
            rest = rest.subarray(size);
        }
    }
    return result;
}

const without_tid = (frame) => frame.subarray(2).toString('hex');

describe('Modbus_Client construction', () => {
    test('a string address selects TCP; rtu: true selects RTU-over-TCP', () => {
        const tcp = new Modbus_Client(HOST, { reconnect_time: 0 });
        assert.equal(tcp.protocol, 'tcp');
        const rtu = new Modbus_Client(HOST, { reconnect_time: 0, rtu: true });
        assert.equal(rtu.protocol, 'rtu_over_tcp');
    });

    test('option defaults', () => {
        const client = new Modbus_Client(HOST, { reconnect_time: 0 });
        assert.equal(client.timeout, 1000);
        assert.equal(client.delay, 20);
        assert.equal(client.is_connected, false);
        assert.equal(client.send_queue_size, 256);
        assert.equal(client.modicon_zero_based, false);
    });

    test('the Modicon numbering base cannot change after construction', () => {
        const client = new Modbus_Client(HOST, { reconnect_time: 0, modicon_zero_based: true });
        assert.equal(client.modicon_zero_based, true);
        assert.throws(() => {
            client.modicon_zero_based = false;
        }, TypeError);
        assert.equal(client.modicon_zero_based, true);
    });

    test('reconnect_time defaults to 10000 and connects at construction', async () => {
        const fake = await start_fake_server();
        const client = new Modbus_Client(HOST, { port: fake.port });
        client.on('error', () => { });
        try {
            assert.equal(client.reconnect_time, 10000);
            await once(client, 'connect');
            assert.equal(client.is_connected, true);
        } finally {
            close_client(client);
            await fake.close();
        }
    });

    test('reconnect_time 0 does not connect at construction', async () => {
        const fake = await start_fake_server();
        const client = create_client(fake.port);
        await sleep(50);
        assert.equal(client.is_connected, false);
        assert.equal(fake.sockets.size, 0);
        close_client(client);
        await fake.close();
    });
});

describe('Modbus_Client argument validation', () => {
    let client;
    beforeEach(() => {
        client = new Modbus_Client(HOST, { reconnect_time: 0 });
    });

    test('rejects invalid range strings synchronously', () => {
        for (const range of ['20001', '4001', '40001,0', '40000', 'abc', '', 40001, null, undefined]) {
            assert.throws(() => client.read(range), /Invalid range format/, String(range));
            assert.throws(() => client.write(range, 1), /Invalid range format/, String(range));
        }
    });

    test('rejects invalid unit IDs', () => {
        for (const unit_id of [-1, 256, 1.5, '1', null, NaN]) {
            assert.throws(() => client.read('40001', unit_id), /Invalid unit ID/, String(unit_id));
            assert.throws(() => client.write('40001', 1, unit_id), /Invalid unit ID/, String(unit_id));
        }
    });

    test('rejects read lengths over the protocol limit', () => {
        assert.throws(() => client.read('00001,2001'), /Invalid length 2001 for function code 1/);
        assert.throws(() => client.read('10001,2001'), /Invalid length 2001 for function code 2/);
        assert.throws(() => client.read('40001,126'), /Invalid length 126 for function code 3/);
        assert.throws(() => client.read('30001,126'), /Invalid length 126 for function code 4/);
    });

    test('a structured range over the limit gets the same message as a Modicon one', () => {
        assert.throws(() => client.read([3, 0, 126]), /Invalid length 126 for function code 3/);
        assert.throws(() => client.read([1, 0, 2001]), /Invalid length 2001 for function code 1/);
        assert.throws(() => client.write([16, 0, 124], Buffer.alloc(248)), /Invalid length 124 for function code 16/);
        assert.throws(() => client.write([15, 0, 1969], Buffer.alloc(247)), /Invalid length 1969 for function code 15/);
    });

    test('rejects a range past PDU address 65535', () => {
        assert.throws(() => client.read('465536,2'), /Range exceeds address 65535/);
        assert.throws(() => client.read([3, 65535, 2]), /Range exceeds address 65535/);
        assert.throws(() => client.read([1, 64000, 2000]), /Range exceeds address 65535/);
        assert.throws(() => client.write('465535', hex('000100020003')), /Range exceeds address 65535/);
        assert.throws(() => client.write([16, 65535, 2], hex('00010002')), /Range exceeds address 65535/);
    });

    test('a range may end at PDU address 65535', () => {
        client.on('error', () => { });
        try {
            for (const call of [
                () => client.read('465536'),
                () => client.read([3, 65534, 2]),
                () => client.write([5, 65535, 1], true),
            ]) {
                call().catch(() => { });
            }
        } finally {
            close_client(client);
        }
    });

    test('rejects write lengths over the protocol limit', () => {
        assert.throws(() => client.write('00001,1969', Buffer.alloc(247)), /function code 15/);
        assert.throws(() => client.write('40001,124', Buffer.alloc(248)), /function code 16/);
        assert.throws(() => client.write('40001', Buffer.alloc(248)), /function code 16/);
    });

    test('rejects writes to read-only tables', () => {
        assert.throws(() => client.write('10001', true), /Write operation not supported/);
        assert.throws(() => client.write('30001', 1), /Write operation not supported/);
    });

    test('rejects invalid coil values', () => {
        assert.throws(() => client.write('00001', 1), /Invalid value for coil write/);
        assert.throws(() => client.write('00001', 'on'), /Invalid value for coil write/);
        assert.throws(() => client.write('00001,2', true), /Invalid value for coil write/);
        assert.throws(() => client.write('00001', Buffer.alloc(1)), /requires a ",N" length/);
        assert.throws(() => client.write('00001,10', Buffer.alloc(1)), /Invalid buffer length for coil write/);
        assert.throws(() => client.write('00001,8', Buffer.alloc(2)), /Invalid buffer length for coil write/);
    });

    test('rejects invalid register values', () => {
        for (const value of [-1, 65536, 1.5, NaN, 'x', true, null]) {
            assert.throws(() => client.write('40001', value), /Invalid value for register write/, String(value));
        }
        assert.throws(() => client.write('40001,2', 5), /Invalid value for register write/);
        assert.throws(() => client.write('40001,3', Buffer.alloc(4)), /Invalid buffer length for register write/);
    });

    test('rejects an odd-length register Buffer as a wrong buffer length', () => {
        assert.throws(() => client.write('40001', Buffer.alloc(3)), /Invalid buffer length for register write/);
    });

    test('rejects structured ranges with invalid fields', () => {
        const invalid = [
            ['3', 0, 1], [3, '0', 1], [3, 0, '1'], [true, 0, 1], [3n, 0, 1],
            [7, 0, 1], [0, 0, 1], [3, -1, 1], [3, 65536, 1], [3, 1.5, 1],
            [3, 0, 0], [3, 0, -1], [3, 0, 1.5],
            { func_code: 3, pdu_addr: 0 }, { func_code: 3, length: 1 },
        ];
        for (const range of invalid) {
            assert.throws(() => client.read(range), /Invalid range format/,
                JSON.stringify(range, (k, v) => typeof v === 'bigint' ? `${v}n` : v));
        }
    });

    test('rejects a structured function code that does not belong to the method', () => {
        for (const func_code of [5, 6, 15, 16]) {
            assert.throws(() => client.read([func_code, 0, 1]));
        }
        for (const func_code of [1, 2, 3, 4]) {
            assert.throws(() => client.write([func_code, 0, 1], 1));
        }
        assert.throws(() => client.write([5, 0, 2], true));
        assert.throws(() => client.write([6, 0, 2], 1));
    });

    test('a structured range is checked against the value of its function code', () => {
        assert.throws(() => client.write([5, 0, 1], 1), /Invalid value for coil write/);
        assert.throws(() => client.write([15, 0, 3], true), /Invalid value for coil write/);
        assert.throws(() => client.write([15, 0, 9], Buffer.alloc(1)), /Invalid buffer length for coil write/);
        assert.throws(() => client.write([6, 0, 1], 65536), /Invalid value for register write/);
        assert.throws(() => client.write([6, 0, 1], Buffer.alloc(4)), /Invalid value for register write/);
        assert.throws(() => client.write([16, 0, 2], 5), /Invalid value for register write/);
        assert.throws(() => client.write([16, 0, 2], Buffer.alloc(2)), /Invalid buffer length for register write/);
    });

    test('a structured range does not take the Modicon type split', () => {
        assert.throws(() => client.read(['40001']), /Invalid range format/);
        assert.throws(() => client.read([3, 0, 1, 0]), /Invalid range format/);
        assert.throws(() => client.read({ func_code: 3, pdu_addr: 0, length: 1n }), /Invalid range format/);
    });
});

describe('Modbus_Client TCP framing', () => {
    let fake;
    let client;
    beforeEach(async () => {
        fake = await start_fake_server(auto_reply);
        client = await connect_client(fake.port);
    });
    afterEach(async () => {
        close_client(client);
        await fake.close();
    });

    const cases = [
        ['read coils', (c) => c.read('00001,16', 1), '000000060101 0000 0010'],
        ['read discrete inputs', (c) => c.read('10011,3', 2), '000000060202 000a 0003'],
        ['read holding registers', (c) => c.read('40001,73', 18), '000000061203 0000 0049'],
        ['read input registers', (c) => c.read('39999', 3), '000000060304 270e 0001'],
        ['read the default length 1', (c) => c.read('40100'), '000000060103 0063 0001'],
        ['read the maximum register count', (c) => c.read('40001,125'), '000000060103 0000 007d'],
        ['read the maximum coil count', (c) => c.read('00001,2000'), '000000060101 0000 07d0'],
        ['write single coil on', (c) => c.write('00173', true), '000000060105 00ac ff00'],
        ['write single coil off', (c) => c.write('00001', false, 4), '000000060405 0000 0000'],
        ['write single register', (c) => c.write('40002', 0x1234), '000000060106 0001 1234'],
        ['write single register from a 2-byte Buffer', (c) => c.write('40002', hex('abcd')), '000000060106 0001 abcd'],
        ['write single register 0 and 65535', (c) => c.write('40003', 65535), '000000060106 0002 ffff'],
        ['write multiple registers', (c) => c.write('40002', hex('000a0102')), '0000000b0110 0001 0002 04 000a0102'],
        ['write multiple registers with ,N', (c) => c.write('40002,2', hex('000a0102')), '0000000b0110 0001 0002 04 000a0102'],
        ['write multiple coils', (c) => c.write('00020,10', hex('cd01')), '00000009010f 0013 000a 02 cd01'],
    ];
    for (const [name, call, expected] of cases) {
        test(name, async () => {
            await call(client);
            const [frame] = split_frames(fake.frames);
            assert.equal(without_tid(frame), hex(expected).toString('hex'));
        });
    }

    test('unit ID 0 and 255 are accepted', async () => {
        await client.read('40001', 0);
        await client.read('40001', 255);
        const frames = split_frames(fake.frames);
        assert.deepEqual(frames.map((f) => f[6]), [0, 255]);
    });

    test('each request carries a distinct transaction ID', async () => {
        await Promise.all([client.read('40001'), client.read('40001'), client.read('40001')]);
        const tids = split_frames(fake.frames).map((f) => f.readUInt16BE(0));
        assert.equal(new Set(tids).size, 3);
    });

    test('6-digit Modicon addresses', async () => {
        await client.read('400001,2');
        await client.read('465536');
        await client.read('100001');
        const frames = split_frames(fake.frames).map(without_tid);
        assert.deepEqual(frames, [
            '000000060103' + '0000' + '0002',
            '000000060103' + 'ffff' + '0001',
            '000000060102' + '0000' + '0001',
        ]);
    });

    test('structured ranges are sent unchanged', async () => {
        await client.read([3, 256, 2]);
        await client.read({ func_code: 4, pdu_addr: 0, length: 1 });
        await client.read([1, 65535, 1]);
        await client.write([6, 0, 1], 7);
        await client.write({ func_code: 16, pdu_addr: 10, length: 1 }, hex('0102'));
        await client.write([5, 3, 1], true);
        await client.write([15, 0, 3], hex('05'));
        const frames = split_frames(fake.frames).map(without_tid);
        assert.deepEqual(frames, [
            '000000060103' + '0100' + '0002',
            '000000060104' + '0000' + '0001',
            '000000060101' + 'ffff' + '0001',
            '000000060106' + '0000' + '0007',
            '000000090110' + '000a' + '0001' + '02' + '0102',
            '000000060105' + '0003' + 'ff00',
            '00000008010f' + '0000' + '0003' + '01' + '05',
        ]);
    });
});

describe('Modbus_Client Modicon numbering base', () => {
    let fake;
    after(async () => fake?.close());
    before(async () => {
        fake = await start_fake_server(auto_reply);
    });

    test('1-based by default: point N is PDU address N - 1', async () => {
        const client = await connect_client(fake.port);
        fake.frames.length = 0;
        await client.read('40001');
        await client.read('49999');
        close_client(client);
        const frames = split_frames(fake.frames);
        assert.deepEqual(frames.map((f) => f.readUInt16BE(8)), [0, 9998]);
    });

    test('modicon_zero_based: true makes the PDU address equal to the point', async () => {
        const client = await connect_client(fake.port, { modicon_zero_based: true });
        fake.frames.length = 0;
        try {
            await client.read('40000');
            await client.read('40001');
            await client.read('49999');
            await client.read('465535');
        } finally {
            close_client(client);
        }
        const frames = split_frames(fake.frames);
        assert.deepEqual(frames.map((f) => f.readUInt16BE(8)), [0, 1, 9999, 65535]);
    });

    test('the numbering base never applies to structured ranges', async () => {
        const client = await connect_client(fake.port, { modicon_zero_based: false });
        fake.frames.length = 0;
        try {
            await client.read([3, 0, 1]);
        } finally {
            close_client(client);
        }
        assert.equal(split_frames(fake.frames)[0].readUInt16BE(8), 0);
    });
});

describe('Modbus_Client transactions', () => {
    let fake;
    let client;
    let responder;
    beforeEach(async () => {
        responder = auto_reply;
        fake = await start_fake_server((frame, socket) => responder(frame, socket));
        client = await connect_client(fake.port);
    });
    afterEach(async () => {
        close_client(client);
        await fake.close();
    });

    test('read resolves with the raw payload bytes', async () => {
        responder = (request) => reply_to(request, '0103041234abcd');
        assert.deepEqual(await client.read('40001,2'), hex('1234abcd'));
    });

    test('read of coils resolves with packed bytes', async () => {
        responder = (request) => reply_to(request, '010102cd01');
        assert.deepEqual(await client.read('00001,10'), hex('cd01'));
    });

    test('write resolves with true when the echo matches the request', async () => {
        assert.equal(await client.write('40001', 1), true);
        assert.equal(await client.write('00001', true), true);
        assert.equal(await client.write('00001', false), true);
        assert.equal(await client.write('40001', hex('00010002')), true);
        assert.equal(await client.write('00001,3', hex('07')), true);
        assert.equal(await client.write([6, 9, 1], 7, 5), true);
    });

    test('write resolves with false when the echo does not match', async () => {
        const echo = (body) => (request) => reply_to(request, body);
        const cases = [
            ['address', () => client.write('40001', 1), '010600010001'],
            ['value', () => client.write('40001', 1), '010600000002'],
            ['coil value', () => client.write('00001', true), '010500000000'],
            ['quantity', () => client.write('40001', hex('00010002')), '011000000001'],
            ['coil quantity', () => client.write('00001,3', hex('07')), '010f00000004'],
            ['function code', () => client.write('40001', hex('0001')), '011000000001'],
            ['unit ID', () => client.write('40001', 1), '020600000001'],
        ];
        for (const [name, call, body] of cases) {
            responder = echo(body);
            assert.equal(await call(), false, name);
        }
    });

    test('a write emits data with its result', async () => {
        const data = [];
        client.on('data', (value) => data.push(value));
        await client.write('40001', 1);
        responder = (request) => reply_to(request, '010600000002');
        await client.write('40001', 1);
        assert.deepEqual(data, [true, false]);
    });

    test('an exception response rejects with "response error: <code>"', async () => {
        responder = (request) => reply_to(request, '018302');
        const data_error = once(client, 'data_error');
        await assert.rejects(client.read('40001'), (reason) => {
            assert.equal(String(reason), 'response error: 2');
            return true;
        });
        await data_error;
    });

    test('a timeout rejects with the transaction ID and emits timeout', async () => {
        responder = () => undefined;
        client.timeout = 100;
        const timeout = once(client, 'timeout');
        const started = performance.now();
        await assert.rejects(client.read('40001'), (reason) => {
            const tid = split_frames(fake.frames)[0].readUInt16BE(0);
            assert.match(String(reason), new RegExp(`0x${tid.toString(16)}`));
            return true;
        });
        assert.ok(performance.now() - started >= 90);
        await timeout;
    });

    test('a late response after the timeout is discarded', async () => {
        let late;
        responder = (request) => {
            late = request;
        };
        client.timeout = 50;
        await assert.rejects(client.read('40001'));
        let data_events = 0;
        client.on('data', () => data_events++);
        fake.sockets.values().next().value.write(reply_to(late, '0103020001'));
        await sleep(50);
        assert.equal(data_events, 0);
    });

    test('responses are matched by transaction ID, in any order', async () => {
        const pending = [];
        responder = (request) => {
            for (const frame of split_frames([{ frame: request }])) pending.push(frame);
        };
        const results = Promise.all([
            client.read('40001', 1), client.read('40001', 2), client.read('40001', 3),
        ]);
        while (pending.length < 3) await sleep(5);
        const socket = fake.sockets.values().next().value;
        for (const request of pending.reverse()) {
            const unit_id = request[6];
            socket.write(reply_to(request, Buffer.from([unit_id, 3, 2, 0, unit_id])));
        }
        const values = (await results).map((data) => data.readUInt16BE(0));
        assert.deepEqual(values, [1, 2, 3]);
    });

    test('coalesced responses in one chunk all resolve', async () => {
        const pending = [];
        responder = (request) => {
            for (const frame of split_frames([{ frame: request }])) pending.push(frame);
            if (pending.length < 2) return undefined;
            return Buffer.concat(pending.map((r, i) => reply_to(r, Buffer.from([1, 3, 2, 0, i]))));
        };
        const values = await Promise.all([client.read('40001'), client.read('40002')]);
        assert.deepEqual(values.map((d) => d.readUInt16BE(0)), [0, 1]);
    });

    test('a response with an unknown transaction ID is ignored', async () => {
        responder = (request) => [
            tcp_frame(request.readUInt16BE(0) ^ 0x8000, '0103020063'),
            reply_to(request, '0103020001'),
        ];
        assert.deepEqual(await client.read('40001'), hex('0001'));
    });

    test('a malformed response is ignored', async () => {
        responder = (request) => reply_to(request, '01030400');
        client.timeout = 100;
        await assert.rejects(client.read('40001'), /timeout/);
    });

    test('send, receive and data events', async () => {
        const sent = [];
        const received = [];
        const data = [];
        client.on('send', (buffer) => sent.push(buffer));
        client.on('receive', (buffer) => received.push(buffer));
        client.on('data', (value) => data.push(value));
        responder = (request) => reply_to(request, '0103020007');
        await client.read('40001');
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0], split_frames(fake.frames)[0]);
        assert.equal(received.length, 1);
        assert.equal(without_tid(received[0]), '000000050103020007');
        assert.deepEqual(data, [hex('0007')]);
    });

    test('frames are written at least delay ms apart', async () => {
        client.delay = 60;
        const times = [];
        client.on('send', () => times.push(performance.now()));
        await Promise.all([client.read('40001'), client.read('40002'), client.read('40003')]);
        assert.equal(times.length, 3);
        assert.ok(times[1] - times[0] >= 55, `gap ${times[1] - times[0]}`);
        assert.ok(times[2] - times[1] >= 55, `gap ${times[2] - times[1]}`);
    });

    test('the oldest queued frames are dropped on queue overflow', async () => {
        client.delay = 100;
        client.timeout = 400;
        client.send_queue_size = 2;
        const results = await Promise.allSettled([
            client.read('40001'), client.read('40002'), client.read('40003'), client.read('40004'),
        ]);
        assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
        const addresses = split_frames(fake.frames).map((f) => f.readUInt16BE(8));
        assert.deepEqual(addresses, [0, 2, 3]);
    });

    test('many concurrent requests', async () => {
        client.timeout = 5000;
        const reads = [];
        for (let i = 0; i < 100; i++) reads.push(client.read(`4${String(i + 1).padStart(4, '0')},2`));
        const values = await Promise.all(reads);
        assert.equal(values.length, 100);
        for (const value of values) assert.deepEqual(value, hex('00010002'));
    });
});

describe('Modbus_Client connection', () => {
    test('connect() resolves, and resolves again when already connected', async () => {
        const fake = await start_fake_server();
        const client = create_client(fake.port);
        const connected = once(client, 'connect');
        await client.connect();
        await connected;
        assert.equal(client.is_connected, true);
        await client.connect();
        close_client(client);
        await fake.close();
    });

    test('connect() rejects with the socket error when nothing listens', async () => {
        const client = create_client(await closed_port());
        await assert.rejects(client.connect(), { code: 'ECONNREFUSED' });
        close_client(client);
    });

    test('the first request connects on demand', async () => {
        const fake = await start_fake_server(auto_reply);
        const client = create_client(fake.port);
        assert.deepEqual(await client.read('40001'), hex('0001'));
        close_client(client);
        await fake.close();
    });

    test('disconnect() closes the transport and emits disconnect', async () => {
        const fake = await start_fake_server();
        const client = await connect_client(fake.port);
        const disconnected = once(client, 'disconnect');
        client.disconnect();
        await disconnected;
        assert.equal(client.is_connected, false);
        close_client(client);
        await fake.close();
    });

    test('connect() rejects with ERR_ILLEGAL_STATE during a reconnect back-off', async () => {
        const client = create_client(await closed_port(), { reconnect_time: 200 });
        await assert.rejects(client.connect());
        await assert.rejects(client.connect(), { message: 'ERR_ILLEGAL_STATE' });
        close_client(client);
    });

    test('a send during a reconnect back-off emits error', async () => {
        const client = create_client(await closed_port(), { reconnect_time: 200, timeout: 50 });
        await assert.rejects(client.connect());
        const error = once(client, 'error');
        const pending = client.read('40001');
        await error;
        await assert.rejects(pending);
        close_client(client);
    });

    test('reconnects after reconnect_time when the connection is lost', async () => {
        const fake = await start_fake_server(auto_reply);
        const client = await connect_client(fake.port, { reconnect_time: 100 });
        const disconnected = once(client, 'disconnect');
        for (const socket of fake.sockets) socket.destroy();
        await disconnected;
        const started = performance.now();
        await once(client, 'connect');
        assert.ok(performance.now() - started >= 90);
        assert.deepEqual(await client.read('40001'), hex('0001'));
        close_client(client);
        await fake.close();
    });

    test('connection loss rejects pending requests with "connection lost"', async () => {
        const fake = await start_fake_server();
        const client = await connect_client(fake.port, { timeout: 2000 });
        const pending = client.read('40001');
        await sleep(30);
        const started = performance.now();
        for (const socket of fake.sockets) socket.destroy();
        try {
            await assert.rejects(pending, { message: 'connection lost' });
            assert.ok(performance.now() - started < 500);
        } finally {
            close_client(client);
            await fake.close();
        }
    });

    test('connection loss rejects queued requests and discards their frames', async () => {
        const fake = await start_fake_server();
        const client = await connect_client(fake.port, { timeout: 2000, delay: 200 });
        const sent = client.read('40001');
        const queued = client.read('40002');
        await sleep(30);
        assert.equal(client.send_queue.length, 1);
        for (const socket of fake.sockets) socket.destroy();
        try {
            await assert.rejects(sent, { message: 'connection lost' });
            await assert.rejects(queued, { message: 'connection lost' });
            assert.equal(client.send_queue.length, 0);
        } finally {
            close_client(client);
            await fake.close();
        }
    });

    test('a failed on-demand connect rejects the request with "connection lost"', async () => {
        const client = create_client(await closed_port(), { timeout: 2000 });
        const started = performance.now();
        try {
            await assert.rejects(client.read('40001'), { message: 'connection lost' });
            assert.ok(performance.now() - started < 500);
        } finally {
            close_client(client);
        }
    });

    test('a request during a reconnect back-off is rejected at once', async () => {
        const client = create_client(await closed_port(), { reconnect_time: 300, timeout: 2000 });
        await assert.rejects(client.connect());
        const started = performance.now();
        try {
            await assert.rejects(client.read('40001'), { message: 'connection lost' });
            assert.ok(performance.now() - started < 100);
        } finally {
            close_client(client);
        }
    });

    test('a request during a back-off does not throw without an error listener', async () => {
        const client = create_client(await closed_port(), { reconnect_time: 300, timeout: 2000 });
        await assert.rejects(client.connect());
        const listeners = client.listeners('error');
        client.removeAllListeners('error');
        try {
            let pending;
            assert.doesNotThrow(() => {
                pending = client.write('40001', 1);
            });
            await assert.rejects(pending, { message: 'connection lost' });
        } finally {
            for (const listener of listeners) client.on('error', listener);
            close_client(client);
        }
    });

    test('a request that failed during a back-off is not sent later', async () => {
        const fake = await start_fake_server(auto_reply);
        const client = await connect_client(fake.port, { reconnect_time: 150, timeout: 50 });
        for (const socket of fake.sockets) socket.destroy();
        await once(client, 'disconnect');
        await assert.rejects(client.write('40001', 99));
        await once(client, 'connect');
        fake.frames.length = 0;
        await client.read('40002');
        try {
            const addresses = split_frames(fake.frames).map((f) => f.readUInt16BE(8));
            assert.deepEqual(addresses, [1]);
        } finally {
            close_client(client);
            await fake.close();
        }
    });
});

describe('Modbus_Client RTU-over-TCP', () => {
    let fake;
    let client;
    let responder;
    beforeEach(async () => {
        responder = () => undefined;
        fake = await start_fake_server((frame) => responder(frame));
        client = await connect_client(fake.port, { rtu: true });
    });
    afterEach(async () => {
        close_client(client);
        await fake.close();
    });

    test('requests are RTU frames with a CRC and no MBAP', async () => {
        client.timeout = 50;
        await Promise.allSettled([client.read('40001,73', 18)]);
        await Promise.allSettled([client.write('00173', true, 0x11)]);
        await Promise.allSettled([client.write('40002', hex('000a0102'), 0x11)]);
        await Promise.allSettled([client.write('00020,10', hex('cd01'), 0x11)]);
        assert.deepEqual(fake.frames.map((f) => f.frame.toString('hex')), [
            rtu_frame('120300000049'),
            rtu_frame('110500acff00'),
            rtu_frame('11100001000204000a0102'),
            rtu_frame('110f0013000a02cd01'),
        ].map((b) => b.toString('hex')));
    });

    test('resolves with the payload of an RTU response', async () => {
        responder = () => rtu_frame('0103041234abcd');
        assert.deepEqual(await client.read('40001,2'), hex('1234abcd'));
    });

    test('a broadcast write resolves with true once sent, without waiting for a response', async () => {
        client.timeout = 2000;
        const started = performance.now();
        assert.equal(await client.write('40001', 7, 0), true);
        assert.equal(await client.write('00001,3', hex('05'), 0), true);
        assert.ok(performance.now() - started < 500);
        const received = () => Buffer.concat(fake.frames.map((f) => f.frame));
        while (received().length < 18) await sleep(5);
        assert.equal(received().toString('hex'),
            Buffer.concat([rtu_frame('000600000007'), rtu_frame('000f0000000301 05')]).toString('hex'));
    });

    test('a broadcast read resolves with an empty Buffer once sent', async () => {
        client.timeout = 2000;
        const started = performance.now();
        assert.deepEqual(await client.read('40001,2', 0), Buffer.alloc(0));
        assert.ok(performance.now() - started < 500);
    });

    test('a broadcast write still rejects if the connection is lost before it is sent', async () => {
        client.delay = 200;
        client.timeout = 2000;
        client.read('40001').catch(() => { });
        const broadcast = client.write('40001', 7, 0);
        await sleep(20);
        for (const socket of fake.sockets) socket.destroy();
        await assert.rejects(broadcast, { message: 'connection lost' });
    });

    test('a write resolves with the result of the echo check', async () => {
        responder = (frame) => frame;
        assert.equal(await client.write('40002', 0x1234), true);
        responder = () => rtu_frame('010600010000');
        assert.equal(await client.write('40002', 0x1234), false);
    });

    test('rejects on an RTU exception response', async () => {
        responder = () => rtu_frame('018302');
        await assert.rejects(client.read('40001'), (reason) => String(reason) === 'response error: 2');
    });

    test('ignores a response with a bad CRC', async () => {
        responder = () => {
            const frame = rtu_frame('0103020001');
            frame[frame.length - 1] ^= 0xff;
            return frame;
        };
        client.timeout = 100;
        await assert.rejects(client.read('40001'), /timeout/);
    });

    test('only one request is outstanding at a time', { todo: 'design.md RTU / serial: fixed transaction ID' }, async () => {
        const answered = [];
        responder = (frame) => {
            setTimeout(() => {
                answered.push(performance.now());
                for (const socket of fake.sockets) socket.write(rtu_frame(Buffer.from([1, 3, 2, 0, frame[3] + 1])));
            }, 50);
        };
        const values = await Promise.all([client.read('40001'), client.read('40002')]);
        assert.deepEqual(values.map((d) => d.readUInt16BE(0)), [1, 2]);
        assert.ok(fake.frames[1].time >= answered[0], 'the second request was sent before the first was answered');
    });
});
