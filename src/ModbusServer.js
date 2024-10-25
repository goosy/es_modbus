import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { modbus_crc16, parse_tcp_request, parse_rtu_request } from './util.js';

export class Modbus_Server extends EventEmitter {
    initialized = false;
    unit_ids = null;
    accept_all_units = true;

    constructor(vector, options) {
        super();
        this.vector = vector;
        this.set_unit_ids(options.unit_id ?? 0);
        this.host = options.host ?? '0.0.0.0';
        this.port = options.port ?? 502;
        this.sockets = new Set();
    }

    set_unit_ids(unit_id) {
        if (Array.isArray(unit_id)) {
            this.accept_all_units = false;
            this.unit_ids = new Set(unit_id);
        } else if (unit_id !== 0) {
            this.accept_all_units = false;
            this.unit_ids = new Set([unit_id]);
        }
    }

    is_valid_unit_id(unit_id) {
        return this.accept_all_units || this.unit_ids.has(unit_id);
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
        const {
            tid, pid, unit_id, func_code,
            start_address, quantity,
            data
        } = request;

        if (!this.is_valid_unit_id(unit_id)) {
            // If the unit_id is invalid, send an error response or ignore the request.
            // 0x11: Gateway Target Device Failed Response
            this.send_exception_response(unit_id, func_code, 0x11, socket, tid, pid);
            return;
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
                response = this.handle_write_single_coil(start_address, quantity, unit_id);
                break;
            case 6: // Write Single Register
                response = this.handle_write_single_register(start_address, quantity, unit_id);
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

        this.send_response(response, socket, tid, pid);
    }

    on_data(buffer, socket) {
        const requests = socket
            ? parse_tcp_request(buffer)
            : parse_rtu_request(buffer);

        for (const request of requests) {
            this.emit('receive', request.buffer);
            this._on_data(request, socket);
        }
    }

    send_response(response, socket, transaction_id, protocol_id) {
        const data_length = response.length;
        if (socket) {
            // Modbus TCP: add MBAP header
            const full_response = Buffer.alloc(data_length + 6);
            full_response.writeUInt16BE(transaction_id, 0);
            full_response.writeUInt16BE(protocol_id, 2);
            full_response.writeUInt16BE(response.length, 4);
            response.copy(full_response, 6, 0);
            this.emit('send', full_response);
            socket.write(full_response);
        } else {
            // Modbus RTU: add CRC
            const crc = modbus_crc16(response);
            const full_response = Buffer.alloc(data_length + 2, response);
            full_response.writeUInt16LE(crc, data_length);
            this.emit('send', full_response);
            this.port.write(full_response);
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
        const buffer = Buffer.alloc(3 + byteCount);
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
        this.vector.setCoil(address, value === 0xFF00, unit_id);

        const buffer = Buffer.alloc(6);
        buffer.writeUInt8(unit_id, 0);
        buffer.writeUInt8(5, 1);
        buffer.writeUInt16BE(address, 2);
        buffer.writeUInt16BE(value, 4);

        return buffer;
    }

    handle_write_single_register(address, value, unit_id) {
        this.vector.setRegister(address, value, unit_id);

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
            this.vector.setCoil(start_address + i, value, unit_id);
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
            this.vector.setRegister(start_address + i, value, unit_id);
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
