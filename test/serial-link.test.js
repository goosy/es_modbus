// Parsing of the serial-test link and of the `pnpm test:serial` command line (serial-link.js).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DEFAULT_CONVERTER_SETTLE_MS, parse_link, parse_settle, take_remote, end_name, accepts_peer,
	parse_runner_args,
} from './serial-link.js';

describe('parse_link', () => {
	test('two serial ports', () => {
		assert.deepEqual(parse_link('COM11, COM12'), { first: { serial: 'COM11' }, second: { serial: 'COM12' } });
	});

	test('a listening end, with or without a converter address', () => {
		assert.deepEqual(parse_link('COM3,:4001').second, { listen: 4001 });
		assert.deepEqual(parse_link('COM3,:502@192.168.213.254').second, { listen: 502, from: '192.168.213.254' });
		assert.deepEqual(parse_link('COM3,:502@fe80::1').second, { listen: 502, from: 'fe80::1' });
	});

	test('a remote end and a remote pool', () => {
		assert.deepEqual(parse_link('COM3,192.168.1.10:4001').second,
			{ remotes: [{ host: '192.168.1.10', port: 4001 }], next: 0 });
		assert.deepEqual(parse_link('COM3,10.0.0.1:4001 | 10.0.0.1:4002').second.remotes,
			[{ host: '10.0.0.1', port: 4001 }, { host: '10.0.0.1', port: 4002 }]);
	});

	test('invalid values throw', () => {
		for (const spec of [
			'COM3', 'COM3,', 'COM3,COM4,COM5', ':502,COM3', 'COM3,:0', 'COM3,:70000', 'COM3,:abc',
			'COM3,:502|10.0.0.1:502', 'COM3,10.0.0.1:502|:502', 'COM3,10.0.0.1:x',
			'COM3,:502@', 'COM3,:502@host.example', 'COM3,:502@1.2.3.4@5.6.7.8',
			'COM3,10.0.0.1:502@10.0.0.2',
		]) {
			assert.throws(() => parse_link(spec), /Invalid MODBUS_SERIAL_PORTS/, spec);
		}
	});
});

describe('parse_settle', () => {
	test('the default when unset', () => {
		assert.equal(parse_settle(undefined), DEFAULT_CONVERTER_SETTLE_MS);
		assert.equal(parse_settle(''), DEFAULT_CONVERTER_SETTLE_MS);
	});

	test('milliseconds as a non-negative integer', () => {
		assert.equal(parse_settle('0'), 0);
		assert.equal(parse_settle('500'), 500);
	});

	test('anything else throws', () => {
		for (const value of ['-5', '1.5', 'abc', ' 500']) {
			assert.throws(() => parse_settle(value), /Invalid MODBUS_CONVERTER_SETTLE_MS/, value);
		}
	});
});

test('take_remote cycles through the pool', () => {
	const { second } = parse_link('COM3,10.0.0.1:1|10.0.0.1:2');
	assert.deepEqual([1, 2, 3].map(() => take_remote(second).port), [1, 2, 1]);
});

test('end_name gives an end back as written', () => {
	for (const second of ['COM12', ':4001', ':502@192.168.213.254', '10.0.0.1:1|10.0.0.1:2']) {
		assert.equal(end_name(parse_link(`COM11,${second}`).second), second);
	}
});

describe('accepts_peer', () => {
	test('any address when the end names none', () => {
		assert.equal(accepts_peer({ listen: 502 }, '::ffff:10.0.0.9'), true);
	});

	test('only the named address, IPv4 also in its IPv6-mapped form', () => {
		const end = { listen: 502, from: '192.168.213.254' };
		assert.equal(accepts_peer(end, '192.168.213.254'), true);
		assert.equal(accepts_peer(end, '::ffff:192.168.213.254'), true);
		assert.equal(accepts_peer(end, '::ffff:192.168.89.2'), false);
		assert.equal(accepts_peer(end, undefined), false);
	});

	test('an IPv6 address', () => {
		assert.equal(accepts_peer({ listen: 502, from: 'fe80::1' }, 'fe80::1'), true);
		assert.equal(accepts_peer({ listen: 502, from: 'fe80::1' }, 'fe80::2'), false);
	});
});

describe('parse_runner_args', () => {
	const runs = (...args) => parse_runner_args(args)?.runs;

	test('two serial ports run both directions', () => {
		assert.deepEqual(runs('COM4', 'COM5'), ['COM4,COM5', 'COM5,COM4']);
	});

	test('a listening end first, then the remote pool as one argument', () => {
		assert.deepEqual(runs('COM4', ':502', '10.0.0.1:502,10.0.0.1:503'),
			['COM4,:502', 'COM4,10.0.0.1:502|10.0.0.1:503']);
		assert.deepEqual(runs('COM4', ':502@192.168.213.254'), ['COM4,:502@192.168.213.254']);
		assert.deepEqual(runs('COM4', '10.0.0.1:502'), ['COM4,10.0.0.1:502']);
		assert.deepEqual(runs('COM4', '10.0.0.1:502,10.0.0.1:503'), ['COM4,10.0.0.1:502|10.0.0.1:503']);
	});

	test('--settle is taken before the ends', () => {
		assert.deepEqual(parse_runner_args(['--settle', '500', 'COM4', ':502']), { settle: '500', runs: ['COM4,:502'] });
		assert.equal(parse_runner_args(['COM4', ':502']).settle, undefined);
	});

	test('arguments that fit no form are refused', () => {
		for (const args of [
			[], ['COM4'], [':502', 'COM4'], ['COM4', 'COM5', ':502'], ['COM4', 'COM5', 'COM6'],
			['COM4', '10.0.0.1:502', ':502'], ['COM4', ':502', ':503'],
			['COM4', '10.0.0.1:502', '10.0.0.1:503'], ['COM4', ':502', '10.0.0.1:502', '10.0.0.1:503'],
			['COM4', '10.0.0.1:502|10.0.0.1:503'], ['COM4', '10.0.0.1:502,,10.0.0.1:503'],
			['COM4', '10.0.0.1:502,'], ['COM4', '10.0.0.1:502,:503'],
			['COM4', ':502@not-an-ip'], ['COM4', ':99999'],
			['--settle'], ['--settle', 'abc', 'COM4', ':502'], ['--settle', '-5', 'COM4', ':502'],
			['--settle', '1', '--settle', '2', 'COM4', ':502'], ['--foo', '1', 'COM4', ':502'],
		]) {
			assert.equal(parse_runner_args(args), null, args.join(' '));
		}
	});
});
