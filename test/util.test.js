import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
    TRANSACTION_START, DO_NOTHING, MAX_QUANTITY,
    modbus_crc16, parse_modicon_range, parse_pdu_range,
    parse_rtu_request, parse_rtu_response,
    parse_tcp_request, parse_tcp_response,
} from '../src/util.js';
import { hex, rtu_frame, tcp_frame } from './helpers.js';

describe('constants', () => {
    test('TRANSACTION_START is 8000', () => {
        assert.equal(TRANSACTION_START, 8000);
    });

    test('DO_NOTHING is a no-op', () => {
        assert.equal(DO_NOTHING(1, 2), undefined);
    });

    test('MAX_QUANTITY follows the protocol limits', () => {
        assert.deepEqual(MAX_QUANTITY, {
            1: 2000, 2: 2000, 3: 125, 4: 125,
            5: 1, 6: 1, 15: 1968, 16: 123,
        });
    });
});

describe('modbus_crc16', () => {
    test('initial value of an empty input is 0xFFFF', () => {
        assert.equal(modbus_crc16(Buffer.alloc(0)), 0xffff);
    });

    test('matches the CRC-16/MODBUS check value', () => {
        assert.equal(modbus_crc16(Buffer.from('123456789', 'ascii')), 0x4b37);
    });

    test('matches a well-known request frame', () => {
        // 01 03 00 00 00 02 C4 0B
        assert.equal(modbus_crc16(hex('010300000002')), 0x0bc4);
    });

    test('accepts a plain array', () => {
        assert.equal(modbus_crc16([0x01, 0x03, 0x00, 0x00, 0x00, 0x02]), 0x0bc4);
    });

    test('supports incremental computation', () => {
        const whole = hex('0110000100020400 0a0102');
        const first = modbus_crc16(whole.subarray(0, 5));
        assert.equal(modbus_crc16(whole.subarray(5), first), modbus_crc16(whole));
    });

    test('a frame with its own CRC appended yields 0', () => {
        assert.equal(modbus_crc16(rtu_frame('010300000002')), 0);
    });
});

describe('parse_modicon_range', () => {
    test('holding registers ("4")', () => {
        assert.deepEqual(parse_modicon_range('40001'), {
            type: 'holding_registers', fm_read: 3, fs_write: 6, fm_write: 16,
            pdu_addr: 0, length: undefined,
        });
    });

    test('length suffix', () => {
        assert.equal(parse_modicon_range('40001,73').length, 73);
        assert.equal(parse_modicon_range('40001,1').length, 1);
        assert.equal(parse_modicon_range('40001,9999').length, 9999);
    });

    test('coils ("0")', () => {
        assert.deepEqual(parse_modicon_range('00001,16'), {
            type: 'coils', fm_read: 1, fs_write: 5, fm_write: 15,
            pdu_addr: 0, length: 16,
        });
    });

    test('discrete inputs ("1") are read-only', () => {
        assert.deepEqual(parse_modicon_range('10002'), {
            type: 'discrete_inputs', fm_read: 2, pdu_addr: 1, length: undefined,
        });
    });

    test('input registers ("3") are read-only', () => {
        assert.deepEqual(parse_modicon_range('39999,2'), {
            type: 'input_registers', fm_read: 4, pdu_addr: 9998, length: 2,
        });
    });

    test('the 6-digit form names the same table', () => {
        assert.deepEqual(parse_modicon_range('400001,73'), parse_modicon_range('40001,73'));
        assert.equal(parse_modicon_range('465536').pdu_addr, 65535);
        assert.equal(parse_modicon_range('100001').fm_read, 2);
        assert.equal(parse_modicon_range('010000').pdu_addr, 9999);
    });

    test('1-based by default: the PDU address is point - 1', () => {
        assert.equal(parse_modicon_range('40001').pdu_addr, 0);
        assert.equal(parse_modicon_range('49999').pdu_addr, 9998);
        assert.equal(parse_modicon_range('400001').pdu_addr, 0);
        assert.equal(parse_modicon_range('465536').pdu_addr, 65535);
    });

    test('0-based: the PDU address is the point', () => {
        assert.equal(parse_modicon_range('40000', true).pdu_addr, 0);
        assert.equal(parse_modicon_range('49999', true).pdu_addr, 9999);
        assert.equal(parse_modicon_range('400000', true).pdu_addr, 0);
        assert.equal(parse_modicon_range('465535', true).pdu_addr, 65535);
    });

    test('rejects invalid input', () => {
        const invalid = [
            '20001', '50001', '90001',  // unsupported table digit
            '200001', '500001',
            '4001', '4000001',          // wrong digit count
            '40001,', '40001,12345', '40001,-1', '40001,0',
            ' 40001', '40001 ', '4000a', '',
            '40000', '400000',          // point 0 is invalid in 1-based numbering
            '465537', '499999',         // above 65536 in 1-based numbering
            40001, null, undefined, ['40001'], { address: '40001' },
        ];
        for (const value of invalid) {
            assert.equal(parse_modicon_range(value), null,
                `${JSON.stringify(value)} should be rejected`);
        }
    });

    test('rejects points out of range in 0-based numbering', () => {
        for (const value of ['465536', '499999']) {
            assert.equal(parse_modicon_range(value, true), null, value);
        }
    });
});

describe('parse_pdu_range', () => {
    test('the array and object forms are equivalent', () => {
        const expected = { type: 'holding_registers', access: 'read', func_code: 3, pdu_addr: 256, length: 2 };
        assert.deepEqual(parse_pdu_range([3, 256, 2]), expected);
        assert.deepEqual(parse_pdu_range({ func_code: 3, pdu_addr: 256, length: 2 }), expected);
    });

    test('every function code maps to its table and direction', () => {
        const tables = {
            1: ['coils', 'read'], 2: ['discrete_inputs', 'read'],
            3: ['holding_registers', 'read'], 4: ['input_registers', 'read'],
            5: ['coils', 'write'], 6: ['holding_registers', 'write'],
            15: ['coils', 'write'], 16: ['holding_registers', 'write'],
        };
        for (const [func_code, [type, access]] of Object.entries(tables)) {
            const result = parse_pdu_range([Number(func_code), 0, 1]);
            assert.deepEqual([result.type, result.access], [type, access], func_code);
        }
    });

    test('the PDU address range is inclusive', () => {
        assert.equal(parse_pdu_range([1, 0, 1]).pdu_addr, 0);
        assert.equal(parse_pdu_range([1, 65535, 1]).pdu_addr, 65535);
    });

    test('quantity limits are left to the client', () => {
        assert.equal(parse_pdu_range([16, 0, 124]).length, 124);
        assert.equal(parse_pdu_range([5, 0, 2]).length, 2);
        assert.equal(parse_pdu_range([1, 65535, 2000]).length, 2000);
    });

    test('rejects invalid input', () => {
        const invalid = [
            '40001', 3, null, undefined, [], [3, 0], [3, 0, 1, 0],
            ['3', 0, 1], [3, '0', 1], [3, 0, '1'], [true, 0, 1], [3n, 0, 1], [3, 0, 1n],
            [7, 0, 1], [0, 0, 1], [3.5, 0, 1], [Number.NaN, 0, 1],
            [3, -1, 1], [3, 65536, 1], [3, 1.5, 1], [3, 0, 0], [3, 0, 1.5],
            { func_code: 3, pdu_addr: 0 }, { pdu_addr: 0, length: 1 },
        ];
        for (const value of invalid) {
            assert.equal(parse_pdu_range(value), null, String(value));
        }
    });
});

describe('parse_rtu_request', () => {
    test('returns a single-element array', () => {
        const result = parse_rtu_request(rtu_frame('010300000002'));
        assert.ok(Array.isArray(result));
        assert.equal(result.length, 1);
    });

    for (const func_code of [1, 2, 3, 4]) {
        test(`FC ${func_code} read request`, () => {
            const body = Buffer.from([0x11, func_code, 0x00, 0x6b, 0x00, 0x03]);
            const frame = rtu_frame(body);
            const [request] = parse_rtu_request(frame);
            assert.equal(request.tid, TRANSACTION_START);
            assert.equal(request.unit_id, 0x11);
            assert.equal(request.func_code, func_code);
            assert.equal(request.start_address, 0x6b);
            assert.equal(request.quantity, 3);
            assert.equal(request.buffer, frame);
        });
    }

    test('FC 5 write single coil', () => {
        const [request] = parse_rtu_request(rtu_frame('110500acff00'));
        assert.equal(request.func_code, 5);
        assert.equal(request.start_address, 0xac);
        assert.equal(request.data, 0xff00);
    });

    test('FC 6 write single register', () => {
        const [request] = parse_rtu_request(rtu_frame('110600010003'));
        assert.equal(request.func_code, 6);
        assert.equal(request.start_address, 1);
        assert.equal(request.data, 3);
    });

    test('FC 15 write multiple coils', () => {
        const [request] = parse_rtu_request(rtu_frame('110f0013000a02cd01'));
        assert.equal(request.func_code, 15);
        assert.equal(request.start_address, 0x13);
        assert.equal(request.quantity, 10);
        assert.equal(request.byte_count, 2);
        assert.deepEqual(request.data, hex('cd01'));
    });

    test('FC 16 write multiple registers', () => {
        const [request] = parse_rtu_request(rtu_frame('1110000100020400 0a0102'));
        assert.equal(request.func_code, 16);
        assert.equal(request.start_address, 1);
        assert.equal(request.quantity, 2);
        assert.equal(request.byte_count, 4);
        assert.deepEqual(request.data, hex('000a0102'));
    });

    test('rejects a bad CRC', () => {
        const frame = rtu_frame('010300000002');
        frame[frame.length - 1] ^= 0xff;
        assert.equal(parse_rtu_request(frame)[0].func_code, 0);
    });

    test('rejects a PDU length that does not match the function code', () => {
        for (const body of ['01030000000200', '0105000000', '01060000000100', '010f0000000a02cd', '0110000000010200']) {
            assert.equal(parse_rtu_request(rtu_frame(body))[0].func_code, 0, body);
        }
    });

    test('rejects a multiple write with too short a PDU', () => {
        assert.equal(parse_rtu_request(rtu_frame('010f00000001'))[0].func_code, 0);
    });

    test('rejects unsupported function codes', () => {
        for (const func_code of [0, 7, 8, 17, 0x83]) {
            const body = Buffer.from([1, func_code, 0, 0, 0, 1]);
            assert.equal(parse_rtu_request(rtu_frame(body))[0].func_code, 0, `FC ${func_code}`);
        }
    });

    test('an unsupported function code with a valid CRC is reported as illegal_function', () => {
        assert.equal(parse_rtu_request(rtu_frame('010800000000'))[0].illegal_function, 8);
        assert.equal(parse_rtu_request(rtu_frame('012b0e01'))[0].illegal_function, 0x2b);
        assert.equal(parse_rtu_request(rtu_frame('010300000001'))[0].illegal_function, undefined);
    });

    test('no illegal_function for a bad CRC, a code 0 or a code >= 0x80', () => {
        const frame = rtu_frame('010800000000');
        frame[frame.length - 1] ^= 0xff;
        assert.equal(parse_rtu_request(frame)[0].illegal_function, undefined);
        for (const body of ['010000000001', '018300000001']) {
            assert.equal(parse_rtu_request(rtu_frame(body))[0].illegal_function, undefined, body);
        }
    });

    test('rejects a frame that is too short or too long', () => {
        assert.deepEqual(parse_rtu_request(hex('01030000')), [
            { tid: TRANSACTION_START, func_code: 0, buffer: hex('01030000') },
        ]);
        const long = Buffer.alloc(256);
        assert.equal(parse_rtu_request(long)[0].func_code, 0);
    });
});

describe('parse_rtu_response', () => {
    test('FC 3 read response', () => {
        const frame = rtu_frame('1103040001000a');
        const [response] = parse_rtu_response(frame);
        assert.equal(response.tid, TRANSACTION_START);
        assert.equal(response.unit_id, 0x11);
        assert.equal(response.func_code, 3);
        assert.equal(response.byte_count, 4);
        assert.deepEqual(response.data, hex('0001000a'));
        assert.equal(response.exception_code, undefined);
        assert.equal(response.buffer, frame);
    });

    for (const func_code of [1, 2, 4]) {
        test(`FC ${func_code} read response`, () => {
            const body = Buffer.from([0x01, func_code, 0x02, 0xcd, 0x01]);
            const [response] = parse_rtu_response(rtu_frame(body));
            assert.equal(response.func_code, func_code);
            assert.deepEqual(response.data, hex('cd01'));
        });
    }

    test('FC 5 / FC 6 echo', () => {
        const [coil] = parse_rtu_response(rtu_frame('010500acff00'));
        assert.equal(coil.func_code, 5);
        assert.equal(coil.start_address, 0xac);
        assert.equal(coil.data, 0xff00);
        const [register] = parse_rtu_response(rtu_frame('010600011234'));
        assert.equal(register.func_code, 6);
        assert.equal(register.data, 0x1234);
    });

    test('FC 15 / FC 16 echo', () => {
        const [coils] = parse_rtu_response(rtu_frame('010f0013000a'));
        assert.equal(coils.func_code, 15);
        assert.equal(coils.start_address, 0x13);
        assert.equal(coils.quantity, 10);
        const [registers] = parse_rtu_response(rtu_frame('011000010002'));
        assert.equal(registers.func_code, 16);
        assert.equal(registers.quantity, 2);
    });

    test('exception response', () => {
        const [response] = parse_rtu_response(rtu_frame('018302'));
        assert.equal(response.func_code, 0x83);
        assert.equal(response.exception_code, 2);
    });

    test('rejects an exception with the wrong length', () => {
        assert.equal(parse_rtu_response(rtu_frame('01830200'))[0].func_code, 0);
    });

    test('rejects a byte count that does not match', () => {
        assert.equal(parse_rtu_response(rtu_frame('0103040001'))[0].func_code, 0);
    });

    test('rejects a write echo with the wrong length', () => {
        assert.equal(parse_rtu_response(rtu_frame('0106000112'))[0].func_code, 0);
        assert.equal(parse_rtu_response(rtu_frame('0110000100'))[0].func_code, 0);
    });

    test('rejects a bad CRC', () => {
        const frame = rtu_frame('1103020001');
        frame[frame.length - 2] ^= 0x01;
        assert.equal(parse_rtu_response(frame)[0].func_code, 0);
    });

    test('rejects unsupported function codes', () => {
        assert.equal(parse_rtu_response(rtu_frame('01070100'))[0].func_code, 0);
    });

    test('rejects a frame that is too short', () => {
        assert.equal(parse_rtu_response(hex('0183'))[0].func_code, 0);
    });
});

describe('parse_tcp_request', () => {
    test('FC 3 read request', () => {
        const frame = tcp_frame(0x1234, '11030000000a');
        const [request] = parse_tcp_request(frame);
        assert.equal(request.tid, 0x1234);
        assert.equal(request.pid, 0);
        assert.equal(request.unit_id, 0x11);
        assert.equal(request.func_code, 3);
        assert.equal(request.start_address, 0);
        assert.equal(request.quantity, 10);
        assert.deepEqual(request.buffer, frame);
    });

    test('FC 5 / FC 6 carry the value in data', () => {
        assert.equal(parse_tcp_request(tcp_frame(1, '01050003ff00'))[0].data, 0xff00);
        assert.equal(parse_tcp_request(tcp_frame(1, '01060003abcd'))[0].data, 0xabcd);
    });

    test('FC 15 / FC 16 carry quantity, byte count and data', () => {
        const [coils] = parse_tcp_request(tcp_frame(1, '010f0013000a02cd01'));
        assert.equal(coils.quantity, 10);
        assert.equal(coils.byte_count, 2);
        assert.deepEqual(coils.data, hex('cd01'));
        const [registers] = parse_tcp_request(tcp_frame(1, '0110000100020400 0a0102'));
        assert.equal(registers.quantity, 2);
        assert.deepEqual(registers.data, hex('000a0102'));
    });

    test('splits coalesced frames', () => {
        const chunk = Buffer.concat([
            tcp_frame(1, '010300000001'),
            tcp_frame(2, '020100000008'),
            tcp_frame(3, '03060001ffff'),
        ]);
        const requests = parse_tcp_request(chunk);
        assert.deepEqual(requests.map((r) => [r.tid, r.unit_id, r.func_code]), [
            [1, 1, 3], [2, 2, 1], [3, 3, 6],
        ]);
    });

    test('a non-zero protocol ID ends the extraction', () => {
        assert.deepEqual(parse_tcp_request(tcp_frame(1, '010300000001', 1)), []);
        const chunk = Buffer.concat([tcp_frame(1, '010300000001'), tcp_frame(2, '010300000001', 7)]);
        assert.equal(parse_tcp_request(chunk).length, 1);
    });

    test('an out-of-range length field ends the extraction', () => {
        const short = tcp_frame(1, '010300000001');
        short.writeUInt16BE(2, 4);
        assert.deepEqual(parse_tcp_request(short), []);
        const long = tcp_frame(1, Buffer.alloc(254, 1));
        assert.deepEqual(parse_tcp_request(long), []);
    });

    test('an incomplete trailing frame is not returned', () => {
        const full = tcp_frame(1, '010300000001');
        assert.deepEqual(parse_tcp_request(full.subarray(0, 10)), []);
        assert.deepEqual(parse_tcp_request(full.subarray(0, 8)), []);
        const chunk = Buffer.concat([full, full.subarray(0, 10)]);
        assert.equal(parse_tcp_request(chunk).length, 1);
    });

    test('a frame with function code 0 is skipped', () => {
        const chunk = Buffer.concat([tcp_frame(1, '010000000001'), tcp_frame(2, '010300000001')]);
        const requests = parse_tcp_request(chunk);
        assert.deepEqual(requests.map((r) => r.tid), [2]);
    });

    test('a PDU length that does not match the function code yields func_code 0', () => {
        for (const body of ['01030000000100', '0105000000', '010f0000000a02cd', '010f00000001', '0110000000010200']) {
            assert.equal(parse_tcp_request(tcp_frame(1, body))[0].func_code, 0, body);
        }
    });

    test('an unsupported function code yields func_code 0', () => {
        assert.equal(parse_tcp_request(tcp_frame(1, '010800000000'))[0].func_code, 0);
    });

    test('an unsupported function code is reported as illegal_function', () => {
        assert.equal(parse_tcp_request(tcp_frame(1, '010800000000'))[0].illegal_function, 8);
        assert.equal(parse_tcp_request(tcp_frame(1, '012b0e01'))[0].illegal_function, 0x2b);
        assert.equal(parse_tcp_request(tcp_frame(1, '018300000001'))[0].illegal_function, undefined);
        assert.equal(parse_tcp_request(tcp_frame(1, '01030000000100'))[0].illegal_function, undefined);
    });
});

describe('parse_tcp_response', () => {
    test('FC 3 read response', () => {
        const [response] = parse_tcp_response(tcp_frame(0x1f41, '1103040001000a'));
        assert.equal(response.tid, 0x1f41);
        assert.equal(response.unit_id, 0x11);
        assert.equal(response.func_code, 3);
        assert.equal(response.byte_count, 4);
        assert.deepEqual(response.data, hex('0001000a'));
    });

    test('FC 1 read response', () => {
        const [response] = parse_tcp_response(tcp_frame(1, '010102cd01'));
        assert.deepEqual(response.data, hex('cd01'));
    });

    test('FC 5 / FC 6 echo', () => {
        const [coil] = parse_tcp_response(tcp_frame(1, '010500acff00'));
        assert.equal(coil.start_address, 0xac);
        assert.equal(coil.data, 0xff00);
        const [register] = parse_tcp_response(tcp_frame(1, '010600011234'));
        assert.equal(register.data, 0x1234);
    });

    test('FC 15 / FC 16 echo', () => {
        const [coils] = parse_tcp_response(tcp_frame(1, '010f0013000a'));
        assert.equal(coils.start_address, 0x13);
        assert.equal(coils.quantity, 10);
        const [registers] = parse_tcp_response(tcp_frame(1, '011000010002'));
        assert.equal(registers.quantity, 2);
    });

    test('exception response', () => {
        const [response] = parse_tcp_response(tcp_frame(5, '01830b'));
        assert.equal(response.tid, 5);
        assert.equal(response.func_code, 0x83);
        assert.equal(response.exception_code, 0x0b);
    });

    test('rejects malformed responses', () => {
        for (const body of ['0103040001', '0106000112', '0110000100', '01830200', '01070100']) {
            assert.equal(parse_tcp_response(tcp_frame(1, body))[0].func_code, 0, body);
        }
    });

    test('splits coalesced frames', () => {
        const chunk = Buffer.concat([tcp_frame(7, '0103020001'), tcp_frame(8, '0103020002')]);
        const responses = parse_tcp_response(chunk);
        assert.deepEqual(responses.map((r) => [r.tid, r.data.readUInt16BE(0)]), [[7, 1], [8, 2]]);
    });
});
