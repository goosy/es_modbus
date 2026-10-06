import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { serial_settings, create_serial_port } from './serial.js';
import { MAX_QUANTITY, modbus_crc16, parse_tcp_request, parse_rtu_request } from './util.js';

/**
 * Checks the data of a supported request as the Modbus application protocol does, before any
 * `vector` call. Returns the exception code to answer with, or 0 when the request is valid:
 * 0x03 (Illegal Data Value) for a quantity outside 1..MAX_QUANTITY, a byte count that does not
 * match the quantity, or an FC 5 value other than 0xFF00 / 0x0000; then 0x02 (Illegal Data
 * Address) for a range that ends past address 65535.
 */
function check_request({ func_code, start_address, quantity, byte_count, data }) {
	switch (func_code) {
		case 5:
			if (data !== 0xFF00 && data !== 0x0000) return 0x03;
			return 0;
		case 6:
			return 0;
		case 15:
			if (byte_count !== Math.ceil(quantity / 8)) return 0x03;
			break;
		case 16:
			if (byte_count !== quantity * 2) return 0x03;
			break;
	}
	if (quantity < 1 || quantity > MAX_QUANTITY[func_code]) return 0x03;
	if (start_address + quantity > 0x10000) return 0x02;
	return 0;
}

const BROADCAST_ID = 0;
const WRITE_FUNCTIONS = new Set([5, 6, 15, 16]);

// Wraps an exception thrown by a `vector` function
class Vector_Error extends Error {
	constructor(cause) {
		super('vector function failed', { cause });
	}
}

/**
 * @typedef {Object} ModbusVector
 * @property {(addr: number, unit_id: number) => number} get_input_register  Read input register
 * @property {(addr: number, unit_id: number) => number} get_holding_register  Read holding register
 * @property {(addr: number, value: number, unit_id: number) => void} set_register  Write register
 * @property {(addr: number, unit_id: number) => boolean} get_coil  Read coil
 * @property {(addr: number, value: boolean, unit_id: number) => void} set_coil  Write coil
 */

export class Modbus_Server extends EventEmitter {
	initialized = false;
	sockets = null;
	host = null;
	port = null;
	serial_settings = null; // serial port settings, for a serial device path `port`
	serial_port = null; // the serial port, created by the first start()
	protocol = 'tcp'; // the framing: 'tcp', 'rtu_over_tcp' or 'rtu'
	unit_ids = null;
	accept_all_units = true;

	/**
     * Constructor for a Modbus server.
     * @param {ModbusVector} vector - Modbus request handler functions.
     * @param {Object} [options] - Options for the server:
     * @param {string} [options.host='0.0.0.0'] - The host to listen on (default: '0.0.0.0')
     * @param {number|string} [options.port=502] - The TCP port to listen on (default: 502) or a serial port path (for RTU mode).
     * @param {boolean} [options.rtu=false] - With a TCP port, use RTU framing on the accepted sockets (RTU-over-TCP);
     *   ignored for a serial port path.
     * @param {number} [options.baud_rate=9600] - Serial baud rate, used with a serial port path.
     * @param {'none'|'odd'|'even'|0|1|2} [options.parity='none'] - Serial parity, used with a serial port path.
     * @param {number} [options.data_bits=8] - Serial data bits, used with a serial port path.
     * @param {number} [options.stop_bits=1] - Serial stop bits, used with a serial port path.
     * @param {number|number[]|'all'|'*'} [options.unit_id] - The Modbus unit ID(s) to accept and respond to;
     *   every ID when omitted (see `set_unit_ids()` for details)
     */
	constructor(vector, options = {}) {
		super();
		this.vector = vector;
		this.set_unit_ids(options.unit_id);
		this.host = options.host ?? '0.0.0.0';
		const port = options.port ?? 502;
		if (typeof port === 'string') {
			// A serial device path; the options are checked here, the port is created by start()
			const { baud_rate, parity, data_bits, stop_bits } = options;
			this.serial_settings = serial_settings({ port, baud_rate, parity, data_bits, stop_bits });
			this.protocol = 'rtu';
		} else if (typeof port === 'number') {
			this.protocol = options.rtu ? 'rtu_over_tcp' : 'tcp';
		} else {
			throw new Error(`Invalid port: ${port}`);
		}
		this.port = port;
		if (this.is_tcp) this.sockets = new Set();
	}

	get is_tcp() {
		return typeof this.port === 'number';
	}

	/**
     * Configures which Modbus unit IDs (slave addresses) this server will accept and respond to.
     * @param {number | number[] | null | undefined | 'all' | '*'} unit_id - The unit ID(s) to accept:
     * - If null, undefined, 'all', or '*': Accept all unit IDs (0-255)
     * - If a number: Accept only that specific unit ID; 0 is an ordinary ID on TCP and the
     *   broadcast address on a serial bus
     * - If an array of numbers: Accept all unit IDs specified in the array
     * @throws {Error} If any specified unit ID is invalid (not an integer between 0 and 255)
     */
	set_unit_ids(unit_id) {
		if (unit_id == null || unit_id === 'all' || unit_id === '*') {
			// Accept all unit IDs
			this.accept_all_units = true;
			this.unit_ids = null;
			return;
		}
		const unit_ids = Array.isArray(unit_id) ? unit_id : [unit_id];
		this.accept_all_units = false;
		this.unit_ids = new Set();
		for (const id of unit_ids) {
			if (!Number.isInteger(id) || id < 0 || id > 255) {
				throw new Error(`Invalid unit ID: ${id}. Must be an integer between 0 and 255.`);
			}
			this.unit_ids.add(id);
		}
	}

	is_valid_unit_id(unit_id) {
		return this.accept_all_units || this.unit_ids.has(unit_id);
	}

	start() {
		if (!this.is_tcp) {
			this.start_serial();
			return;
		}
		if (this.initialized) {
			if (this.server.listening) this.server.close();
			this.server.listen(this.port, this.host);
			return;
		}
		this.set_tcp();
		this.server.listen(this.port, this.host);
		this.initialized = true;
	}

	// The serial port creation, done once
	#creating = null;

	/**
	 * Creates the serial port on the first start, then (re)opens it. A failure, including a
	 * serialport native binding that cannot be loaded, is emitted as `error`.
	 */
	async start_serial() {
		try {
			this.#creating ??= create_serial_port(this.serial_settings).then((serial_port) => {
				this.serial_port = serial_port;
				this.set_rtu();
				this.initialized = true;
				return serial_port;
			});
			const serial_port = await this.#creating;
			if (serial_port.isOpen) {
				await new Promise((resolve) => serial_port.close(() => resolve()));
			}
			// An open failure is emitted as `error` by the port
			serial_port.open();
		} catch (error) {
			this.#creating = null;
			this.emit('error', error);
		}
	}

	set_rtu() {
		const serial_port = this.serial_port;
		serial_port.on('open', () => {
			this.emit('start');
		});
		serial_port.on('data', (data) => this.on_data(data));
		serial_port.on('error', (err) => this.emit('error', err));
		serial_port.on('close', () => {
			this.emit('stop');
		});
	}

	set_tcp() {
		this.server = createServer();
		this.server.on('connection', (socket) => {
			this.emit('socket_connect', socket);
			this.sockets.add(socket);
			socket.on('data', (data) => this.on_data(data, socket));
			socket.on('error', (error) => this.emit('socket_error', error));
			socket.on('close', () => {
				this.sockets.delete(socket);
				this.emit('socket_disconnect', socket);
			});
		});
		this.server.on('listening', () => this.emit('start'));
		this.server.on('error', (error) => this.emit('error', error));
		this.server.on('close', () => this.emit('stop'));
	}

	_on_data(request, socket) {
		const { tid, pid, unit_id, func_code } = request;
		// RTU framing means a serial bus, over a serial port or over TCP
		const serial_bus = this.protocol !== 'tcp';

		if (serial_bus && unit_id === BROADCAST_ID) {
			// A broadcast is never answered; only an accepted write is executed
			if (this.is_valid_unit_id(unit_id) && WRITE_FUNCTIONS.has(func_code)) {
				this.serve(request);
			}
			return;
		}

		if (!this.is_valid_unit_id(unit_id)) {
			// A slave on a serial bus stays silent for other addresses; on TCP the server
			// answers as a gateway would: 0x0B, Gateway Target Device Failed To Respond
			if (!serial_bus) this.send_exception_response(unit_id, func_code, 0x0B, socket, tid, pid);
			return;
		}

		this.send_response(this.serve(request), socket, tid, pid);
	}

	/**
     * Serves a request and returns the response PDU; a throwing `vector` yields exception 0x04.
     */
	serve(request) {
		try {
			return this.dispatch(request);
		} catch (error) {
			if (!(error instanceof Vector_Error)) throw error;
			// 0x04: Server Device Failure
			this.emit('vector_error', error.cause, request);
			return this.create_error_response(request.unit_id, request.func_code, 0x04);
		}
	}

	/**
     * Serves a request through the `vector` and returns the response PDU. A request that fails
     * check_request() is answered with its exception code without calling the `vector`.
     * A throwing `vector` function surfaces as a Vector_Error.
     */
	dispatch(request) {
		const { unit_id, func_code, start_address, quantity, data } = request;
		if (MAX_QUANTITY[func_code] !== undefined) {
			const exception_code = check_request(request);
			if (exception_code) return this.create_error_response(unit_id, func_code, exception_code);
		}

		let response;
		switch (func_code) {
			case 1: // Read Coils
			case 2: // Read Discrete Inputs
				response = this.handle_read_bits(func_code, start_address, quantity, unit_id);
				break;
			case 3: // Read Holding Registers
			case 4: // Read Input Registers
				response = this.handle_read_registers(func_code, start_address, quantity, unit_id);
				break;
			case 5: // Write Single Coil
				response = this.handle_write_single_coil(start_address, data, unit_id);
				break;
			case 6: // Write Single Register
				response = this.handle_write_single_register(start_address, data, unit_id);
				break;
			case 15: // Write Multiple Coils
				response = this.handle_write_multiple_coils(start_address, quantity, data, unit_id);
				break;
			case 16: // Write Multiple Registers
				response = this.handle_write_multiple_registers(start_address, quantity, data, unit_id);
				break;
			default: // 0x01: Illegal Function
				response = this.create_error_response(unit_id, func_code, 0x01);
		}
		return response;
	}

	call_vector(name, ...args) {
		try {
			return this.vector[name](...args);
		} catch (error) {
			throw new Vector_Error(error);
		}
	}

	on_data(buffer, socket) {
		const requests = this.protocol === 'tcp'
			? parse_tcp_request(buffer)
			: parse_rtu_request(buffer);

		for (const request of requests) {
			this.emit('receive', request.buffer);
			if (request.func_code !== 0) {
				this._on_data(request, socket);
			} else if (request.illegal_function !== undefined) {
				// Answered with exception 0x01 under its own function code
				this._on_data({ ...request, func_code: request.illegal_function }, socket);
			}
			// Any other invalid frame is dropped
		}
	}

	/**
     * Frames a response PDU for the configured protocol and writes it to `socket`, or to the
     * serial port when there is no `socket`.
     */
	send_response(response, socket, transaction_id, protocol_id) {
		const data_length = response.length;
		let full_response;
		if (this.protocol === 'tcp') {
			// Modbus TCP: add MBAP header
			full_response = Buffer.alloc(data_length + 6);
			full_response.writeUInt16BE(transaction_id, 0);
			full_response.writeUInt16BE(protocol_id, 2);
			full_response.writeUInt16BE(response.length, 4);
			response.copy(full_response, 6, 0);
		} else {
			// Modbus RTU, over a serial port or TCP: add CRC
			const crc = modbus_crc16(response);
			full_response = Buffer.alloc(data_length + 2, response);
			full_response.writeUInt16LE(crc, data_length);
		}
		this.emit('send', full_response);
		(socket ?? this.serial_port).write(full_response);
	}

	handle_read_bits(function_code, start_address, quantity, unit_id) {
		const values = [];
		for (let i = 0; i < quantity; i++) {
			const addr = start_address + i;
			const value = this.call_vector('get_coil', addr, unit_id);
			values.push(value ? 1 : 0);
		}

		const byte_count = Math.ceil(quantity / 8);
		const buffer = Buffer.alloc(3 + byte_count);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(function_code, 1);
		buffer.writeUInt8(byte_count, 2);

		for (let i = 0; i < byte_count; i++) {
			let byte = 0;
			for (let j = 0; j < 8; j++) {
				if (i * 8 + j < quantity) {
					byte |= values[i * 8 + j] << j;
				}
			}
			buffer.writeUInt8(byte, 3 + i);
		}

		return buffer;
	}

	handle_read_registers(function_code, start_address, quantity, unit_id) {
		const values = [];
		for (let i = 0; i < quantity; i++) {
			const addr = start_address + i;
			const value = function_code === 3
				? this.call_vector('get_holding_register', addr, unit_id)
				: this.call_vector('get_input_register', addr, unit_id);
			values.push(value);
		}

		const buffer = Buffer.alloc(3 + quantity * 2);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(function_code, 1);
		buffer.writeUInt8(quantity * 2, 2);

		for (let i = 0; i < quantity; i++) {
			buffer.writeUInt16BE(values[i], 3 + i * 2);
		}

		return buffer;
	}

	handle_write_single_coil(address, value, unit_id) {
		this.call_vector('set_coil', address, value === 0xFF00, unit_id);

		const buffer = Buffer.alloc(6);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(5, 1);
		buffer.writeUInt16BE(address, 2);
		buffer.writeUInt16BE(value, 4);

		return buffer;
	}

	handle_write_single_register(address, value, unit_id) {
		this.call_vector('set_register', address, value, unit_id);

		const buffer = Buffer.alloc(6);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(6, 1);
		buffer.writeUInt16BE(address, 2);
		buffer.writeUInt16BE(value, 4);

		return buffer;
	}

	handle_write_multiple_coils(start_address, quantity, data, unit_id) {
		for (let i = 0; i < quantity; i++) {
			const byteIndex = Math.floor(i / 8);
			const bitIndex = i % 8;
			const value = (data[byteIndex] & (1 << bitIndex)) !== 0;
			this.call_vector('set_coil', start_address + i, value, unit_id);
		}

		const buffer = Buffer.alloc(6);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(15, 1);
		buffer.writeUInt16BE(start_address, 2);
		buffer.writeUInt16BE(quantity, 4);

		return buffer;
	}

	handle_write_multiple_registers(start_address, quantity, data, unit_id) {
		for (let i = 0; i < quantity; i++) {
			const value = data.readUInt16BE(i * 2);
			this.call_vector('set_register', start_address + i, value, unit_id);
		}

		const buffer = Buffer.alloc(6);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(16, 1);
		buffer.writeUInt16BE(start_address, 2);
		buffer.writeUInt16BE(quantity, 4);

		return buffer;
	}

	send_exception_response(unit_id, function_code, exception_code, socket, transaction_id, protocol_id) {
		const response = this.create_error_response(unit_id, function_code, exception_code);
		this.send_response(response, socket, transaction_id, protocol_id);
	}

	create_error_response(unit_id, function_code, exception_code) {
		const buffer = Buffer.alloc(3);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(function_code | 0x80, 1);
		buffer.writeUInt8(exception_code, 2);
		return buffer;
	}

	stop() {
		if (this.server) {
			for (const socket of this.sockets) {
				socket.destroy();
			}
			this.sockets.clear();
			this.server.close();
		} else if (this.serial_port?.isOpen) {
			this.serial_port.close();
		}
	}
}
