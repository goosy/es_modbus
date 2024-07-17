import {Modbus_Client } from "./modbus.js";
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

const modbus = new Modbus_Client('127.0.0.1', { port: 503 });
modbus.on('transport', console.log);
modbus.on('connect', () => console.log('connected'));

modbus.on('error', console.log);
let o = 0;
setInterval(async () => {
    const value = generateRandomFloat(200.0, 300.0, 2);
    o = 2 - o;
    modbus.write('40007,2', value, 78);
    modbus.write('40001', 8078 + o, 78);
    const buffer = await modbus.read('40001,73', 78);
    console.log('Buffer 长度:', buffer.length);
    console.log('Hex 字符串:', buffer.toString('hex'));
}, 1000);
