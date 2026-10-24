import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { serial_settings, silence_time, create_serial_port } from './serial.js';
import {
	BROADCAST_ID, check_unit_id, check_request, silence_option,
	parse_tcp_request, parse_rtu_request, encode_tcp_frame, encode_rtu_frame,
	mbap_frame_length, rtu_request_length, Frame_Receiver,
} from './util.js';

const WRITE_FUNCTIONS = new Set([5, 6, 15, 16]);

// An exception response: unit ID, function code with the exception bit, exception code
function exception_response(unit_id, func_code, exception_code) {
	return Buffer.from([unit_id, func_code | 0x80, exception_code]);
}

// A write response: unit ID, function code, address, then the value (FC 5 / 6) or quantity
function write_response(unit_id, func_code, address, value) {
	const buffer = Buffer.alloc(6);
	buffer.writeUInt8(unit_id, 0);
	buffer.writeUInt8(func_code, 1);
	buffer.writeUInt16BE(address, 2);
	buffer.writeUInt16BE(value, 4);
	return buffer;
}

// Wraps an exception thrown by a `vector` function
class Vector_Error extends Error {
	constructor(cause) {
		super('vector function failed', { cause });
	}
}

// Whether `value` can be served as a register: an integer in 0..65535
const is_register_value = (value) => Number.isInteger(value) && value >= 0 && value <= 0xFFFF;

// Throws a Vector_Error unless every value read from the `vector` can be served as a register
function check_register_values(values) {
	if (!Array.prototype.every.call(values, is_register_value)) {
		throw new Vector_Error(new TypeError('a register value must be an integer in 0..65535'));
	}
}

/**
 * @typedef {Object} ModbusVector
 * @property {(addr: number, unit_id: number) => number} get_input_register  Read input register
 * @property {(addr: number, unit_id: number) => number} get_holding_register  Read holding register
 * @property {(addr: number, value: number, unit_id: number) => void} set_holding_register  Write holding register
 * @property {(addr: number, unit_id: number) => boolean} get_coil  Read coil
 * @property {(addr: number, unit_id: number) => boolean} [get_discrete_input]  Read discrete input
 * @property {(addr: number, value: boolean, unit_id: number) => void} set_coil  Write coil
 * @property {(addr: number, values: number[], unit_id: number) => void} [set_holding_registers]  Write registers of one FC 16 request
 * @property {(addr: number, values: boolean[], unit_id: number) => void} [set_coils]  Write coils of one FC 15 request
 * @property {(addr: number, quantity: number, unit_id: number) => ArrayLike<number>} [get_input_registers]  Read input registers of one FC 4 request
 * @property {(addr: number, quantity: number, unit_id: number) => ArrayLike<number>} [get_holding_registers]  Read holding registers of one FC 3 request
 * @property {(addr: number, quantity: number, unit_id: number) => ArrayLike<boolean>} [get_coils]  Read coils of one FC 1 request
 * @property {(addr: number, quantity: number, unit_id: number) => ArrayLike<boolean>} [get_discrete_inputs]  Read discrete inputs of one FC 2 request
 */

export class Modbus_Server extends EventEmitter {
	initialized = false;
	sockets = null;
	host = null;
	port = null;
	serial_settings = null; // serial port settings, for a serial device path `port`
	serial_port = null; // the serial port, created by the first start()
	name; // the name of the server, for logging
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
     * @param {number} [options.silence=50] - The silence, in ms, after which the bytes left are resolved;
     *   on a serial port at least 3.5 character times.
     * @param {number|number[]|'all'|'*'} [options.unit_id] - The Modbus unit ID(s) to accept and respond to;
     *   every ID when omitted (see `set_unit_ids()` for details)
     */
	constructor(vector, options = {}) {
		super();
		this.vector = vector;
		this.set_unit_ids(options.unit_id);
		this.host = options.host ?? '0.0.0.0';
		this.name = options.name ?? 'Modbus_Server';
		const port = options.port ?? 502;
		const silence = silence_option(options.silence);
		if (typeof port === 'string') {
			// A serial device path; the options are checked here, the port is created by start()
			const { baud_rate, parity, data_bits, stop_bits } = options;
			this.serial_settings = serial_settings({ port, baud_rate, parity, data_bits, stop_bits });
			this.protocol = 'rtu';
			this.#silence = silence_time(this.serial_settings, silence);
		} else if (typeof port === 'number') {
			this.protocol = options.rtu ? 'rtu_over_tcp' : 'tcp';
			this.#silence = silence;
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
			check_unit_id(id);
			this.unit_ids.add(id);
		}
	}

	is_valid_unit_id(unit_id) {
		return this.accept_all_units || this.unit_ids.has(unit_id);
	}

	// The start/stop queue: the settlement of the last run, and the last call still pending
	#queue = Promise.resolve();
	#last = null; // { kind, promise }
	#running = null; // the entry of the running call
	#busy = false; // a start or stop is running
	#reported = new Set(); // errors emitted as `error` by the current run

	/**
	 * Begins listening (TCP-family) or opens the serial port; restarts a started server. Resolves
	 * once ready, after the `start` event; rejects with the first error before that.
	 * @return {Promise<void>}
	 */
	start() {
		return this.#enqueue('start', () => this.#run_start());
	}

	/**
	 * Destroys the live sockets and closes the listener, or closes the serial port. Resolves once
	 * closed, after the `stop` event, or at once when not started; never rejects.
	 * @return {Promise<void>}
	 */
	stop() {
		return this.#enqueue('stop', () => this.#run_stop());
	}

	/**
	 * Runs `run` after every earlier start/stop has settled. A call of the same kind as the last
	 * pending one joins it. A failure emitted as `error` is marked handled before the promise
	 * rejects; any other is left to the caller, unhandled when the caller ignores it.
	 */
	#enqueue(kind, run) {
		if (this.#last?.kind === kind) return this.#last.promise;
		const last = { kind, promise: null };
		// Never rejects, so a failure does not stop the queue
		const settled = this.#queue.then(async () => {
			this.#busy = true;
			this.#running = last;
			try {
				await run();
				return { failed: false };
			} catch (error) {
				return { failed: true, error, handled: this.#reported.has(error) };
			} finally {
				this.#busy = false;
				this.#running = null;
				this.#reported.clear();
			}
		});
		this.#queue = settled;
		last.promise = settled.then(({ failed, error, handled }) => {
			if (this.#last === last) this.#last = null;
			if (!failed) return;
			if (handled) last.promise.catch(() => { });
			throw error;
		});
		this.#last = last;
		return last.promise;
	}

	/**
	 * The running call of that kind is about to emit its outcome: from then on, as from a
	 * listener of that event, a new call starts a new run instead of joining it.
	 */
	#end_run(kind) {
		if (this.#running?.kind === kind && this.#last === this.#running) this.#last = null;
	}

	// Emits an error of a running start/stop as `error`, only when someone listens
	#report(error) {
		if (this.listenerCount('error') === 0) return;
		this.#reported.add(error);
		this.emit('error', error);
	}

	// A transport `error`: owned by the running start/stop, if any
	#transport_error(error) {
		if (this.#busy) this.#report(error);
		else this.emit('error', error);
	}

	async #run_start() {
		// A restart stops first; nothing to do when stopped
		await this.#run_stop();
		if (this.is_tcp) await this.#listen();
		else await this.#open_serial();
	}

	async #run_stop() {
		if (this.is_tcp) {
			if (!this.server?.listening) return;
			for (const socket of this.sockets) socket.destroy();
			this.sockets.clear();
			// The callback runs on `close`, after the `stop` event
			await new Promise((resolve) => this.server.close(() => resolve()));
			return;
		}
		const serial_port = this.serial_port;
		if (!serial_port?.isOpen) return;
		await new Promise((resolve) => serial_port.close((error) => {
			// The port counts as closed anyway
			if (error) this.#report(error);
			resolve();
		}));
	}

	// Listens on the TCP server, created by the first start
	#listen() {
		if (!this.initialized) {
			this.set_tcp();
			this.initialized = true;
		}
		const server = this.server;
		return new Promise((resolve, reject) => {
			// Registered after `set_tcp`'s listeners: `start` or `error` is emitted first
			const on_listening = () => {
				server.off('error', on_error);
				resolve();
			};
			const on_error = (error) => {
				server.off('listening', on_listening);
				reject(error);
			};
			server.once('listening', on_listening);
			server.once('error', on_error);
			try {
				server.listen(this.port, this.host);
			} catch (error) {
				// An invalid port number throws at once
				server.off('listening', on_listening);
				server.off('error', on_error);
				this.#end_run('start');
				this.#report(error);
				reject(error);
			}
		});
	}

	// The serial port creation, done once
	#creating = null;

	/**
	 * Creates the serial port on the first start, then opens it. A failed creation is forgotten so
	 * a later start retries; a native addon that cannot be loaded fails the open.
	 */
	async #open_serial() {
		let serial_port;
		try {
			this.#creating ??= create_serial_port(this.serial_settings).then((port) => {
				this.serial_port = port;
				this.set_rtu();
				this.initialized = true;
				return port;
			});
			serial_port = await this.#creating;
		} catch (error) {
			this.#creating = null;
			this.#end_run('start');
			this.#report(error);
			throw error;
		}
		// With a callback, an open failure is passed to it, not emitted; `open` comes first
		await new Promise((resolve, reject) => serial_port.open((error) => {
			if (!error) return resolve();
			this.#end_run('start');
			this.#report(error);
			reject(error);
		}));
	}

	set_rtu() {
		const serial_port = this.serial_port;
		serial_port.on('open', () => {
			this.#end_run('start');
			this.emit('start');
		});
		serial_port.on('data', (data) => this.on_data(data));
		serial_port.on('error', (error) => this.#transport_error(error));
		serial_port.on('close', () => {
			this.#receivers.get(undefined)?.clear();
			this.#end_run('stop');
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
				this.#receivers.get(socket)?.clear();
				this.#receivers.delete(socket);
				this.emit('socket_disconnect', socket);
			});
		});
		this.server.on('listening', () => {
			this.#end_run('start');
			this.emit('start');
		});
		this.server.on('error', (error) => {
			// A server error during a run is a listen failure
			this.#end_run('start');
			this.#transport_error(error);
		});
		this.server.on('close', () => {
			this.#end_run('stop');
			this.emit('stop');
		});
	}

	_on_data(request, socket) {
		const { tid, unit_id, func_code } = request;
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
			if (!serial_bus) this.send_response(exception_response(unit_id, func_code, 0x0B), socket, tid);
			return;
		}

		this.send_response(this.serve(request), socket, tid);
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
			return exception_response(request.unit_id, request.func_code, 0x04);
		}
	}

	/**
     * Serves a request through the `vector` and returns the response PDU. A request that fails
     * check_request() is answered with its exception code without calling the `vector`.
     * A throwing `vector` function surfaces as a Vector_Error.
     */
	dispatch(request) {
		const { unit_id, func_code, start_address, quantity, data } = request;
		const exception_code = check_request(request);
		if (exception_code) return exception_response(unit_id, func_code, exception_code);

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
				response = exception_response(unit_id, func_code, 0x01);
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

	// The frame receivers, by socket; the serial port's under `undefined`
	#receivers = new Map();
	// The silence after which the bytes left are resolved, in ms
	#silence;

	/**
	 * Delimits the frames of a chunk received from `socket` (the serial port when undefined)
	 * and serves each; the bytes of an incomplete frame are kept for the next chunk.
	 */
	on_data(chunk, socket) {
		let receiver = this.#receivers.get(socket);
		if (!receiver) {
			receiver = new Frame_Receiver({
				frame_length: this.protocol === 'tcp' ? mbap_frame_length : rtu_request_length,
				silence: this.#silence,
				serial_line: this.protocol === 'rtu',
				on_frame: (frame) => this.#on_frame(frame, socket),
			});
			this.#receivers.set(socket, receiver);
		}
		receiver.push(chunk);
	}

	#on_frame(frame, socket) {
		const request = this.protocol === 'tcp' ? parse_tcp_request(frame) : parse_rtu_request(frame);
		this.emit('receive', request.buffer);
		if (request.func_code !== 0) {
			this._on_data(request, socket);
		} else if (request.illegal_function !== undefined) {
			// Answered with exception 0x01 under its own function code
			this._on_data({ ...request, func_code: request.illegal_function }, socket);
		}
		// Any other invalid frame is dropped
	}

	/**
	 * Frames a response (unit ID + PDU) for the configured protocol and writes it to `socket`,
	 * or to the serial port when there is no `socket`.
	 */
	send_response(response, socket, transaction_id) {
		const frame = this.protocol === 'tcp'
			? encode_tcp_frame(transaction_id, response)
			: encode_rtu_frame(response);
		this.emit('send', frame);
		(socket ?? this.serial_port).write(frame);
	}

	handle_read_bits(function_code, start_address, quantity, unit_id) {
		const has_discrete_inputs = function_code === 2 && (
			typeof this.vector.get_discrete_inputs === 'function'
			|| typeof this.vector.get_discrete_input === 'function'
		);
		const [batch_name, single_name] = has_discrete_inputs
			? ['get_discrete_inputs', 'get_discrete_input']
			: ['get_coils', 'get_coil'];
		const values = this.read_points(batch_name, single_name, start_address, quantity, unit_id);

		const byte_count = Math.ceil(quantity / 8);
		const buffer = Buffer.alloc(3 + byte_count);
		buffer.writeUInt8(unit_id, 0);
		buffer.writeUInt8(function_code, 1);
		buffer.writeUInt8(byte_count, 2);

		for (let i = 0; i < byte_count; i++) {
			let byte = 0;
			for (let j = 0; j < 8; j++) {
				if (i * 8 + j < quantity) {
					byte |= (values[i * 8 + j] ? 1 : 0) << j;
				}
			}
			buffer.writeUInt8(byte, 3 + i);
		}

		return buffer;
	}

	handle_read_registers(function_code, start_address, quantity, unit_id) {
		const [batch_name, single_name] = function_code === 3
			? ['get_holding_registers', 'get_holding_register']
			: ['get_input_registers', 'get_input_register'];
		const values = this.read_points(batch_name, single_name, start_address, quantity, unit_id);
		check_register_values(values);

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
		return write_response(unit_id, 5, address, value);
	}

	handle_write_single_register(address, value, unit_id) {
		this.call_vector('set_holding_register', address, value, unit_id);
		return write_response(unit_id, 6, address, value);
	}

	handle_write_multiple_coils(start_address, quantity, data, unit_id) {
		const values = [];
		for (let i = 0; i < quantity; i++) {
			const byteIndex = Math.floor(i / 8);
			const bitIndex = i % 8;
			values.push((data[byteIndex] & (1 << bitIndex)) !== 0);
		}
		this.write_points('set_coils', 'set_coil', start_address, values, unit_id);
		return write_response(unit_id, 15, start_address, quantity);
	}

	handle_write_multiple_registers(start_address, quantity, data, unit_id) {
		const values = [];
		for (let i = 0; i < quantity; i++) {
			values.push(data.readUInt16BE(i * 2));
		}
		this.write_points('set_holding_registers', 'set_holding_register', start_address, values, unit_id);
		return write_response(unit_id, 16, start_address, quantity);
	}

	/**
	 * Reads `quantity` points through the batch method when the `vector` has one, else point by
	 * point. A batch result that is not an array of `quantity` values surfaces as a Vector_Error.
	 */
	read_points(batch_name, single_name, start_address, quantity, unit_id) {
		if (typeof this.vector[batch_name] !== 'function') {
			const values = [];
			for (let i = 0; i < quantity; i++) {
				values.push(this.call_vector(single_name, start_address + i, unit_id));
			}
			return values;
		}
		const values = this.call_vector(batch_name, start_address, quantity, unit_id);
		const is_array = Array.isArray(values) || ArrayBuffer.isView(values);
		if (!is_array || values.length !== quantity) {
			throw new Vector_Error(new TypeError(`${batch_name} must return ${quantity} values`));
		}
		return values;
	}

	// Writes `values` through the batch method when the `vector` has one, else point by point
	write_points(batch_name, single_name, start_address, values, unit_id) {
		if (typeof this.vector[batch_name] === 'function') {
			this.call_vector(batch_name, start_address, values, unit_id);
			return;
		}
		for (let i = 0; i < values.length; i++) {
			this.call_vector(single_name, start_address + i, values[i], unit_id);
		}
	}
}
