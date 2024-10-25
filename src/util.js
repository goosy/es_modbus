export const TRANSACTION_START = 8000;
export const DO_NOTHING = () => { };

const TABLE = new Int32Array([
    0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241,
    0xc601, 0x06c0, 0x0780, 0xc741, 0x0500, 0xc5c1, 0xc481, 0x0440,
    0xcc01, 0x0cc0, 0x0d80, 0xcd41, 0x0f00, 0xcfc1, 0xce81, 0x0e40,
    0x0a00, 0xcac1, 0xcb81, 0x0b40, 0xc901, 0x09c0, 0x0880, 0xc841,
    0xd801, 0x18c0, 0x1980, 0xd941, 0x1b00, 0xdbc1, 0xda81, 0x1a40,
    0x1e00, 0xdec1, 0xdf81, 0x1f40, 0xdd01, 0x1dc0, 0x1c80, 0xdc41,
    0x1400, 0xd4c1, 0xd581, 0x1540, 0xd701, 0x17c0, 0x1680, 0xd641,
    0xd201, 0x12c0, 0x1380, 0xd341, 0x1100, 0xd1c1, 0xd081, 0x1040,
    0xf001, 0x30c0, 0x3180, 0xf141, 0x3300, 0xf3c1, 0xf281, 0x3240,
    0x3600, 0xf6c1, 0xf781, 0x3740, 0xf501, 0x35c0, 0x3480, 0xf441,
    0x3c00, 0xfcc1, 0xfd81, 0x3d40, 0xff01, 0x3fc0, 0x3e80, 0xfe41,
    0xfa01, 0x3ac0, 0x3b80, 0xfb41, 0x3900, 0xf9c1, 0xf881, 0x3840,
    0x2800, 0xe8c1, 0xe981, 0x2940, 0xeb01, 0x2bc0, 0x2a80, 0xea41,
    0xee01, 0x2ec0, 0x2f80, 0xef41, 0x2d00, 0xedc1, 0xec81, 0x2c40,
    0xe401, 0x24c0, 0x2580, 0xe541, 0x2700, 0xe7c1, 0xe681, 0x2640,
    0x2200, 0xe2c1, 0xe381, 0x2340, 0xe101, 0x21c0, 0x2080, 0xe041,
    0xa001, 0x60c0, 0x6180, 0xa141, 0x6300, 0xa3c1, 0xa281, 0x6240,
    0x6600, 0xa6c1, 0xa781, 0x6740, 0xa501, 0x65c0, 0x6480, 0xa441,
    0x6c00, 0xacc1, 0xad81, 0x6d40, 0xaf01, 0x6fc0, 0x6e80, 0xae41,
    0xaa01, 0x6ac0, 0x6b80, 0xab41, 0x6900, 0xa9c1, 0xa881, 0x6840,
    0x7800, 0xb8c1, 0xb981, 0x7940, 0xbb01, 0x7bc0, 0x7a80, 0xba41,
    0xbe01, 0x7ec0, 0x7f80, 0xbf41, 0x7d00, 0xbdc1, 0xbc81, 0x7c40,
    0xb401, 0x74c0, 0x7580, 0xb541, 0x7700, 0xb7c1, 0xb681, 0x7640,
    0x7200, 0xb2c1, 0xb381, 0x7340, 0xb101, 0x71c0, 0x7080, 0xb041,
    0x5000, 0x90c1, 0x9181, 0x5140, 0x9301, 0x53c0, 0x5280, 0x9241,
    0x9601, 0x56c0, 0x5780, 0x9741, 0x5500, 0x95c1, 0x9481, 0x5440,
    0x9c01, 0x5cc0, 0x5d80, 0x9d41, 0x5f00, 0x9fc1, 0x9e81, 0x5e40,
    0x5a00, 0x9ac1, 0x9b81, 0x5b40, 0x9901, 0x59c0, 0x5880, 0x9841,
    0x8801, 0x48c0, 0x4980, 0x8941, 0x4b00, 0x8bc1, 0x8a81, 0x4a40,
    0x4e00, 0x8ec1, 0x8f81, 0x4f40, 0x8d01, 0x4dc0, 0x4c80, 0x8c41,
    0x4400, 0x84c1, 0x8581, 0x4540, 0x8701, 0x47c0, 0x4680, 0x8641,
    0x8201, 0x42c0, 0x4380, 0x8341, 0x4100, 0x81c1, 0x8081, 0x4040,
]);

export const modbus_crc16 = (current, previous) => {
    let crc = typeof previous !== 'undefined' ? ~~previous : 0xffff;
    for (let index = 0; index < current.length; index++) {
        crc = (TABLE[(crc ^ current[index]) & 0xff] ^ (crc >> 8)) & 0xffff;
    }
    return crc;
};

const MB_prefix_dict = {
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
};

export function parse_address(address_str) {
    const match = address_str.match(/^(\d{5})(,(\d{1,4}))?$/);
    if (!match) return null;

    const address = Number.parseInt(match[1].substr(1), 10);
    if (address <= 0 || address > 65535) return null;

    const length = match[3] ? Number.parseInt(match[3], 10) : undefined;
    const MB_object = MB_prefix_dict[match[1].substring(0, 1)];
    return { ...MB_object, address, length };
}

/**
 * Parses a Modbus RTU request buffer.
 * 
 * This function extracts and interprets the various fields of a Modbus RTU request,
 * including the function-specific data and CRC.
 * 
 * @param {Buffer} buffer - The buffer containing the Modbus RTU request.
 * @returns {Array} An array containing an object with the parsed request data:
 *   - tid: Transaction ID (always TRANSACTION_START for RTU)
 *   - unit_id: Unit ID
 *   - func_code: Function code
 *   - start_address: Starting address
 *   - quantity: Quantity of registers/coils (for read/write multiple functions)
 *   - byte_count: Byte count (for write multiple functions)
 *   - data: Write data (for write functions)
 *   - buffer: The original buffer
 */
export function parse_rtu_request(buffer) {
    const PDU_length = buffer.length - 2;          // Length of PDU
    // PDU length must be between 3-253
    if (PDU_length < 3 || PDU_length > 253) {
        return [{ tid: TRANSACTION_START, func_code: 0, buffer }];
    }

    const tid = TRANSACTION_START;                 // Transaction Id
    const unit_id = buffer.readUInt8(0);           // Unit Id
    let func_code = buffer.readUInt8(1);           // Function Code
    const start_address = buffer.readUInt16BE(2);  // Start Address
    let quantity;                                  // Quantity of registers/coils
    let byte_count = 0;                            // Byte count of the data
    let data;                                      // Data to write

    // Currently,then func_code only support 1, 2, 3, 4, 5, 6, 15, and 16
    switch (func_code) {
        case 1:
        case 2:
        case 3:
        case 4:
            // Read functions
            // Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers
            if (PDU_length !== 6) {
                func_code = 0;  // Invalid packet length
                break;
            }
            quantity = buffer.readUInt16BE(4);
            break;
        case 5:
        case 6:
            // Single write functions
            // Write Single Coil, Write Single Register
            if (PDU_length !== 6) {
                func_code = 0;  // Invalid packet length
                break;
            }
            data = buffer.readUInt16BE(4);
            break;
        case 15:
        case 16:
            // Multiple write functions
            // Write Multiple Coils, Write Multiple Registers
            if (PDU_length < 7) {
                func_code = 0;  // Invalid packet length for multiple write request
                break;
            }
            quantity = buffer.readUInt16BE(4);
            byte_count = buffer.readUInt8(6);
            if (PDU_length !== 7 + byte_count) {
                func_code = 0;  // Invalid packet length for multiple write data
                break;
            }
            data = buffer.subarray(7, PDU_length);  // Data to write
            break;
        default:
            func_code = 0;  // Invalid function code
            break;
    }

    // Verify CRC
    if (func_code !== 0) {
        const calculatedCRC = modbus_crc16(buffer.subarray(0, PDU_length));
        const receivedCRC = buffer.readUInt16LE(PDU_length);
        if (calculatedCRC !== receivedCRC) {
            func_code = 0;
        }
    }

    return [{
        tid, unit_id, func_code,
        start_address, quantity, byte_count,
        data, buffer
    }];
}

/**
 * Parses a Modbus RTU response buffer.
 * 
 * This function extracts and interprets the various fields of a Modbus RTU response,
 * including the function-specific data and CRC.
 * 
 * @param {Buffer} buffer - The buffer containing the Modbus RTU response.
 * @returns {Array} An array containing an object with the parsed response data:
 *   - tid: Transaction ID (always TRANSACTION_START for RTU)
 *   - unit_id: Unit ID
 *   - func_code: Function code
 *   - byte_count: Byte count (for read functions)
 *   - start_address: Starting address (for write functions)
 *   - quantity: Quantity of registers/coils (for write multiple functions)
 *   - data: Read data or written data
 *   - exception_code: Exception code (if it's an exception response)
 *   - buffer: The original buffer
 */
export function parse_rtu_response(buffer) {
    const PDU_length = buffer.length - 2;
    if (PDU_length < 3 || PDU_length > 253) {  // PDU length must be between 3-253
        return [{ tid: TRANSACTION_START, func_code: 0, buffer }];
    }

    const tid = TRANSACTION_START;
    const unit_id = buffer.readUInt8(0);    // Unit ID
    let func_code = buffer.readUInt8(1);    // Function Code
    let start_address;                      // Written address
    let quantity;                           // Quantity of registers/coils
    let byte_count = 0;                     // Byte count of the data
    let data;                               // Data to write (excluding CRC)
    let exception_code;                     // Exception code

    switch (func_code) {
        case 1:
        case 2:
        case 3:
        case 4:
            // Read function response
            byte_count = buffer.readUInt8(2);
            if (PDU_length !== byte_count + 3) {
                func_code = 0; // Invalid packet length
                break;
            }
            data = buffer.subarray(3, PDU_length);
            break;
        case 5:
        case 6:
            // Single write function response
            if (PDU_length !== 6) {
                func_code = 0; // Invalid packet length
                break;
            }
            start_address = buffer.readUInt16BE(2);
            data = buffer.readUInt16BE(4);
            break;
        case 15:
        case 16:
            // Multiple write function response
            if (PDU_length !== 6) {
                func_code = 0; // Invalid packet length
                break;
            }
            start_address = buffer.readUInt16BE(2);
            quantity = buffer.readUInt16BE(4);
            break;
        default:
            if (func_code > 127 && PDU_length === 3) {
                // Exception response
                exception_code = buffer.readUInt8(2);
                break;
            }
            func_code = 0; // Invalid packet length
            break;
    }

    // Verify CRC
    if (func_code !== 0) {
        const calculatedCRC = modbus_crc16(buffer.subarray(0, PDU_length));
        const receivedCRC = buffer.readUInt16LE(PDU_length);
        if (calculatedCRC !== receivedCRC) {
            func_code = 0;
        }
    }

    return [{
        tid, unit_id, func_code,
        start_address, quantity, byte_count,
        data, exception_code, buffer
    }];
}

/**
 * Parses a Modbus TCP request buffer.
 * 
 * This function extracts and interprets the various fields of a Modbus TCP request,
 * including the MBAP header and the function-specific data.
 * 
 * @param {Buffer} buffer - The buffer containing the Modbus TCP request.
 * @returns {Object} An object containing the parsed request data:
 *   - tid: Transaction ID
 *   - pid: Protocol ID
 *   - length: Length of the remaining message
 *   - unit_id: Unit ID
 *   - func_code: Function code
 *   - start_address: Starting address (for applicable function codes)
 *   - quantity: Quantity of registers/coils (for applicable function codes)
 *   - byte_count: Byte count (for write multiple functions)
 *   - data: Data to be written (for write functions)
 *   - buffer: The original buffer
 */
function parse_mt_request(buffer) {
    const PDU_length = buffer.readUInt16BE(4);     // Length of PDU
    // PDU length must be between 3-253
    if (PDU_length < 3 || PDU_length > 253) {
        return [{ tid: TRANSACTION_START, func_code: 0, buffer }];
    }

    const tid = buffer.readUInt16BE(0);            // Transaction Id
    const pid = buffer.readUInt16BE(2);            // Protocol Id
    const unit_id = buffer.readUInt8(6);           // Unit Id
    let func_code = buffer.readUInt8(7);           // Function Code
    const start_address = buffer.readUInt16BE(8);  // Start Address
    let quantity;                                  // Quantity of registers/coils
    let byte_count = 0;                            // Byte count of the data
    let data;                                      // Data to write

    // Currently,then func_code only support 1, 2, 3, 4, 5, 6, 15, and 16
    switch (func_code) {
        case 1:
        case 2:
        case 3:
        case 4:
            // Read function request
            // Read Coils, Read Discrete Inputs, Read Holding Registers, Read Input Registers
            if (PDU_length !== 6) {
                func_code = 0;  // Invalid length for read request
                break;
            }
            quantity = buffer.readUInt16BE(10);
            break;
        case 5:
        case 6:
            // Single write function request
            // Write Single Coil, Write Single Register
            if (PDU_length !== 6) {
                func_code = 0;  // Invalid length for single write request
                break;
            }
            data = buffer.readUInt16BE(10);
            break;
        case 15:
        case 16:
            // Multiple write function request
            // Write Multiple Coils, Write Multiple Registers
            if (PDU_length < 7) {
                func_code = 0;  // Invalid length for multiple write request
                break;
            }
            quantity = buffer.readUInt16BE(10);
            byte_count = buffer.readUInt8(12);
            if (PDU_length !== 7 + byte_count) {
                func_code = 0;  // Invalid length for multiple write data
                break;
            }
            data = buffer.subarray(13, 13 + byte_count);  // Data to write
            break;
        default:
            func_code = 0; // Invalid packet length
            break;
    }

    return {
        tid, pid,
        unit_id, func_code,
        start_address, quantity, byte_count,
        data, buffer
    };
}

/**
 * Parses a Modbus TCP response buffer.
 * 
 * This function extracts and interprets the various fields of a Modbus TCP response,
 * including the MBAP header and the function-specific data.
 * 
 * @param {Buffer} buffer - The buffer containing the Modbus TCP response.
 * @returns {Object} An object containing the parsed response data:
 *   - tid: Transaction ID
 *   - pid: Protocol ID
 *   - length: Length of the remaining message
 *   - unit_id: Unit ID
 *   - func_code: Function code
 *   - byte_count: Byte count (for read functions)
 *   - start_address: Starting address (for write functions)
 *   - quantity: Quantity of registers/coils (for write multiple functions)
 *   - data: Read data or written data
 *   - exception_code: Exception code (if it's an exception response)
 *   - buffer: The original buffer
 */
function parse_mt_response(buffer) {
    const PDU_length = buffer.readUInt16BE(4);
    if (PDU_length < 3 || PDU_length > 253) {  // PDU length must be between 3-253
        return [{ tid: TRANSACTION_START, func_code: 0, buffer }];
    }

    const tid = buffer.readUInt16BE(0);    // Transaction Id
    const pid = buffer.readUInt16BE(2);    // Protocol Id
    const unit_id = buffer.readUInt8(6);   // Unit Id
    let func_code = buffer.readInt8(7);    // Function Code
    let start_address;                     // Written address
    let quantity;                          // Quantity of registers/coils
    let byte_count = 0;                    // Byte count of the data
    let data;                              // Data to write (excluding CRC)
    let exception_code;                    // Exception code

    switch (func_code) {
        case 1:
        case 2:
        case 3:
        case 4:
            // Read function response
            byte_count = buffer.readUInt8(8);
            if (PDU_length !== byte_count + 3) {
                func_code = 0; // Invalid packet length
                break;
            }
            data = buffer.subarray(9, 9 + byte_count);
            break;
        case 5:
        case 6:
            // Single write function response
            if (PDU_length !== 6) {
                func_code = 0; // Invalid packet length
                break;
            }
            start_address = buffer.readUInt16BE(8);
            data = buffer.readUInt16BE(10);
            break;
        case 15:
        case 16:
            // Multiple write function response
            if (PDU_length !== 6) {
                func_code = 0; // Invalid packet length
                break;
            }
            start_address = buffer.readUInt16BE(8);
            quantity = buffer.readUInt16BE(10);
            break;
        default:
            if (func_code > 127 && PDU_length === 3) {
                // Exception response
                exception_code = buffer.readUInt8(8);
                break;
            }
            func_code = 0; // Invalid packet length
            break;
    }

    return {
        tid, pid,
        unit_id, func_code,
        byte_count, start_address, quantity,
        data, exception_code, buffer
    };
}

/**
 * Parses the TCP combined buffer and validates Modbus TCP packets.
 *
 * @param {Buffer} combined_buffer - The combined buffer to parse.
 * @return {Array} An array containing valid Modbus TCP packets.
 */
function parse_tcp(combined_buffer) {
    const ret = [];
    let buffer = combined_buffer;
    while (buffer.length >= 9) { // MBAP header + PDU is at least 6+3 bytes
        // Check if protocol identifier is 0
        if (buffer.readUInt16BE(2) !== 0) {
            break; // non-Modbus TCP packet, stop parsing
        }
        const length = buffer.readUInt16BE(4);
        if (length < 3 || length > 253) { // PDU length must be between 3-253
            break; // Invalid length, stop parsing
        }
        const fullLength = 6 + length; // MBAP header + PDU
        if (buffer.length >= fullLength) {
            const mt_buffer = buffer.subarray(0, fullLength);
            // Validate PDU
            const func_code = mt_buffer[7];
            if (func_code < 1) {
                buffer = buffer.subarray(fullLength);
                continue; // Skip invalid function code
            }
            buffer = buffer.subarray(fullLength);
            ret.push(mt_buffer);
        } else {
            break; // Empty data or non-Modbus TCP packet, stop parsing
        }
    }
    return ret;
}

export function parse_tcp_response(res_buffer) {
    return parse_tcp(res_buffer).map(parse_mt_response);
}
export function parse_tcp_request(req_buffer) {
    return parse_tcp(req_buffer).map(parse_mt_request);
}
