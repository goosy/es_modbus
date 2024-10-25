import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
    TRANSACTION_START, DO_NOTHING,
    parse_address, parse_rtu_response, parse_tcp_response
} from './util.js';

export class Modbus_Client extends EventEmitter {
    zero_based;
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
        this.zero_based = options.zero_based ?? false;
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
    send(data) {
        this.send_queue.push(data);
        const overflow = this.send_queue.length - this.send_queue_size;
        if (overflow > 0) {
            this.send_queue.splice(0, overflow);
        }
        this.sending();
    };

    #busy = false;
    sending() {
        if (this.#busy) return;
        if (this.is_connected) {
            const buffer = this.send_queue.shift();
            if (buffer) {
                this.#busy = true;
                this._send(buffer);
                setTimeout(() => {
                    this.#busy = false;
                    this.sending();
                }, this.delay);
            }
        } else if (!this._conn_failed) {
            this._connect(
                this.sending,
                () => this.emit('error', "send failed!")
            );
        } else {
            this.emit('error', 'Attempting to transfer data when a connection could not be established.');
        }
    }

    process_packet_transaction(packet) {
        const end_transaction = (status) => {
            this.dec_trans_count();
            packet.status = status;
            packet.resolve = DO_NOTHING;
            packet.reject = DO_NOTHING;
            clearTimeout(packet.timeout_id);
        }

        packet.status = 'pending';
        this.inc_trans_count();
        this.send(packet.buffer);

        return new Promise((resolve, reject) => {
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
    }
    read(address_str, unit_id = 1) {
        const address_obj = parse_address(address_str);
        if (!address_obj) throw new Error('Invalid address format');

        const tid = this.get_tid();
        const func_code = address_obj.fm_read;
        const address = address_obj.address;
        const length = address_obj.length ?? 1;
        const buffer = this.make_data_packet(tid, 0, unit_id, func_code, address, null, length);
        const packet = {
            tid,
            unit_id,
            func_code,
            address,
            buffer,
            status: 'init',
        };
        this.set_packet(tid, packet);

        return this.process_packet_transaction(packet);
    }

    write(address_str, value, unit_id = 1) {
        const address_obj = parse_address(address_str);
        if (!address_obj) throw new Error('Invalid address format');

        const {
            fm_write, fs_write,
            address, length = value.length >> 1,
        } = address_obj;
        const tid = this.get_tid();
        let func_code;
        let buffer;

        if (fs_write && (length === 1 || Buffer.isBuffer(value) && value.length === 2)) {
            // Use single write function code (5 or 6)
            func_code = fs_write;
            if (func_code === 5 && typeof value !== 'boolean') {
                throw new Error('Invalid value for coil write');
            }
            // todo: Verify the correctness of the value for func_code === 6
            const data = Buffer.isBuffer(value) ? value.readUInt16BE(0) : value;
            buffer = this.make_data_packet(tid, 0, unit_id, func_code, address, data);
        } else if (fm_write) {
            // Use multiple write function code (15 or 16)
            func_code = fm_write;
            if (!Buffer.isBuffer(value)) {
                throw new Error('Multiple writes require a Buffer value');
            }
            if (func_code === 15) {
                // For coil writes, ensure value has the correct length
                if (value.length !== Math.ceil(length / 8)) {
                    throw new Error('Invalid buffer length for coil write');
                }
            } else if (func_code === 16) {
                // For register writes, ensure value has the correct length
                if (value.length !== length * 2) {
                    throw new Error('Invalid buffer length for register write');
                }
            }
            buffer = this.make_data_packet(tid, 0, unit_id, func_code, address, value, length);
        } else {
            throw new Error('Write operation not supported for this address type');
        }

        const packet = {
            tid,
            unit_id,
            func_code,
            address,
            buffer,
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

            packet.resolve(response.data);
        }
    }

    make_data_packet(trans_id, proto_id, unit_id, func_code, address, data, length) {
        if (typeof address !== 'number' && typeof address !== 'boolean') return null;
        const start_address = this.zero_based
            ? address
            : address === 0 ? 0xffff : address - 1;

        let dataBytes = 0;
        if (func_code === 15) { dataBytes = length; }
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
                tcp_buffer.writeInt16BE(data, 10);
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
            this.emit('error', error);
            this.is_connected = false;
        });

        serialport.on('close', () => {
            this.emit('disconnect');
            this.is_connected = false;
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
            this.reconnect();
            this.emit('error', error);
        });
    }
}
