// The transport options, each naming a transport; exactly one is given
const TRANSPORTS = ['tcp', 'rtu_over_tcp', 'serial'];

// The port of a `host:port` target that omits it
const DEFAULT_TCP_PORT = 502;

// The host a server binds when its target leaves the host empty
const ANY_HOST = '0.0.0.0';

// The serial line options, which apply to the `serial` transport only
export const SERIAL_OPTIONS = ['baud_rate', 'parity', 'data_bits', 'stop_bits'];

/**
 * Selects the transport from the transport options (see spec-protocol.md, "Transport options").
 * An option whose value is nullish counts as not given.
 *
 * @param {Object} options - the constructor options.
 * @returns {{ transport: 'tcp'|'rtu_over_tcp'|'serial', target: * }}
 * @throws {Error} unless exactly one transport option is given.
 */
export function select_transport(options) {
	const given = TRANSPORTS.filter((transport) => options[transport] != null);
	if (given.length !== 1) {
		throw new Error(`Exactly one of ${TRANSPORTS.join(', ')} must be given`);
	}
	const [transport] = given;
	return { transport, target: options[transport] };
}

/**
 * Throws `Option <name> does not apply to <transport>` for the first given option whose
 * excluded transports include `transport`.
 *
 * @param {Object} options - the constructor options.
 * @param {string} transport - the selected transport.
 * @param {Array<[string[], string[]]>} exclusions - pairs of option names and the transports
 *   they do not apply to.
 */
export function check_applicable(options, transport, exclusions) {
	for (const [names, transports] of exclusions) {
		if (!transports.includes(transport)) continue;
		for (const name of names) {
			if (options[name] != null) throw new Error(`Option ${name} does not apply to ${transport}`);
		}
	}
}

/**
 * Parses a `host:port` target (see spec-protocol.md, "`host:port` target"). A bracketed host is
 * an IPv6 address; an unbracketed target with more than one `:` is a bare IPv6 address.
 *
 * @param {*} target - the value of the `tcp` or `rtu_over_tcp` option.
 * @param {boolean} server - whether an empty host is allowed, binding 0.0.0.0.
 * @returns {{ host: string, port: number }}
 * @throws {Error} `Invalid host: <target>` on anything else.
 */
export function parse_host_port(target, server) {
	const invalid = () => new Error(`Invalid host: ${target}`);
	if (typeof target !== 'string') throw invalid();

	let host = target;
	let port_text;
	if (target.startsWith('[')) {
		const match = /^\[([^\]]+)\](?::(.*))?$/.exec(target);
		if (!match) throw invalid();
		[, host, port_text] = match;
	} else {
		const colon = target.indexOf(':');
		// More than one `:` is a bare IPv6 address, with the default port
		if (colon !== -1 && colon === target.lastIndexOf(':')) {
			host = target.slice(0, colon);
			port_text = target.slice(colon + 1);
		}
	}

	let port = DEFAULT_TCP_PORT;
	if (port_text !== undefined) {
		if (!/^\d+$/.test(port_text)) throw invalid();
		port = Number(port_text);
		if (port < 1 || port > 0xFFFF) throw invalid();
	}
	if (host === '') {
		if (!server) throw invalid();
		host = ANY_HOST;
	}
	return { host, port };
}
