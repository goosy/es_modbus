import { Socket, createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { crc16modbus } from 'crc';

const TRANSACTION_START = 8000;

function parse_address(address_str) {
    const match = address_str.match(/^(\d{5})(,(\d{1,4}))?$/);
    if (!match) return null;

    const address = parseInt(match[1].substr(1), 10);
    if (address <= 0 || address > 65535) return null;

    const length = match[3] ? parseInt(match[3], 10) : 1;

    const prefix = match[1].substring(0, 1);
    const address_map = {
        '0': {
            fm_read: 1,
            fs_write: 5,
            fm_write: 15,
            type: 'coils',
        },
        '1': {
            fm_read: 2,
            type: 'discrete_inputs',
        },
        '4': {
            fm_read: 3,
            fs_write: 6,
            fm_write: 16,
            type: 'holding_registers',
        },
        '3': {
            fm_read: 4,
            type: 'input_registers',
        },
    }

    return { ...address_map[prefix], address, length };
}


function parse_rtu(res_buffer) {
    const tid = TRANSACTION_START;
    const unit_id = res_buffer.readInt8(0)                   // Unit Id
    const func_code = res_buffer.readInt8(1)                 // Function Code
    const byte_count = Math.abs(res_buffer.readInt8(2))      // Byte Count
    const buffer = res_buffer.subarray(3, 3 + byte_count);
    // @todo ecode
    const ecode = null;
    return { tid, unit_id, func_code, byte_count, buffer, ecode };
}

function parse_tcp(res_buffer) {
    const tid = res_buffer.readUInt16BE(0)                      // Transaction Id
    const pid = res_buffer.readUInt16BE(2)                      // Protocal Id
    const length = res_buffer.readUInt16BE(4)                   // Length
    const unit_id = res_buffer.readInt8(6)                      // Unit Id
    const func_code = res_buffer.readInt8(7)                    // Function Code
    const byte_count = Math.abs(res_buffer.readInt8(8))         // Byte Count
    const buffer = res_buffer.subarray(9);
    // @todo crc
    // @todo ecode
    const ecode = null;
    return { tid, pid, length, unit_id, func_code, byte_count, buffer, ecode };
}

export class Modbus_Client extends EventEmitter {
    zero_based = false;
    #last_tid = TRANSACTION_START;
    is_connected = false;
    packets = [];

    constructor(address, { port = 502, rtu = false } = {}) {
        super();
        this.packets_length = 256;
        this.packets = [];

        if (typeof address === 'string') {
            this.set_tcp(address, port);
            this.protocol = rtu ? 'rtu_over_tcp' : 'tcp';
        } else {
            this.set_serial(address);
            this.protocol = 'rtu';
        }
    }

    on_data(buffer) {
        this.emit('transport', 'rx:' + buffer.toString('hex'));

        const response = this.protocol != "tcp"
            ? parse_rtu(buffer)
            : parse_tcp(buffer);

        const packet = this.get_packet(response.tid);
        if (response.ecode) {
            packet.promise_reject('Illegal Data Address');
        }

        packet.rx = response;
        packet.promise_resolve(response.buffer)
    }

    get_packet(tid) {
        return this.packets[tid - TRANSACTION_START];
    }
    set_packet(tid, packet) {
        this.packets[tid - TRANSACTION_START] = packet;
    }

    read(address_str, unit_id) {
        unit_id ??= 1;
        const address = parse_address(address_str);
        if (!address) throw new Error('Invalid address format');

        const length = address.length;
        const func_code = address.fm_read;
        const start_address = address.address;
        const tid = this.get_tid();
        const buffer = this.make_data_packet(tid, 0, unit_id, func_code, start_address, null, length);

        this.set_packet(tid, {
            tx: {
                func_code,
                tid,
                address: address.address,
                buffer,
            },
            rx: null,
        });

        return new Promise((resolve, reject) => {
            this.send(buffer);
            this.emit('transport', 'tx:' + buffer.toString('hex'));
            const packet = this.get_packet(tid);
            packet.promise_resolve = resolve;
            packet.promise_reject = reject;
        });
    }

    write(address_str, value, unit_id) {
        unit_id ??= 1;
        const address = parse_address(address_str);
        if (!address) throw new Error('Invalid address format');

        const { fm_write, fs_write, address: start_address, length } = address;
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

        this.set_packet(tid, {
            tx: {
                func_code,
                tid,
                address: start_address,
                buffer,
            },
            rx: null,
        });

        return new Promise((resolve, reject) => {
            this.send(buffer);
            this.emit('transport', 'tx:' + buffer.toString('hex'));
            const packet = this.get_packet(tid);
            packet.promise_resolve = resolve;
            packet.promise_reject = reject;
        });
    }

    get_tid() {
        if (this.protocol !== 'tcp') return TRANSACTION_START;
        this.#last_tid++;
        if (this.#last_tid > this.packets_length + TRANSACTION_START) this.#last_tid = TRANSACTION_START;
        return this.#last_tid;
    }

    make_data_packet(trans_id, proto_id, unit_id, func_code, address, data, length) {
        if (typeof data == "boolean" && data) { data = 1 }
        if (typeof data == "boolean" && !data) { data = 0 }
        if (!this.zero_based) address = address === 0 ? 0xffff : address - 1;

        let dataBytes = 0;
        if (func_code == 15) { dataBytes = length }
        if (func_code == 16) { dataBytes = length * 2 }

        let buffer_length = 12;
        if (func_code == 15 || func_code == 16) { buffer_length = 13 + dataBytes }
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
        const crc = crc16modbus(rtu_data);
        const rtu_pdu = Buffer.alloc(rtu_data.length + 2, rtu_data);
        rtu_pdu.writeUInt16LE(crc, rtu_data.length);

        return rtu_pdu;
    }

    /**
     * Initializes a new SerialPort and sets up the send function.
     *
     * @param {SerialPort} serialport - a SerialPort instance.
     * @return {void}
     */
    set_serial(serialport) {
        this.stream = serialport;

        this.send = async (data) => {
            serialport.write(data);
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

    set_tcp(ip_address, port) {
        this.ip_address = ip_address;
        this.port = port;

        const stream = new Socket();
        this.stream = stream;

        let is_connecting = false;
        const connect = promisify(stream.connect.bind(stream));

        this.send = (data) => {
            if (this.is_connected) {
                stream.write(data);
            } else {
                this.connect();
                this.once('connect', () => {
                    stream.write(data);
                });
            }
        };

        this.connect = () => {
            if (is_connecting) return new Promise((resolve) => {
                stream.once('connect', () => resolve());
            });
            is_connecting = true;
            return connect(port, ip_address);
        };
        this.disconnect = () => stream.destroy();

        stream.on('data', (data) => {
            this.on_data(data);
            this.emit('data');
        });

        stream.on('close', () => {
            this.is_connected = false;
            is_connecting = false;
            this.emit('disconnect');
        });

        stream.on('connect', () => {
            this.is_connected = true;
            is_connecting = false;
            this.emit('connect');
        });

        stream.on('error', (error) => {
            this.is_connected = false;
            is_connecting = false;
            this.emit('error', error);
        });
    }
}

export class Modbus_Server extends EventEmitter {
    initialized = false;

    constructor(vector, options) {
        super();
        this.vector = vector;
        this.unit_id = options.unit_id ?? 1;
        this.host = options.host ?? '0.0.0.0';
        this.port = options.port ?? 502;
        this.sockets = new Set();
    }

    start() {
        if (this.initialized) {
            if (typeof this.port === 'number') {
                if (this.server.listening) this.server.close();
                this.server.listen(this.port, this.host);
            } else {
                if (this.port.isOpen) this.port.close();
                this.port.open();
            }
            return;
        }

        if (typeof this.port === 'number') {
            this.set_tcp();
            this.server.listen(this.port, this.host);
        } else {
            this.set_rtu();
            this.port.open();
        }
        this.initialized = true;
    }

    set_rtu() {
        this.port.on('open', () => {
            this.emit('started');
        });
        this.port.on('data', (data) => this.on_data(data));
        this.port.on('error', (err) => this.emit('error', err));
        this.port.on('close', () => {
            this.emit('closed');
        });
    }

    set_tcp() {
        this.server = createServer();

        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('data', (data) => this.on_data(data, socket));
            socket.on('error', (err) => this.emit('socketError', err));
            socket.on('close', () => {
                this.sockets.delete(socket);
                this.emit('clientDisconnected', socket);
            });
        });
        this.server.on('listening', () => {
            this.emit('started');
        });
        this.server.on('error', (err) => this.emit('error', err));
        this.server.on('close', () => {
            this.emit('closed');
        });
    }

    on_data(data, socket) {
        const unit_id = data[0];
        const function_code = data[1];
        const start_address = data.readUInt16BE(2);
        const quantity = data.readUInt16BE(4);

        let response;
        switch (function_code) {
            case 1: // Read Coils
            case 2: // Read Discrete Inputs
                response = this.handle_read_bits(function_code, start_address, quantity, unit_id);
                break;
            case 3: // Read Holding Registers
            case 4: // Read Input Registers
                response = this.handle_read_registers(function_code, start_address, quantity, unit_id);
                break;
            case 5: // Write Single Coil
                response = this.handle_write_single_coil(start_address, data.readUInt16BE(4), unit_id);
                break;
            case 6: // Write Single Register
                response = this.handle_write_single_register(start_address, data.readUInt16BE(4), unit_id);
                break;
            case 15: // Write Multiple Coils
                response = this.handle_write_multiple_coils(start_address, quantity, data.slice(7), unit_id);
                break;
            case 16: // Write Multiple Registers
                response = this.handle_write_multiple_registers(start_address, quantity, data.slice(7), unit_id);
                break;
            default:
                response = this.create_error_response(function_code, 0x01); // Illegal Function
        }

        if (socket) {
            socket.write(response);
        } else {
            this.port.write(response);
        }
    }

    handle_read_bits(function_code, start_address, quantity, unit_id) {
        const values = [];
        for (let i = 0; i < quantity; i++) {
            const addr = start_address + i;
            const value = function_code === 1
                ? this.vector.getCoil(addr, unit_id)
                : this.vector.getInputRegister(addr, unit_id) & 1;
            values.push(value ? 1 : 0);
        }

        const byteCount = Math.ceil(quantity / 8);
        const buffer = Buffer.alloc(5 + byteCount);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(function_code, 1);
        buffer.writeUInt8(byteCount, 2);

        for (let i = 0; i < byteCount; i++) {
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
                ? this.vector.getHoldingRegister(addr, unit_id)
                : this.vector.getInputRegister(addr, unit_id);
            values.push(value);
        }

        const buffer = Buffer.alloc(5 + quantity * 2);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(function_code, 1);
        buffer.writeUInt8(quantity * 2, 2);

        for (let i = 0; i < quantity; i++) {
            buffer.writeUInt16BE(values[i], 3 + i * 2);
        }

        return buffer;
    }

    handle_write_single_coil(address, value, unit_id) {
        this.vector.setCoil(address, value === 0xFF00, unit_id);

        const buffer = Buffer.alloc(8);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(5, 1);
        buffer.writeUInt16BE(address, 2);
        buffer.writeUInt16BE(value, 4);

        return buffer;
    }

    handle_write_single_register(address, value, unit_id) {
        this.vector.setRegister(address, value, unit_id);

        const buffer = Buffer.alloc(8);
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
            this.vector.setCoil(start_address + i, value, unit_id);
        }

        const buffer = Buffer.alloc(8);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(15, 1);
        buffer.writeUInt16BE(start_address, 2);
        buffer.writeUInt16BE(quantity, 4);

        return buffer;
    }

    handle_write_multiple_registers(start_address, quantity, data, unit_id) {
        for (let i = 0; i < quantity; i++) {
            const value = data.readUInt16BE(i * 2);
            this.vector.setRegister(start_address + i, value, unit_id);
        }

        const buffer = Buffer.alloc(8);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(16, 1);
        buffer.writeUInt16BE(start_address, 2);
        buffer.writeUInt16BE(quantity, 4);

        return buffer;
    }

    create_error_response(function_code, exception_code) {
        const buffer = Buffer.alloc(5);
        buffer.writeUInt8(this.unit_id, 0);
        buffer.writeUInt8(function_code + 0x80, 1);
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
        } else if (this.port) {
            this.port.close();
        }
    }
}
