import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { select_transport, check_applicable, parse_host_port } from '../src/transport.js';

describe('parse_host_port', () => {
	test('parses a host with an optional port, 502 by default', () => {
		const cases = [
			['10.0.0.5', '10.0.0.5', 502],
			['10.0.0.5:1502', '10.0.0.5', 1502],
			['plc1:65535', 'plc1', 65535],
			['gateway:1', 'gateway', 1],
			['host:0502', 'host', 502],
		];
		for (const [target, host, port] of cases) {
			assert.deepEqual(parse_host_port(target, false), { host, port }, target);
		}
	});

	test('a bracketed host is IPv6; more than one unbracketed colon is a bare IPv6 address', () => {
		const cases = [
			['[::1]:1502', '::1', 1502],
			['[::1]', '::1', 502],
			['[fe80::1%eth0]:502', 'fe80::1%eth0', 502],
			['::1', '::1', 502],
			['fe80::1', 'fe80::1', 502],
		];
		for (const [target, host, port] of cases) {
			assert.deepEqual(parse_host_port(target, false), { host, port }, target);
		}
	});

	test('an empty host binds 0.0.0.0 on a server and is invalid on a client', () => {
		assert.deepEqual(parse_host_port(':1502', true), { host: '0.0.0.0', port: 1502 });
		assert.deepEqual(parse_host_port('', true), { host: '0.0.0.0', port: 502 });
		for (const target of [':1502', '']) {
			assert.throws(() => parse_host_port(target, false), /Invalid host/, target);
		}
	});

	test('anything else throws Invalid host', () => {
		const targets = [
			'h:0', 'h:65536', 'h:', 'h:12a', 'h:-1', 'h: 502', 'h:1e3',
			'[::1', '[]', '[]:502', '[::1]:', '[::1]x', '[::1]:x',
			502, null, undefined, {}, ['h'],
		];
		for (const target of targets) {
			assert.throws(() => parse_host_port(target, true), /Invalid host/, String(target));
		}
	});
});

describe('select_transport and check_applicable', () => {
	test('select_transport returns the one given transport option and its target', () => {
		assert.deepEqual(select_transport({ tcp: 'h', timeout: 1 }), { transport: 'tcp', target: 'h' });
		assert.deepEqual(select_transport({ serial: '', tcp: null }), { transport: 'serial', target: '' });
		for (const options of [{}, { tcp: undefined }, { tcp: 'h', serial: 'COM9' }]) {
			assert.throws(() => select_transport(options), /Exactly one of tcp, rtu_over_tcp, serial must be given/);
		}
	});

	test('check_applicable throws for a given option excluded from the transport', () => {
		const exclusions = [[['a', 'b'], ['tcp']], [['c'], ['serial']]];
		assert.throws(() => check_applicable({ b: 0 }, 'tcp', exclusions), /Option b does not apply to tcp/);
		assert.doesNotThrow(() => check_applicable({ a: null, c: 1 }, 'tcp', exclusions));
		assert.doesNotThrow(() => check_applicable({ a: 1 }, 'serial', exclusions.slice(0, 1)));
	});
});
