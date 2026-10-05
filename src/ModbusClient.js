import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
    TRANSACTION_START, DO_NOTHING, MAX_QUANTITY,
    modbus_crc16, parse_modicon_range, parse_pdu_range,
    parse_rtu_response, parse_tcp_response
} from './util.js';

const BROADCAST_ID = 0;

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
    is_connected = false;
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
            reconnect_time = 10000
        } = options;
        this.reconnect_time = reconnect_time;
        this.#modicon_zero_based = options.modicon_zero_based ?? false;
        this.unprocessed_buffer = Buffer.alloc(0);
        this.timeout = options.timeout ?? 1000;
        this.delay = options.delay ?? 20;

        if (typeof address === 'string') {
            this.set_tcp(address, port);
            this.protocol = rtu ? 'rtu_over_tcp' : 'tcp';
        } else {
            this.set_serial(address);
            this.protocol = 'rtu';
        }

        if (this.reconnect_time > 0) this._connect();
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
        } else if (!this._conn_failed) {
            this._connect(
                () => this.sending(),
                () => this.emit('error', "send failed!")
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
        if (this._conn_failed) {
            // A request issued during a reconnect back-off fails at once and is never queued
            packet.status = 'rejected';
            // Emitted only when listened to, so a valid call never throws synchronously
            if (this.listenerCount('error') > 0) {
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
        }

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

    on_data(buffer) {
        const responses = this.protocol !== "tcp"
            ? parse_rtu_response(buffer)
            : parse_tcp_response(buffer);

        for (const response of responses) {
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
            if (this.is_connected) {
                resolve();
            } else if (this._conn_failed) {
                reject(new Error('ERR_ILLEGAL_STATE'));
            } else {
                this._connect(resolve, reject);
            }
        });
    };
    reconnect() {
        if (this.reconnect_time > 0) {
            if (this._conn_failed) return;
            this._conn_failed = true;
            setTimeout(() => {
                this._conn_failed = false;
                this._connect();
            }, this.reconnect_time);
        } else {
            this._conn_failed = false;
        }
    };

    /**
     * Initializes a new SerialPort and sets up some function.
     * @todo not finished
     *
     * @param {SerialPort} serialport - a SerialPort instance.
     * @return {void}
     */
    set_serial(serialport) {
        this.stream = serialport;

        this._send = async (data) => {
            serialport.write(data);
            this.emit('send', data);
        };

        serialport.on('data', (data) => {
            this.on_data(data);
        });

        serialport.on('error', (error) => {
            this.is_connected = false;
            this.abort_pending();
            this.emit('error', error);
        });

        serialport.on('close', () => {
            this.is_connected = false;
            this.abort_pending();
            this.emit('disconnect');
        });

        this.connect = () => serialport.open();
        this.disconnect = () => serialport.close();
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

        Object.defineProperty(this, 'connecting', {
            get: () => stream.connecting,
            configurable: true,
            enumerable: true,
        });

        this._send = (data) => {
            stream.write(data);
            this.emit('send', data);
        }
        this._connect = (on_connect = DO_NOTHING, on_error = DO_NOTHING) => {
            const _on_connect = () => {
                stream.off('error', _on_error);
                on_connect();
            }
            const _on_error = (error) => {
                stream.off('connect', _on_connect);
                on_error(error);
            }
            stream.once('connect', _on_connect);
            stream.once('error', _on_error);
            if (!this.connecting) {
                stream.connect(port, ip_address);
            }
        }
        this.disconnect = () => stream.end();

        stream.on('data', (data) => {
            this.on_data(data);
        });

        stream.on('close', () => {
            this.is_connected = false;
            this.abort_pending();
            this.reconnect();
            this.emit('disconnect');
        });

        stream.on('connect', () => {
            this.is_connected = true;
            this._conn_failed = false;
            this.emit('connect');
        });

        stream.on('error', (error) => {
            this.is_connected = false;
            this.abort_pending();
            this.reconnect();
            this.emit('error', error);
        });
    }
}
