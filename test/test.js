import { Modbus_Client, Modbus_Server } from "../modbus.js";

// Modbus_Server usage example
function createMTServer(unit_map, host = "0.0.0.0", port = 502) {
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

    const server = new Modbus_Server(vector, { host, port, unit_id: 0 });
    server.on("start", () => {
        console.log(`ModbusTCP server listening on modbus://${host}:${port}`);
    })
    server.on("socket_error", (err) => {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });
    server.on('error', (err) => {
        // Handle socket error if needed, can be ignored
        console.error(err);
    });
    server.on("stop", () => {
        logger.error("connection closed!");
    });

    return server;
}

// start modbus TCP server
const host_buffer_18 = Buffer.alloc(146);
const host_buffer_19 = Buffer.alloc(146);
const host_buffer_12 = Buffer.alloc(146);
host_buffer_18.writeUInt16BE(8018, 0);
host_buffer_19.writeUInt16BE(8019, 0);
host_buffer_12.writeUInt16BE(8012, 0);
const server = createMTServer({
    18: host_buffer_18,
    19: host_buffer_19,
    12: host_buffer_12,
}, '0.0.0.0', 502);
server.on('send', (buffer) => {
    console.log(`server tx: ${buffer.toString('hex')}`);
});
server.on('receive', (buffer) => {
    console.log(`server rx: ${buffer.toString('hex')}`);
});
server.start();


// modbus TCP client  usage example
const modbus = new Modbus_Client('127.0.0.1', { port: 502 });
modbus.on('send', (buffer) => {
    console.log(`client tx: ${buffer.toString('hex')}`);
});
modbus.on('receive', (buffer) => {
    console.log(`client rx: ${buffer.toString('hex')}`);
});
modbus.on('connect', () => console.log('modbus connected'));
modbus.on('error', console.log);

setInterval(async () => {
    const show = console.info;
    modbus.read('40001,73', 18).then(show, show);
    modbus.read('40001,73', 19).then(show, show);
    modbus.read('40001,73', 12).then(show, show);
    // buffer.copy(host_buffer)
}, 1000);
