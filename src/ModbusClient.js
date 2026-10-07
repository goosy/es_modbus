import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
	TRANSACTION_START, DO_NOTHING, BROADCAST_ID, plan_read, plan_write,
	parse_rtu_response, parse_tcp_response, encode_tcp_frame, encode_rtu_frame,
	silence_option, mbap_frame_length, rtu_response_length, Frame_Receiver,
} from './util.js';
import { serial_settings, silence_time, create_serial_port } from './serial.js';

// Connection phases: the client is in exactly one at a time (see design.md, "Client connection state")
const STATE = Object.freeze({
	IDLE: 0,
	CONNECTING: 1,
	CONNECTED: 2,
	DISCONNECTING: 3,
	DISCONNECTED: 4,
	BACKING_OFF: 5,
});

/**
 * Checks a numeric option: the default when nullish, else a number passing `valid`. Throws
 * `Invalid <name>` on anything else, so the constructor fails at once.
 */
function number_option(name, value, fallback, valid) {
	if (value == null) return fallback;
	if (typeof value !== 'number' || !valid(value)) throw new Error(`Invalid ${name}: ${value}`);
	return value;
}

const is_positive = (value) => Number.isFinite(value) && value > 0;
const is_non_negative = (value) => Number.isFinite(value) && value >= 0;
const is_count = (value) => Number.isInteger(value) && value >= 0;

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
 * Whether an RTU response can answer the request (see spec-client.md, "Concurrency"): the same
 * unit ID and function code (ignoring the exception bit), and for a read the requested byte
 * count. A response that cannot is a late answer to an earlier request.
 */
function response_fits(packet, response) {
	if (response.unit_id !== packet.unit_id) return false;
	if ((response.func_code & 0x7F) !== packet.func_code) return false;
	if (response.exception_code !== undefined || packet.echo !== undefined) return true;
	const bytes = packet.func_code <= 2 ? Math.ceil(packet.length / 8) : packet.length * 2;
	return response.data.length === bytes;
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
	// The delay of the next back-off, and of the last one (0 once the connection proved itself)
	#next_delay = 0;
	#last_delay = 0;
	// Proves a connection that stays open as long as the last back-off delay
	#stable_timer = null;
	// Consecutive timeouts on the connection, for the dead-link detection
	#timeouts = 0;
	// Callbacks of the connect attempt in progress: { on_connect, on_error }
	#connect_waiters = [];
	// connect() calls waiting for a disconnect to complete: { resolve, reject }
	#waiting_connects = [];
	// Resolvers of the disconnect() calls waiting for the transport to close
	#disconnect_waiters = [];

	timeout; // response timeout, from the frame write
	reconnect_max; // TCP family: upper bound of the reconnect delay
	max_timeouts; // TCP family: consecutive timeouts that close the connection, 0 = never
	keep_alive; // TCP family: idle time before the first keep-alive probe, 0 = off
	delay; // minimum gap before the next frame write
	turnaround; // RTU family: minimum wait after a broadcast

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

	// RTU family: the one request whose frame is written and not yet answered
	#current = null;

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
		this.reconnect_max = number_option('reconnect_max', options.reconnect_max, 60000, is_positive);
		this.max_timeouts = number_option('max_timeouts', options.max_timeouts, 3, is_count);
		this.keep_alive = number_option('keep_alive', options.keep_alive, 10000, is_non_negative);
		this.#next_delay = reconnect_time;
		this.#modicon_zero_based = options.modicon_zero_based ?? false;
		this.timeout = options.timeout ?? 1000;
		this.delay = options.delay ?? 20;
		this.turnaround = options.turnaround ?? 100;
		let silence = silence_option(options.silence);

		if (typeof address === 'string') {
			this.set_tcp(address, port);
			this.protocol = rtu ? 'rtu_over_tcp' : 'tcp';
		} else {
			// The serial device path is `port`; the options are checked here, the port is
			// created when first opened
			const settings = serial_settings({ port, baud_rate, parity, data_bits, stop_bits });
			this.set_serial(settings);
			this.protocol = 'rtu';
			silence = silence_time(settings, silence);
		}
		// Emptied when the connection opens or closes
		this.#receiver = new Frame_Receiver({
			frame_length: this.protocol === 'tcp' ? mbap_frame_length : rtu_response_length,
			silence,
			serial_line: this.protocol === 'rtu',
			on_frame: (frame) => this.#on_frame(frame),
		});

		if (this.reconnect_time > 0) this.#start_connect();
	}

	// Packets waiting for their frame to be written
	send_queue = [];
	send_queue_size = 256;
	send(packet) {
		this.send_queue.push(packet);
		const overflow = this.send_queue.length - this.send_queue_size;
		if (overflow > 0) {
			for (const dropped of this.send_queue.splice(0, overflow)) {
				dropped.reject(new Error('queue overflow'));
			}
		}
		this.sending();
	};

	// Set from a frame write until the gap after it (TCP) or after its request ended (RTU) elapses
	#busy = false;
	#release(gap) {
		setTimeout(() => {
			this.#busy = false;
			this.sending();
		}, gap);
	}

	// The minimum gap before the next write; on a serial line never shorter than its silence
	get #gap() {
		return this.protocol === 'rtu' ? Math.max(this.delay, this.#receiver.silence) : this.delay;
	}

	sending() {
		if (this.#busy || this.send_queue.length === 0) return;
		if (this.is_connected) {
			this.#busy = true;
			this.#write(this.send_queue.shift());
		} else if (this.is_idle || this.is_connecting) {
			this.#start_connect(
				() => this.sending(),
				() => this.emit('error', 'send failed!'),
			);
		}
	}

	/**
	 * Writes the frame of a queued packet and starts its timeout. On TCP the next write may
	 * follow after the gap; on the RTU family only after the request ends (see `#transaction_ended`),
	 * or after `turnaround` for a broadcast, which resolves at once since it is never answered.
	 */
	#write(packet) {
		const rtu = this.protocol !== 'tcp';
		if (packet.broadcast) {
			this._send(packet.buffer);
			packet.resolve(packet.echo === undefined ? Buffer.alloc(0) : true);
			this.#release(Math.max(this.turnaround, this.#gap));
			return;
		}
		if (rtu) this.#current = packet;
		packet.timeout_id = setTimeout(packet.on_timeout, this.timeout);
		this._send(packet.buffer);
		if (!rtu) this.#release(this.#gap);
	}

	// Called once a request ends, however it ends
	#transaction_ended(packet) {
		if (packet !== this.#current) return;
		this.#current = null;
		this.#release(this.#gap);
	}

	/**
     * Rejects every pending request, written or queued, with `Error('connection lost')` and
     * discards the queued frames, so no request is executed after it was reported as failed.
     */
	abort_pending() {
		const queued = this.send_queue.splice(0);
		const written = this.protocol === 'tcp' ? this.#packets : [this.#current];
		for (const packet of [...queued, ...written]) {
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
			this.#transaction_ended(packet);
		};

		packet.status = 'pending';
		this.inc_trans_count();

		const promise = new Promise((resolve, reject) => {
			// Armed by `#write`, when the frame is written
			packet.on_timeout = () => {
				// Bytes of a late answer must not prefix the next response
				if (this.protocol !== 'tcp') this.#receiver.clear();
				end_transaction('rejected');
				this.emit('timeout');
				reject(new Error(`transaction 0x${packet.tid.toString(16)} timeout`));
				this.#count_timeout();
			};
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
		this.send(packet);
		return promise;
	}

	read(range, unit_id = 1) {
		return this.transact(plan_read(range, unit_id, this.modicon_zero_based));
	}

	write(range, value, unit_id = 1) {
		return this.transact(plan_write(range, value, unit_id, this.modicon_zero_based));
	}

	// Sends a request made by plan_read() / plan_write()
	transact({ unit_id, func_code, address, length, data }) {
		const tid = this.get_tid();
		const buffer = this.make_data_packet(tid, unit_id, func_code, address, data, length);
		const packet = {
			tid,
			unit_id,
			func_code,
			address,
			length,
			buffer,
			// The value a write response must echo; undefined for a read
			echo: expected_echo(func_code, data, length),
			// On a serial bus every request to unit 0 is a broadcast
			broadcast: this.protocol !== 'tcp' && unit_id === BROADCAST_ID,
			status: 'init',
		};
		// The RTU family has no transaction ID: its one written request is `#current`
		if (this.protocol === 'tcp') this.set_packet(tid, packet);

		return this.process_packet_transaction(packet);
	}

	// The frame receiver, created by the constructor
	#receiver;

	// Bytes received and not yet delimited
	get unprocessed_buffer() {
		return this.#receiver.rest;
	}

	/**
	 * Delimits the frames of a received chunk and settles the matching requests. The bytes of an
	 * incomplete frame are kept for the next chunk.
	 */
	on_data(chunk) {
		this.#receiver.push(chunk);
	}

	#on_frame(frame) {
		const tcp = this.protocol === 'tcp';
		const response = tcp ? parse_tcp_response(frame) : parse_rtu_response(frame);
		this.emit('receive', response.buffer);

		if (response.func_code === 0) return; // Invalid data
		// Any valid frame, from any unit, proves the peer alive
		this.#link_proved();

		const packet = tcp ? this.get_packet(response.tid) : this.#current;
		if (!packet || packet.status !== 'pending') return;
		if (!tcp && !response_fits(packet, response)) return;

		if (response.exception_code) {
			packet.reject(new Error(`response error: ${response.exception_code}`));
			return;
		}

		// A read resolves with its data, a write with whether the echo matches the request
		packet.resolve(packet.echo === undefined ? response.data : echo_matches(packet, response));
	}

	/**
	 * Builds the frame of a request. `start_address` is the PDU address, already converted from
	 * Modicon notation.
	 */
	make_data_packet(tid, unit_id, func_code, start_address, data, length) {
		const multiple = func_code === 15 || func_code === 16;
		const data_bytes = multiple ? data.length : 0;
		const body = Buffer.alloc(multiple ? 7 + data_bytes : 6);
		body.writeUInt8(unit_id, 0);
		body.writeUInt8(func_code, 1);
		body.writeUInt16BE(start_address, 2);
		switch (func_code) {
			case 5:
				body.writeUInt16BE(data ? 0xFF00 : 0x0000, 4);
				break;
			case 6:
				body.writeUInt16BE(data, 4);
				break;
			default:
				// FC 1..4: the quantity; FC 15 / 16: the quantity, byte count and data
				body.writeUInt16BE(length, 4);
				if (multiple) {
					body.writeUInt8(data_bytes, 6);
					data.copy(body, 7);
				}
		}
		return this.protocol === 'tcp' ? encode_tcp_frame(tid, body) : encode_rtu_frame(body);
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
		this.#reset_delay();
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

	// Waits the next delay, then reconnects; each back-off doubles the delay up to the bound
	#back_off() {
		const delay = this.#next_delay;
		this.#last_delay = delay;
		this.#next_delay = Math.min(delay * 2, Math.max(this.reconnect_max, this.reconnect_time));
		this.#state = STATE.BACKING_OFF;
		this.#reconnect_timer = setTimeout(() => {
			this.#reconnect_timer = null;
			this.#start_connect();
		}, delay);
	}

	// The back-off starts again from `reconnect_time`
	#reset_delay() {
		clearTimeout(this.#stable_timer);
		this.#stable_timer = null;
		this.#next_delay = this.reconnect_time;
		this.#last_delay = 0;
	}

	// A valid frame was received: the connection works
	#link_proved() {
		this.#timeouts = 0;
		this.#reset_delay();
	}

	/**
	 * Counts a timeout; `max_timeouts` in a row close a TCP-family connection as dead. Not on a
	 * serial port, where a timeout means a slave did not answer.
	 */
	#count_timeout() {
		if (this.protocol === 'rtu' || this.max_timeouts === 0 || !this.is_connected) return;
		this.#timeouts++;
		if (this.#timeouts < this.max_timeouts) return;
		// An ordinary loss: the transport's close rejects the pending requests and reconnects
		this.#timeouts = 0;
		this._close();
	}

	// Called by the transport once it is open
	#transport_opened() {
		// A serial open that settles after disconnect() is closed by `_close`
		if (!this.is_connecting) return;
		this.#receiver.clear();
		this.#timeouts = 0;
		// Open as long as the last back-off delay, the connection has proved itself
		if (this.#last_delay > 0) {
			this.#stable_timer = setTimeout(() => this.#reset_delay(), this.#last_delay);
		}
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
		this.#receiver.clear();
		clearTimeout(this.#stable_timer);
		this.#stable_timer = null;
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
		if (this.stream instanceof Socket) this.stream.destroy();
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
			if (this.keep_alive > 0) stream.setKeepAlive(true, this.keep_alive);
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
