// Type-checked by `tsc -p test` (in `pnpm test`), never run: the README examples against the
// published declarations, and the misuses they must reject (`@ts-expect-error`).
import { Modbus_Client, Modbus_Exception, Modbus_Server, type Modbus_Handler } from 'es-modbus';

const client = new Modbus_Client({ tcp: '192.168.1.10:502', timeout: 1000, max_timeouts: 3 });
const data: Buffer = await client.read('40001,2', 1);
console.log(data.readUInt16BE(0));
const confirmed: boolean = await client.write('40010', 1234, 1);
await client.write('00001,16', Buffer.from([0xff, 0x00]), 1);
await client.read([3, 256, 2]);
await client.read({ func_code: 3, pdu_addr: 256, length: 2 });
client.on('data', (value) => console.log(value, confirmed));
client.on('send', (frame) => console.log(frame.length));
await client.disconnect();

new Modbus_Client({ rtu_over_tcp: '192.168.1.20:4001', turnaround: 100 });
new Modbus_Client({ udp: '192.168.1.30:502', local: ':5020' });
new Modbus_Client({ rtu_over_udp: '192.168.1.40:4001', local: ':4001', any_source_port: true });
new Modbus_Client({ serial: 'COM3', baud_rate: 19200, parity: 'even' });

// @ts-expect-error: no transport
new Modbus_Client({ timeout: 1000 });
// @ts-expect-error: two transports
new Modbus_Client({ tcp: 'a:502', udp: 'b:502' });
// @ts-expect-error: a serial option on TCP
new Modbus_Client({ tcp: 'a:502', baud_rate: 9600 });
// @ts-expect-error: `local` applies to the UDP family only
new Modbus_Client({ tcp: 'a:502', local: ':502' });
// @ts-expect-error: an unknown event
client.on('connected', () => {});

const holding = new Uint16Array(100);
const handler: Modbus_Handler = {
	get_coil: () => false,
	get_input_register: () => 0,
	get_holding_register: (addr) => holding[addr] ?? 0,
	set_coil: () => {},
	set_holding_register(addr, value) {
		if (addr >= holding.length) throw new Modbus_Exception(0x02);
		holding[addr] = value;
	},
	get_holding_registers: (addr, quantity) => holding.subarray(addr, addr + quantity),
};
const server = new Modbus_Server(handler, { tcp: ':502', unit_id: [1, 2] });
server.on('handler_error', (error) => console.error(error));
server.on('socket_connect', (socket) => console.log(socket.remoteAddress));
await server.start();
await server.stop();

new Modbus_Server(handler, { serial: '/dev/ttyUSB0', baud_rate: 19200 });
new Modbus_Server(handler, { udp: ':502', unit_id: 'all' });

// @ts-expect-error: `silence` does not apply to Modbus UDP
new Modbus_Server(handler, { udp: ':502', silence: 50 });
// @ts-expect-error: not an allowed exception code
new Modbus_Exception(0x05);
