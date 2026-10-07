import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
	TRANSACTION_START, DO_NOTHING, MAX_QUANTITY,
	modbus_crc16, parse_modicon_range, parse_pdu_range,
	parse_rtu_response, parse_tcp_response,
	silence_option, mbap_frame_length, rtu_response_length, split_frames, resync_frames,
} from './util.js';
import { serial_settings, silence_time, create_serial_port } from './serial.js';

const BROADCAST_ID = 0;

// Connection phases: the client is in exactly one at a time (see design.md, "Client connection state")
const STATE = Object.freeze({
	IDLE: 0,
	CONNECTING: 1,
	CONNECTED: 2,
	DISCONNECTING: 3,
	DISCONNECTED: 4,
	BACKING_OFF: 5,
});

function check_unit_id(unit_id) {
	if (!Number.isInteger(unit_id) || unit_id < 0 || unit_id > 255) {
		throw new Error(`Invalid unit ID: ${unit_id}`);
	}
}

/**
 * Checks a range against the quantity limit of its function code and the PDU address space.
 */
function check_range(func_code, pdu_addr, length) {
	if (!Number.isInteger(length) || length < 1 || length > MAX_QUANTITY[func_code]) {
		throw new Error(`Invalid length ${length} for function code ${func_code}`);
	}
	if (pdu_addr + length > 0x10000) {
		throw new Error('Range exceeds address 65535');
	}
}

/**
 * Chooses the write function code and length for a Modicon range from the shape of `value`.
 */
function infer_write(target, value) {
	const { fs_write, fm_write } = target;
	if (!fs_write || !fm_write) {
		throw new Error('Write operation not supported for this table');
	}
	if (fs_write === 5) {
		// Coils: a boolean is a single write, a Buffer is a multiple write
		if (typeof value === 'boolean') return { func_code: 5, length: target.length ?? 1 };
		if (Buffer.isBuffer(value)) {
			// A bit count cannot be derived from a byte count, so ",N" is required
			if (target.length === undefined) {
				throw new Error('Coil Buffer write requires a ",N" length');
			}
			return { func_code: 15, length: target.length };
		}
		throw new Error('Invalid value for coil write');
	}
	// Holding registers: a number or a 2-byte Buffer of length 1 is a single write
	const length = target.length ?? (Buffer.isBuffer(value) ? value.length / 2 : 1);
	if (typeof value === 'number') return { func_code: 6, length };
	if (Buffer.isBuffer(value)) {
		return { func_code: value.length === 2 && length === 1 ? 6 : 16, length };
	}
	throw new Error('Invalid value for register write');
}

/**
 * Validates `value` against a write function code and length; returns the frame data.
 */
function check_write_value(func_code, length, value) {
	switch (func_code) {
		case 5:
			if (typeof value !== 'boolean' || length !== 1) {
				throw new Error('Invalid value for coil write');
			}
			return value;
		case 15:
			if (!Buffer.isBuffer(value)) throw new Error('Invalid value for coil write');
			if (value.length !== Math.ceil(length / 8)) {
				throw new Error('Invalid buffer length for coil write');
			}
			return value;
		case 6: {
			const data = Buffer.isBuffer(value) && value.length === 2 ? value.readUInt16BE(0) : value;
			if (length !== 1 || !Number.isInteger(data) || data < 0 || data > 0xFFFF) {
				throw new Error('Invalid value for register write');
			}
			return data;
		}
		case 16:
			if (!Buffer.isBuffer(value)) throw new Error('Invalid value for register write');
			if (value.length % 2 !== 0 || value.length !== length * 2) {
				throw new Error('Invalid buffer length for register write');
			}
			return value;
	}
}

/**
 * Returns the value a write response echoes after its address: the coil value (FC 5), the
 * register value (FC 6) or the quantity (FC 15/16). Returns undefined for a read.
 */
function expected_echo(func_code, data, length) {
	switch (func_code) {
		case 5: return data ? 0xFF00 : 0x0000;
		case 6: return data;
		case 15:
		case 16: return length;
	}
}

/**
 * Whether a write response echoes its request: function code, unit ID, address and value or
 * quantity.
 */
function echo_matches(packet, response) {
	const echoed = packet.func_code === 5 || packet.func_code === 6
		? response.data
		: response.quantity;
	return response.func_code === packet.func_code
        && response.unit_id === packet.unit_id
        && response.start_address === packet.address
        && echoed === packet.echo;
}

export class Modbus_Client extends EventEmitter {
	// Numbering base of Modicon strings, fixed at construction
	#modicon_zero_based;
	get modicon_zero_based() {
		return this.#modicon_zero_based;
	}

	#state = STATE.IDLE;
	get is_idle() {
		return this.#state === STATE.IDLE;
	}

	get is_connecting() {
		return this.#state === STATE.CONNECTING;
	}

	get is_connected() {
		return this.#state === STATE.CONNECTED;
	}

	get is_disconnecting() {
		return this.#state === STATE.DISCONNECTING;
	}

	get is_disconnected() {
		return this.#state === STATE.DISCONNECTED;
	}

	get is_backing_off() {
		return this.#state === STATE.BACKING_OFF;
	}

	// Whether the client may open the connection by itself
	get enable_reconnect() {
		return !(this.is_disconnecting || this.is_disconnected);
	}

	// Non-null exactly while backing off
	#reconnect_timer = null;
	// Callbacks of the connect attempt in progress: { on_connect, on_error }
	#connect_waiters = [];
	// connect() calls waiting for a disconnect to complete: { resolve, reject }
	#waiting_connects = [];
	// Resolvers of the disconnect() calls waiting for the transport to close
	#disconnect_waiters = [];

	timeout; // response timeout
	delay; // delay between pools

	#packets = [];
	get_packet(tid) {
		return this.#packets[tid - TRANSACTION_START];
	}

	set_packet(tid, packet) {
		this.#packets[tid - TRANSACTION_START] = packet;
	}

	#last_tid = TRANSACTION_START;
	get_tid() {
		if (this.protocol !== 'tcp') return TRANSACTION_START;
		this.#last_tid++;
		if (
			this.#last_tid > this.packets_length + TRANSACTION_START
            || this.#last_tid < TRANSACTION_START
		) {
			this.#last_tid = TRANSACTION_START;
		}
		return this.#last_tid;
	}

	#trans_count = 0;
	inc_trans_count() {
		this.#trans_count++;
	}

	dec_trans_count() {
		this.#trans_count--;
		if (this.#trans_count < 0) {
			this.#trans_count = 0;
		}
	}

	constructor(address, options = {}) {
		super();
		this.packets_length = 256;

		const {
			port = 502,
			rtu = false,
			reconnect_time = 10000,
			baud_rate, parity, data_bits, stop_bits,
		} = options;
		this.reconnect_time = reconnect_time;
		this.#modicon_zero_based = options.modicon_zero_based ?? false;
		// Bytes received and not yet delimited; emptied when the connection opens or closes
		this.unprocessed_buffer = Buffer.alloc(0);
		this.timeout = options.timeout ?? 1000;
		this.delay = options.delay ?? 20;
		const silence = silence_option(options.silence);

		if (typeof address === 'string') {
			this.set_tcp(address, port);
			this.protocol = rtu ? 'rtu_over_tcp' : 'tcp';
			this.#silence = silence;
		} else {
			// The serial device path is `port`; the options are checked here, the port is
			// created when first opened
			const settings = serial_settings({ port, baud_rate, parity, data_bits, stop_bits });
			this.set_serial(settings);
			this.protocol = 'rtu';
			this.#silence = silence_time(settings, silence);
		}

		if (this.reconnect_time > 0) this.#start_connect();
	}

	send_queue = [];
	send_queue_size = 256;
	// `on_sent` runs once the frame has been written to the transport
	send(data, on_sent) {
		this.send_queue.push({ buffer: data, on_sent });
		const overflow = this.send_queue.length - this.send_queue_size;
		if (overflow > 0) {
			this.send_queue.splice(0, overflow);
		}
		this.sending();
	};

	#busy = false;
	sending() {
		if (this.#busy || this.send_queue.length === 0) return;
		if (this.is_connected) {
			const { buffer, on_sent } = this.send_queue.shift();
			this.#busy = true;
			this._send(buffer);
			on_sent?.();
			setTimeout(() => {
				this.#busy = false;
				this.sending();
			}, this.delay);
		} else if (this.is_idle || this.is_connecting) {
			this.#start_connect(
				() => this.sending(),
				() => this.emit('error', 'send failed!'),
			);
		}
	}

	/**
     * Rejects every pending request with `Error('connection lost')` and discards the queued
     * frames, so no request is executed after it was reported as failed.
     */
	abort_pending() {
		this.send_queue.length = 0;
		for (const packet of this.#packets) {
			if (packet?.status === 'pending') packet.reject(new Error('connection lost'));
		}
	}

	process_packet_transaction(packet) {
		if (this.is_backing_off || !this.enable_reconnect) {
			// A request issued during a reconnect back-off or after disconnect() fails at once
			// and is never queued
			packet.status = 'rejected';
			// Emitted only for a back-off (after disconnect() the caller closed the connection),
			// and only when listened to, so a valid call never throws synchronously
			if (this.is_backing_off && this.listenerCount('error') > 0) {
				this.emit('error', 'Attempting to transfer data when a connection could not be established.');
			}
			return Promise.reject(new Error('connection lost'));
		}

		const end_transaction = (status) => {
			this.dec_trans_count();
			packet.status = status;
			packet.resolve = DO_NOTHING;
			packet.reject = DO_NOTHING;
			clearTimeout(packet.timeout_id);
		};

		packet.status = 'pending';
		this.inc_trans_count();

		const promise = new Promise((resolve, reject) => {
			packet.timeout_id = setTimeout(() => {
				end_transaction('rejected');
				this.emit('timeout');
				reject(`transaction 0x${packet.tid.toString(16)} timeout`);
			}, this.timeout);
			packet.resolve = (value) => {
				end_transaction('fulfilled');
				this.emit('data', value);
				resolve(value);
			};
			packet.reject = (reason) => {
				end_transaction('rejected');
				this.emit('data_error');
				reject(reason);
			};
		});
		// A broadcast is never answered: it resolves as soon as its frame is written, a write
		// with true and a read with an empty Buffer
		const on_sent = packet.broadcast
			? () => packet.resolve(packet.echo === undefined ? Buffer.alloc(0) : true)
			: undefined;
		this.send(packet.buffer, on_sent);
		return promise;
	}

	/**
     * Parses a `read` / `write` range by its type: a string is a Modicon range, an array or
     * object is a structured PDU range. Throws when it is invalid.
     */
	resolve_range(range) {
		const resolved = typeof range === 'string'
			? parse_modicon_range(range, this.modicon_zero_based)
			: parse_pdu_range(range);
		if (!resolved) throw new Error('Invalid range format');
		return resolved;
	}

	read(range, unit_id = 1) {
		const target = this.resolve_range(range);
		check_unit_id(unit_id);

		let func_code;
		let length;
		if (typeof range === 'string') {
			func_code = target.fm_read;
			length = target.length ?? 1;
		} else {
			if (target.access !== 'read') {
				throw new Error(`Function code ${target.func_code} is not a read function`);
			}
			({ func_code, length } = target);
		}
		check_range(func_code, target.pdu_addr, length);

		return this.transact(unit_id, func_code, target.pdu_addr, null, length);
	}

	write(range, value, unit_id = 1) {
		const target = this.resolve_range(range);
		check_unit_id(unit_id);

		let func_code;
		let length;
		if (typeof range === 'string') {
			({ func_code, length } = infer_write(target, value));
		} else {
			if (target.access !== 'write') {
				throw new Error(`Function code ${target.func_code} is not a write function`);
			}
			({ func_code, length } = target);
		}
		const data = check_write_value(func_code, length, value);
		check_range(func_code, target.pdu_addr, length);

		return this.transact(unit_id, func_code, target.pdu_addr, data, length);
	}

	transact(unit_id, func_code, address, data, length) {
		const tid = this.get_tid();
		const buffer = this.make_data_packet(tid, 0, unit_id, func_code, address, data, length);
		const packet = {
			tid,
			unit_id,
			func_code,
			address,
			buffer,
			// The value a write response must echo; undefined for a read
			echo: expected_echo(func_code, data, length),
			// On a serial bus every request to unit 0 is a broadcast
			broadcast: this.protocol !== 'tcp' && unit_id === BROADCAST_ID,
			status: 'init',
		};
		this.set_packet(tid, packet);

		return this.process_packet_transaction(packet);
	}

	/**
	 * Delimits the frames of a received chunk (see `spec-protocol.md`, "Frame delimiting") and
	 * settles the matching requests. The bytes of an incomplete frame are kept for the next chunk.
	 */
	on_data(chunk) {
		const pending = this.unprocessed_buffer;
		const buffer = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
		const { frames, rest } = split_frames(buffer, this.#frame_length);
		this.#keep(rest);
		this.#on_frames(frames);
	}

	get #frame_length() {
		return this.protocol === 'tcp' ? mbap_frame_length : rtu_response_length;
	}

	// The silence after which the bytes left are resynchronized, in ms, and its timer
	#silence;
	#silence_timer;

	/** Keeps the bytes left, and with `arm` restarts their silence timer. */
	#keep(rest, arm = true) {
		clearTimeout(this.#silence_timer);
		this.unprocessed_buffer = rest;
		if (arm && rest.length > 0) this.#silence_timer = setTimeout(() => this.#on_silence(), this.#silence);
	}

	/**
	 * The connection went silent with bytes left: they are resynchronized; what is still left
	 * is discarded on a serial line and kept, without a new timer, on a TCP connection.
	 */
	#on_silence() {
		const { frames, rest } = resync_frames(this.unprocessed_buffer, this.#frame_length);
		this.#keep(this.protocol === 'rtu' ? Buffer.alloc(0) : rest, false);
		this.#on_frames(frames);
	}

	#on_frames(frames) {
		const tcp = this.protocol === 'tcp';
		for (const frame of frames) {
			const response = tcp ? parse_tcp_response(frame) : parse_rtu_response(frame);
			this.emit('receive', response.buffer);

			if (response.func_code === 0) continue; // Invalid data

			const packet = this.get_packet(response.tid);
			if (packet === undefined || packet.status !== 'pending') {
				continue;
			}

			if (response.exception_code) {
				packet.reject(`response error: ${response.exception_code}`);
				continue;
			}

			// A read resolves with its data, a write with whether the echo matches the request
			packet.resolve(packet.echo === undefined ? response.data : echo_matches(packet, response));
		}
	}

	// `start_address` is the PDU address, already converted from Modicon notation
	make_data_packet(trans_id, proto_id, unit_id, func_code, start_address, data, length) {
		let dataBytes = 0;
		if (func_code === 15) { dataBytes = Math.ceil(length / 8); }
		if (func_code === 16) { dataBytes = length * 2; }

		let buffer_length = 12;
		if (func_code === 15 || func_code === 16) { buffer_length = 13 + dataBytes; }

		const tcp_buffer = Buffer.alloc(buffer_length);
		tcp_buffer.writeUInt8(unit_id, 6);
		tcp_buffer.writeUInt8(func_code, 7);
		tcp_buffer.writeUInt16BE(start_address, 8);
		switch (func_code) {
			case 1:
			case 2:
			case 3:
			case 4:
				tcp_buffer.writeUInt16BE(length, 10);
				break;
			case 5:
				tcp_buffer.writeUInt16BE(data ? 0xFF00 : 0x0000, 10);
				break;
			case 6:
				tcp_buffer.writeUInt16BE(data, 10);
				break;
			case 15:
			case 16:
				tcp_buffer.writeInt16BE(length, 10);
				tcp_buffer.writeUInt8(dataBytes, 12);
				data.copy(tcp_buffer, 13, 0, dataBytes);
				break;
		}

		if (this.protocol === 'tcp') {
			tcp_buffer.writeUInt16BE(trans_id, 0);
			tcp_buffer.writeUInt16BE(proto_id, 2);
			tcp_buffer.writeUInt16BE(buffer_length - 6, 4);
			return tcp_buffer;
		}

		const rtu_data = tcp_buffer.subarray(6);
		// rtu_buffer.length = tcp_buffer.lenght -6(MBA) + 2(CRC)
		const rtu_buffer = Buffer.alloc(buffer_length - 4, rtu_data);
		const crc = modbus_crc16(rtu_data);
		// index_of_crc = rtu_buffer.lenght - 2(CRC)
		rtu_buffer.writeUInt16LE(crc, buffer_length - 6);
		return rtu_buffer;
	}

	connect() {
		return new Promise((resolve, reject) => {
			if (this.is_backing_off) {
				reject(new Error('ERR_ILLEGAL_STATE'));
			} else if (this.is_disconnecting) {
				// Starts once the close completes
				this.#waiting_connects.push({ resolve, reject });
			} else {
				this.#start_connect(resolve, reject);
			}
		});
	};

	/**
     * Closes the transport and keeps it closed: no reconnect and no on-demand connect until
     * the next `connect()`. Resolves once the transport has closed, never rejects.
     */
	disconnect() {
		for (const { reject } of this.#waiting_connects.splice(0)) {
			reject(new Error('connection lost'));
		}
		if (this.is_disconnecting) {
			return new Promise((resolve) => this.#disconnect_waiters.push(resolve));
		}
		if (this.is_connecting || this.is_connected) {
			this.#state = STATE.DISCONNECTING;
			const closed = new Promise((resolve) => this.#disconnect_waiters.push(resolve));
			this._close();
			return closed;
		}
		// IDLE, BACKING_OFF or DISCONNECTED: no transport event will follow
		clearTimeout(this.#reconnect_timer);
		this.#reconnect_timer = null;
		this.#state = STATE.DISCONNECTED;
		this.abort_pending();
		return Promise.resolve();
	}

	// Connects from IDLE, DISCONNECTED or BACKING_OFF, or joins the attempt in progress
	#start_connect(on_connect = DO_NOTHING, on_error = DO_NOTHING) {
		if (this.is_connected) {
			on_connect();
			return;
		}
		this.#connect_waiters.push({ on_connect, on_error });
		if (this.is_connecting) return;
		this.#state = STATE.CONNECTING;
		this._open();
	}

	#back_off() {
		this.#state = STATE.BACKING_OFF;
		this.#reconnect_timer = setTimeout(() => {
			this.#reconnect_timer = null;
			this.#start_connect();
		}, this.reconnect_time);
	}

	// Called by the transport once it is open
	#transport_opened() {
		// A serial open that settles after disconnect() is closed by `_close`
		if (!this.is_connecting) return;
		this.#keep(Buffer.alloc(0));
		this.#state = STATE.CONNECTED;
		this.emit('connect');
		for (const { on_connect } of this.#connect_waiters.splice(0)) on_connect();
	}

	/**
     * Called by the transport when it closed or failed to open. Pending requests fail, and
     * the phase moves only from CONNECTING, CONNECTED or DISCONNECTING, so a second event for
     * the same loss changes nothing.
     *
     * @param {Error|null} error - the cause, passed to the callers of the failed connect.
     * @param {boolean} emit_disconnect - whether to emit `disconnect`.
     */
	#transport_lost(error, emit_disconnect) {
		this.abort_pending();
		this.#keep(Buffer.alloc(0));
		const was_disconnecting = this.is_disconnecting;
		// Taken before any event, so a listener that connects again keeps its own callbacks
		const connect_waiters = this.#connect_waiters.splice(0);
		if (was_disconnecting) {
			this.#state = STATE.DISCONNECTED;
		} else if (this.is_connecting || this.is_connected) {
			if (this.protocol !== 'rtu' && this.reconnect_time > 0) {
				this.#back_off();
			} else {
				this.#state = STATE.IDLE;
			}
		}
		if (emit_disconnect) this.emit('disconnect');
		const reason = error ?? new Error('connection lost');
		for (const { on_error } of connect_waiters) on_error(reason);
		if (was_disconnecting) {
			for (const resolve of this.#disconnect_waiters.splice(0)) resolve();
			for (const { resolve, reject } of this.#waiting_connects.splice(0)) {
				this.#start_connect(resolve, reject);
			}
		}
	}

	/**
     * Sets up the serial transport. The port is created and opened by `_open` (at
     * construction when `reconnect_time > 0`, otherwise on demand) and is never re-opened
     * automatically after it closes.
     *
     * @param {Object} settings - serial port settings made by serial_settings().
     * @return {void}
     */
	set_serial(settings) {
		// Created by the first `_open`
		this.stream = null;

		this._send = (data) => {
			this.stream.write(data);
			this.emit('send', data);
		};

		// The port creation, done once
		let creating = null;
		const get_port = () => {
			creating ??= create_serial_port(settings).then((serialport) => {
				this.stream = serialport;
				this.listen_serial(serialport);
				return serialport;
			}, (error) => {
				creating = null; // let a later attempt retry
				throw error;
			});
			return creating;
		};

		// The open in progress; `_close` waits for it, since an open cannot be aborted
		let opening = null;
		this._open = () => {
			opening = get_port().then((serialport) => new Promise((resolve, reject) => {
				serialport.open((error) => (error ? reject(error) : resolve()));
			}));
			opening.then(() => this.#transport_opened(), (error) => {
				this.#transport_lost(error, false);
				this.emit('error', error);
			}).finally(() => {
				opening = null;
			});
		};

		// A close that fails emits no `close`, so it ends the connection here
		const close_port = () => this.stream.close((error) => {
			if (error) this.#transport_lost(error, false);
		});
		this._close = () => {
			if (opening) opening.then(close_port, DO_NOTHING);
			else close_port();
		};
	}

	/**
     * Follows the events of the serial port created by `set_serial`.
     */
	listen_serial(serialport) {
		serialport.on('data', (data) => {
			this.on_data(data);
		});

		serialport.on('error', (error) => {
			// A port still open is closed, and its `close` ends the connection; one already
			// closed emits no `close`, so the error ends it
			if (!serialport.isOpen) {
				this.#transport_lost(error, false);
			} else if (!this.is_disconnecting) {
				this._close();
			}
			this.emit('error', error);
		});

		serialport.on('close', () => {
			this.#transport_lost(null, true);
		});
	}

	/**
     * Initializes a new TCP connection and sets up some function.
     *
     * @param {string} ip_address - the IP address of the server to connect to.
     * @param {number} port - the port number to connect to.
     * @return {void}
     */
	set_tcp(ip_address, port) {
		if (this.stream instanceof Socket) this.destroy();
		const stream = new Socket();
		this.stream = stream;

		this._send = (data) => {
			stream.write(data);
			this.emit('send', data);
		};
		this._open = () => stream.connect(port, ip_address);
		// Not `end()`: on a dead link the peer's FIN never comes, and the close would hang
		this._close = () => stream.destroy();

		stream.on('data', (data) => {
			this.on_data(data);
		});

		stream.on('connect', () => {
			this.#transport_opened();
		});

		// A socket always emits `close` after `error`, so only `close` ends the connection;
		// the error is kept for the callers of a failed connect
		let last_error = null;
		stream.on('error', (error) => {
			last_error = error;
			this.emit('error', error);
		});

		stream.on('close', () => {
			const error = last_error;
			last_error = null;
			this.#transport_lost(error, true);
		});
	}
}
