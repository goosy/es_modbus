// The serial test runner (see design-test.md, "Serial test runner"): `node test/run-serial.js
// COMn COMm` or `node test/run-serial.js COMn <local-udp-port> [<address>:<port>]`. Each run is a
// `node --test test/serial.test.js` child process with MODBUS_SERIAL_PORTS set for it only,
// started once the previous one has exited.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse_link } from './helpers.js';

const USAGE = `Usage:
  pnpm test:serial <serial> <serial>
      two serial ports linked like a null-modem cable; both directions run
  pnpm test:serial <serial> <local-udp-port> [<address>:<port>]
      a serial port wired to a transparent serial-to-UDP converter that sends the serial data
      to <local-udp-port> of this machine. The converter's address and port are learned from
      what it sends; give them (an IPv4 address) when another converter also sends to that
      port during the run, or when the converter receives on another port than it sends from.
Examples:
  pnpm test:serial COM4 COM5
  pnpm test:serial COM4 502
  pnpm test:serial COM4 502 192.168.89.2:4001`;

const args = process.argv.slice(2);
let link;
try {
	link = parse_link(args.join(','));
} catch (error) {
	console.error(`${error.message}\n\n${USAGE}`);
	process.exit(2);
}
const runs = link.second.serial ? [args.join(','), [...args].reverse().join(',')] : [args.join(',')];
const serial_test = fileURLToPath(new URL('./serial.test.js', import.meta.url));
const results = [];
for (const spec of runs) {
	console.log(`\n=== MODBUS_SERIAL_PORTS=${spec}\n`);
	const { status, error } = spawnSync(process.execPath, ['--test', serial_test], {
		stdio: 'inherit',
		env: { ...process.env, MODBUS_SERIAL_PORTS: spec },
	});
	if (error) console.error(error.message);
	results.push({ spec, passed: status === 0 });
}
console.log('\n=== Summary');
for (const { spec, passed } of results) console.log(`${passed ? 'pass' : 'FAIL'}  ${spec}`);
process.exitCode = results.every(({ passed }) => passed) ? 0 : 1;
