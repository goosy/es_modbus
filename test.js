import { Modbus_Client, Modbus_Server } from "./modbus.js";

const host_buffer = Buffer.alloc(146);

const modbus = new Modbus_Client('127.0.0.1', { port: 503 });
// modbus.on('transport', console.log);
modbus.on('connect', () => console.log('connected'));
modbus.on('error', console.log);

setInterval(async () => {
    const buffer = await modbus.read('40001,73', 78);
    buffer.copy(host_buffer);
    // console.log('Buffer 长度:', buffer.length);
    // console.log('Hex 字符串:', buffer.toString('hex'));
}, 1000);


/** 
 * @param {string} host the ip of the TCP Port - required.
 * @param {number} port the Port number - default 502.
 */
export function createMTServer(host = "0.0.0.0", port = 502, unit_map) {

    const vector = {
        getInputRegister: (addr, unit_id) => {
            const buffer = unit_map[unit_id];
            const offset = addr * 2;
            if (buffer == null || 0 > offset || offset >= buffer.length) {
                console.error(`Invalid InputRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            return buffer.readUInt16BE(offset);
        },
        getHoldingRegister: (addr, unit_id) => {
            const buffer = unit_map[unit_id];
            const offset = addr * 2;
            if (buffer == null || 0 > offset || offset >= buffer.length) {
                console.error(`Invalid HoldingRegister address(${addr}) when reading unit ${unit_id}`);
                return 0;
            }
            return buffer.readUInt16BE(offset);
        },
        setRegister: (addr, value, unit_id) => {
            const buffer = unit_map[unit_id];
            const offset = addr * 2;
            if (buffer == null || 0 > offset || offset >= buffer.length) {
                console.error(`Invalid regsiter address: ${addr} when writing to unit ${unit_id}`);
                return 0;
            }
            buffer.writeUInt16BE(value, offset);
            return;
        },

        getCoil: (addr, unit_id) => {
            const buffer = unit_map[unit_id];
            const offset = addr >> 3;
            const bit_mask = 1 << (addr & 0x7);
            if (buffer == null || 0 > offset || offset >= buffer.length) {
                console.error(`Invalid coil address: ${addr} for read in unit ${unit_id}`);
                return false;
            }
            return (buffer.readUInt8(offset) & bit_mask) > 0;
        },

        setCoil: (addr, value, unit_id) => {
            const buffer = unit_map[unit_id];
            const offset = addr >> 3;
            const bit_mask = 1 << (addr & 0x7);
            if (buffer == null || 0 > offset || offset >= buffer.length) {
                console.error(`Invalid coil address: ${addr} for write in unit ${unit_id}`);
                return;
            }
            let byte = buffer.readUInt8(offset);
            if (value) byte = byte | bit_mask;
            else byte = byte & ~bit_mask;
            buffer.writeUInt8(byte, offset);
            return;
        },
    }

    console.log(`ModbusTCP listening on modbus://${host}:${port}`);
    const server = new Modbus_Server(vector, { host, port, unit_id: 0 });
    server.on("socketError", function (err) {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });
    server.on('error', function (err) {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });
    server.on("close", () => {
        logger.error("connection closed!");
    });

    return server;
}

// start modbus TCP server
const server = createMTServer('0.0.0.0', 502, { 78: host_buffer });
server.start();


function generateRandomFloat(min, max, decimalPlaces) {
    const multiplier = 10 ** decimalPlaces; // Calculate the multiplier for decimal places
    const minScaled = min * multiplier; // Scale the minimum value
    const maxScaled = max * multiplier; // Scale the maximum value

    // Generate a random number within the scaled range
    const randomScaled = Math.random() * (maxScaled - minScaled) + minScaled;

    // Round down to the nearest integer
    const randomInt = Math.floor(randomScaled);

    // Convert the integer back to decimal and add decimal places
    const randomFloat = randomInt / multiplier;
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(randomFloat);

    return buffer;
}
