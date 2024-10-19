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

export function parse_address(address_str) {
    const match = address_str.match(/^(\d{5})(,(\d{1,4}))?$/);
    if (!match) return null;

    const address = parseInt(match[1].substr(1), 10);
    if (address <= 0 || address > 65535) return null;

    const length = match[3] ? parseInt(match[3], 10) : undefined;

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
    };

    return { ...address_map[prefix], address, length };
}

export function parse_rtu_response(buffer) {
    const tid = TRANSACTION_START;
    const unit_id = buffer.readInt8(0);                  // Unit Id
    const func_code = buffer.readInt8(1);                // Function Code
    const byte_count = Math.abs(buffer.readInt8(2));     // Byte Count
    const data = buffer.subarray(3, 3 + byte_count);     // exclude crc
    // @todo crc
    // @todo ecode
    const ecode = null;
    return [{ tid, unit_id, func_code, byte_count, data, ecode, buffer }];
}

export function parse_rtu_request(buffer) {
    const tid = TRANSACTION_START;
    const unit_id = buffer.readInt8(0);                  // Unit Id
    const func_code = buffer.readInt8(1);                // Function Code
    const start_address = buffer.readUInt16BE(2);        // Start Address
    const data = buffer.readUInt16BE(4);                 // Byte Count or Data
    const extra_data = buffer.subarray(7);               // Extra Data
    // @todo crc
    // @todo ecode
    const ecode = null;
    return [{ tid, unit_id, func_code, start_address, data, extra_data, ecode, buffer }];
}

function parse_mt_response(buffer) {
    const tid = buffer.readUInt16BE(0);                     // Transaction Id
    const pid = buffer.readUInt16BE(2);                     // Protocal Id
    const unit_id = buffer.readInt8(6);                     // Unit Id
    const func_code = buffer.readInt8(7);                   // Function Code
    const byte_count = Math.abs(buffer.readInt8(8));        // Byte Count
    const data = buffer.subarray(9);                        // No need to exclude crc
    // @todo ecode
    const ecode = null;
    return { tid, pid, unit_id, func_code, byte_count, data, ecode, buffer };
}

function parse_mt_request(buffer) {
    const tid = buffer.readUInt16BE(0);                     // Transaction Id
    const pid = buffer.readUInt16BE(2);                     // Protocal Id
    const unit_id = buffer.readInt8(6);                     // Unit Id
    const func_code = buffer.readInt8(7);                   // Function Code
    const start_address = buffer.readUInt16BE(8);           // Start Address
    const data = buffer.readUInt16BE(10);                       // Byte Count or Data
    const extra_data = buffer.subarray(13);                 // Extra Data
    // @todo ecode
    const ecode = null;
    return { tid, pid, unit_id, func_code, start_address, data, extra_data, ecode, buffer };
}

/**
 * Parses the TCP combined buffer and processes it based on the specified type.
 *
 * @param {Buffer} combined_buffer - The combined buffer to parse.
 * @param {string} [type='request'] - The type of buffer to handle, either 'request' or 'response'.
 * @return {Array} An array containing the parsed data based on the type.
 */
function parse_tcp(combined_buffer) {
    const ret = [];
    while (combined_buffer.length >= 6) {// MBAp header is at least 6 bytes
        const length = combined_buffer.readUInt16BE(4);
        const fullLength = length + 6; // for MBAp header + PDU
        if (combined_buffer.length >= fullLength) {
            const mt_buffer = combined_buffer.subarray(0, fullLength);
            combined_buffer = combined_buffer.subarray(fullLength);
            ret.push(mt_buffer);
        } else {
            // data error
            // @todo throw error
            break;
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
