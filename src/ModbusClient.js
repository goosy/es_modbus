import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
    TRANSACTION_START, DO_NOTHING,
    parse_address, parse_rtu_response, parse_tcp_response
} from './util.js';

export class Modbus_Client extends EventEmitter {
    zero_based;
    #last_tid = TRANSACTION_START;
    is_connected = false;
    packets = [];

    constructor(address, options = {}) {
        super();
        this.packets_length = 256;
        this.packets = [];

        const {
            port = 502,
            rtu = false,
            reconnect_time = 10000
        } = options;
        this.reconnect_time = reconnect_time;
        this.zero_based = options.zero_based ?? false;
        this.unprocessed_buffer = Buffer.alloc(0);

        if (typeof address === 'string') {
            this.set_tcp(address, port);
            this.protocol = rtu ? 'rtu_over_tcp' : 'tcp';
        } else {
            this.set_serial(address);
            this.protocol = 'rtu';
        }

        if (this.reconnect_time > 0) this._connect();
    }

    on_data(buffer) {
        const responses = this.protocol != "tcp"
            ? parse_rtu_response(buffer)
            : parse_tcp_response(buffer);

        responses.forEach((response) => {
            this.emit('receive', response.buffer);

            const packet = this.get_packet(response.tid);
            if (response.ecode) {
                packet.reject('Illegal Data Address');
            }

            packet.rx = response;
            packet.resolve(response.data);
        });
    }

    get_packet(tid) {
        return this.packets[tid - TRANSACTION_START];
    }
    set_packet(tid, packet) {
        this.packets[tid - TRANSACTION_START] = packet;
    }

    send(data) {
        if (this.is_connected) {
            this._send(data);
        } else if (!this._conn_failed) {
            this._connect(
                () => this._send(data),
                () => this.emit('error', "send failed!")
            );
        } else {
            this.emit('error', 'Attempting to transfer data when a connection could not be established.');
        }
    };

    read(address_str, unit_id) {
        unit_id ??= 1;
        const address = parse_address(address_str);
        if (!address) throw new Error('Invalid address format');

        const length = address.length ?? 1;
        const func_code = address.fm_read;
        const start_address = address.address;
        const tid = this.get_tid();
        const buffer = this.make_data_packet(tid, 0, unit_id, func_code, start_address, null, length);

        const packet = {
            tx: {
                func_code,
                tid,
                address: address.address,
                buffer,
            },
            rx: null,
        };
        this.set_packet(tid, packet);

        return new Promise((resolve, reject) => {
            this.send(buffer);
            packet.resolve = resolve;
            packet.reject = reject;
        });
    }

    write(address_str, value, unit_id) {
        unit_id ??= 1;
        const address = parse_address(address_str);
        if (!address) throw new Error('Invalid address format');

        const {
            fm_write, fs_write,
            address: start_address,
            length = value.length >> 1,
        } = address;
        const tid = this.get_tid();
        let func_code, buffer;

        if (fs_write && (length === 1 || Buffer.isBuffer(value) && value.length === 2)) {
            // Use single write function code (5 or 6)
            func_code = fs_write;
            const data = Buffer.isBuffer(value) ? value.readUInt16BE(0) : value;
            buffer = this.make_data_packet(tid, 0, unit_id, func_code, start_address, data);
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
            buffer = this.make_data_packet(tid, 0, unit_id, func_code, start_address, value, length);
        } else {
            throw new Error('Write operation not supported for this address type');
        }

        const packet = {
            tx: {
                func_code,
                tid,
                address: start_address,
                buffer,
            },
            rx: null,
        };
        this.set_packet(tid, packet);

        return new Promise((resolve, reject) => {
            this.send(buffer);
            packet.resolve = resolve;
            packet.reject = reject;
        });
    }

    get_tid() {
        if (this.protocol !== 'tcp') return TRANSACTION_START;
        this.#last_tid++;
        if (this.#last_tid > this.packets_length + TRANSACTION_START) this.#last_tid = TRANSACTION_START;
        return this.#last_tid;
    }

    make_data_packet(trans_id, proto_id, unit_id, func_code, address, data, length) {
        if (typeof data == "boolean" && data) { data = 1; }
        if (typeof data == "boolean" && !data) { data = 0; }
        if (!this.zero_based) address = address === 0 ? 0xffff : address - 1;

        let dataBytes = 0;
        if (func_code == 15) { dataBytes = length; }
        if (func_code == 16) { dataBytes = length * 2; }

        let buffer_length = 12;
        if (func_code == 15 || func_code == 16) { buffer_length = 13 + dataBytes; }
        const byte_count = buffer_length - 6;

        const tcp_pdu = Buffer.alloc(buffer_length);

        tcp_pdu.writeUInt16BE(trans_id, 0);
        tcp_pdu.writeUInt16BE(proto_id, 2);
        tcp_pdu.writeUInt16BE(byte_count, 4);
        tcp_pdu.writeUInt8(unit_id, 6);
        tcp_pdu.writeUInt8(func_code, 7);
        tcp_pdu.writeUInt16BE(address, 8);

        if (func_code == 1 || func_code == 2 || func_code == 3 || func_code == 4) {
            tcp_pdu.writeUInt16BE(length, 10);
        }
        if (func_code == 5 || func_code == 6) {
            tcp_pdu.writeInt16BE(data, 10);
        }
        if (func_code == 15 || func_code == 16) {
            tcp_pdu.writeInt16BE(length, 10);
            tcp_pdu.writeUInt8(dataBytes, 12);
            data.copy(tcp_pdu, 13, 0, dataBytes);
        }

        if (this.protocol == 'tcp') return tcp_pdu;

        const rtu_data = tcp_pdu.subarray(6);
        const crc = modbus_crc16(rtu_data);
        const rtu_pdu = Buffer.alloc(rtu_data.length + 2, rtu_data);
        rtu_pdu.writeUInt16LE(crc, rtu_data.length);

        return rtu_pdu;
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
            get: function () {
                return stream.connecting;
            },
            configurable: true,
            enumerable: true,
        });

        this._send = (data) => {
            stream.write(data);
            this.emit('send', data);
        }

        this._connect = (on_connect, on_error) => {
            on_connect ??= DO_NOTHING;
            on_error ??= DO_NOTHING;
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
