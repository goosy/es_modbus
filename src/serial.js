// Numeric parity codes: 0 = none, 1 = odd, 2 = even
const PARITY_NAMES = ['none', 'odd', 'even'];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 1.5, 2];

function parity_name(parity) {
	if (PARITY_NAMES.includes(parity)) return parity;
	if (Number.isInteger(parity) && PARITY_NAMES[parity] !== undefined) return PARITY_NAMES[parity];
	throw new Error(`Invalid parity: ${parity}`);
}

/**
 * Validates the flat snake_case serial options and converts them to the settings of a
 * serialport stream. Throws on an invalid option, so a constructor fails at once.
 *
 * @param {Object} options
 * @param {string} options.port - the serial device path, such as 'COM3' or '/dev/ttyUSB0'.
 * @param {number} [options.baud_rate=9600]
 * @param {'none'|'odd'|'even'|0|1|2} [options.parity='none'] - 0 = none, 1 = odd, 2 = even.
 * @param {number} [options.data_bits=8] - 5, 6, 7 or 8.
 * @param {number} [options.stop_bits=1] - 1, 1.5 or 2.
 * @returns {{ path: string, baudRate: number, parity: string, dataBits: number, stopBits: number }}
 */
export function serial_settings({
	port,
	baud_rate = 9600,
	parity = 'none',
	data_bits = 8,
	stop_bits = 1,
}) {
	if (typeof port !== 'string' || port === '') {
		throw new Error(`Invalid serial port: ${port}`);
	}
	if (!Number.isInteger(baud_rate) || baud_rate < 1) {
		throw new Error(`Invalid baud rate: ${baud_rate}`);
	}
	if (!DATA_BITS.includes(data_bits)) throw new Error(`Invalid data bits: ${data_bits}`);
	if (!STOP_BITS.includes(stop_bits)) throw new Error(`Invalid stop bits: ${stop_bits}`);
	return {
		path: port,
		baudRate: baud_rate,
		parity: parity_name(parity),
		dataBits: data_bits,
		stopBits: stop_bits,
	};
}

/**
 * Creates a closed serial port stream. serialport is bundled, but loaded only here, on first
 * use: loading it loads its native binding, which must not break a TCP-only user where that
 * binding is unavailable.
 */
async function create_stream(settings) {
	const [{ SerialPortStream }, { autoDetect }] = await Promise.all([
		import('@serialport/stream'),
		import('@serialport/bindings-cpp'),
	]);
	return new SerialPortStream({ binding: autoDetect(), ...settings, autoOpen: false });
}

let factory = create_stream;

/**
 * Creates a closed serial port from settings made by serial_settings().
 * @returns {Promise<import('@serialport/stream').SerialPortStream>}
 */
export function create_serial_port(settings) {
	return factory(settings);
}

/**
 * Replaces the serial port factory, for tests; a nullish `create` restores the default.
 * Not part of the public API.
 * @param {((settings: Object) => Promise<Object>) | null} create
 */
export function set_serial_port_factory(create) {
	factory = create ?? create_stream;
}
