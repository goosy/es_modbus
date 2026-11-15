// The pure parts of the serial tests (see design-test.md, "Serial tests" and "Serial test
// runner"): parsing MODBUS_SERIAL_PORTS and MODBUS_CONVERTER_SETTLE_MS for test/serial.test.js,
// and the command line of test/run-serial.js. Kept apart so `pnpm test` covers them without any
// serial hardware.
import { isIP } from 'node:net';

// How long to leave a converter that has just connected to us before writing to it, by default
// the client's default `delay` between two frame writes. MODBUS_CONVERTER_SETTLE_MS (set by
// `pnpm test:serial --settle <ms>`) raises it for a converter that resets a connection receiving
// data too soon (seen with an InHand IR315, which needs about 300 ms or more).
export const DEFAULT_CONVERTER_SETTLE_MS = 20;

const is_tcp = (end) => end.includes(':');
const is_listen = (end) => end.startsWith(':');

/**
 * Parses a listening end `:port` or `:port@address`: `{ listen: port, from }`, `from` the only
 * address whose connection is accepted, or undefined to accept any. Throws through `invalid`.
 */
function parse_listen(end, invalid) {
	const [port_text, from, ...rest] = end.slice(1).split('@');
	const port = Number(port_text);
	if (!/^\d+$/.test(port_text) || port < 1 || port > 0xffff) throw invalid(`bad TCP port in "${end}"`);
	if (rest.length > 0 || (from !== undefined && !isIP(from))) {
		throw invalid(`"${end}" must name the converter by its IP address, as ":port@address"`);
	}
	return from === undefined ? { listen: port } : { listen: port, from };
}

/**
 * Parses MODBUS_SERIAL_PORTS into `{ first, second }`. The first end is `{ serial: path }`; the
 * second is `{ serial: path }`, a listening end `{ listen: port, from? }` or a remote pool
 * `{ remotes: [{ host, port }], next }` (connect, taking the remotes in turn). Throws on an
 * invalid value.
 */
export function parse_link(spec) {
	const ends = spec.split(',').map((end) => end.trim());
	const invalid = (reason) => new Error(`Invalid MODBUS_SERIAL_PORTS "${spec}": ${reason}`);
	if (ends.length !== 2 || ends.includes('')) throw invalid('expected "<first>,<second>"');
	const [first, second] = ends;
	if (is_tcp(first)) throw invalid('the first end must be a serial port');
	if (!is_tcp(second)) return { first: { serial: first }, second: { serial: second } };
	const tcp_ends = second.split('|').map((end) => end.trim());
	if (tcp_ends.some(is_listen)) {
		if (tcp_ends.length > 1) throw invalid('a remote pool takes only "host:port" ends');
		return { first: { serial: first }, second: parse_listen(tcp_ends[0], invalid) };
	}
	const remotes = tcp_ends.map((end) => {
		const index = end.lastIndexOf(':');
		if (index < 0) throw invalid(`"${end}" is not a TCP end`);
		if (end.includes('@')) throw invalid(`"${end}": only a listening end ":port" takes "@address"`);
		const port_text = end.slice(index + 1);
		const port = Number(port_text);
		if (!/^\d+$/.test(port_text) || port < 1 || port > 0xffff) throw invalid(`bad TCP port in "${end}"`);
		return { host: end.slice(0, index), port };
	});
	return { first: { serial: first }, second: { remotes, next: 0 } };
}

/** Parses MODBUS_CONVERTER_SETTLE_MS: the default when unset; throws when not a non-negative integer. */
export function parse_settle(value) {
	if (value === undefined || value === '') return DEFAULT_CONVERTER_SETTLE_MS;
	if (!/^\d+$/.test(value)) throw new Error(`Invalid MODBUS_CONVERTER_SETTLE_MS "${value}": expected milliseconds`);
	return Number(value);
}

/** Takes the next remote of a remote pool, cycling through it. */
export function take_remote(end) {
	const remote = end.remotes[end.next % end.remotes.length];
	end.next += 1;
	return remote;
}

export const remote_name = ({ host, port }) => `${host}:${port}`;

/** The name of an end as it is written in MODBUS_SERIAL_PORTS. */
export function end_name(end) {
	if (end.serial) return end.serial;
	if (end.listen) return end.from ? `:${end.listen}@${end.from}` : `:${end.listen}`;
	return end.remotes.map(remote_name).join('|');
}

/**
 * Whether a listening end accepts a connection from `address` (a socket's `remoteAddress`): any
 * address when the end names none, else only that one. An IPv4 address mapped into IPv6
 * (`::ffff:a.b.c.d`) is taken as its IPv4 form.
 */
export function accepts_peer(end, address) {
	if (!end.from) return true;
	const plain = address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
	return plain === end.from;
}

/**
 * Parses the arguments of `pnpm test:serial`: `[--settle <ms>]` followed by `<serial> <serial>`
 * or `<serial> [:<port>[@<address>]] [<host>:<port>[,<host>:<port> ...]]`, the remote pool being
 * one argument. Returns `{ settle, runs }`, `settle` the `--settle` value as given (undefined when
 * absent) and `runs` the values of MODBUS_SERIAL_PORTS, one per run, in order; or null when the
 * arguments fit no form, an option is unknown or given twice, or a value is invalid.
 */
export function parse_runner_args(args) {
	let settle;
	let index = 0;
	while (args[index]?.startsWith('--')) {
		if (args[index] !== '--settle' || settle !== undefined) return null;
		const value = args[index + 1];
		if (!/^\d+$/.test(value ?? '')) return null;
		settle = value;
		index += 2;
	}
	const runs = expand_ends(args.slice(index));
	if (!runs) return null;
	// The runs must parse as MODBUS_SERIAL_PORTS, so a bad port or address is caught here
	try {
		for (const spec of runs) parse_link(spec);
	} catch {
		return null;
	}
	return { settle, runs };
}

/**
 * Expands the ends into the values of MODBUS_SERIAL_PORTS, one per run; null when they fit no
 * form. The remote pool, one argument with its remotes separated by `,`, becomes one end with
 * them separated by `|`.
 */
function expand_ends(ends) {
	if (ends.length < 2 || ends.length > 3 || is_tcp(ends[0])) return null;
	const [serial, ...rest] = ends;
	if (!rest.some(is_tcp)) {
		if (rest.length !== 1) return null;
		return [`${serial},${rest[0]}`, `${rest[0]},${serial}`];
	}
	if (!rest.every(is_tcp)) return null;
	// At most a listening end, then at most one pool
	const [listen, pool] = is_listen(rest[0]) ? rest : [undefined, ...rest];
	if (rest.length === 2 && (!listen || is_listen(pool))) return null;
	if (pool !== undefined && (pool.includes('|') || pool.split(',').some((remote) => !is_tcp(remote)))) return null;
	const runs = [];
	if (listen) runs.push(`${serial},${listen}`);
	if (pool !== undefined) runs.push(`${serial},${pool.split(',').join('|')}`);
	return runs;
}
