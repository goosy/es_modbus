// Runs the serial tests over every direction of a serial port (see design-test.md, "Serial test
// runner"): `node test/run-serial.js [--settle <ms>] COMn COMm` or `node test/run-serial.js
// [--settle <ms>] COMn [:port[@address]] [host:port[,host:port ...]]`. Each run is a `node --test
// test/serial.test.js` child process with MODBUS_SERIAL_PORTS (and MODBUS_CONVERTER_SETTLE_MS
// when `--settle` is given) set for it only, started once the previous one has exited.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse_runner_args } from './serial-link.js';

// Not a constant: it depends on where the file is at run time
const serial_test = fileURLToPath(new URL('./serial.test.js', import.meta.url));
const USAGE = `Usage:
  pnpm test:serial [--settle <ms>] <serial> <serial>
      two serial ports linked like a null-modem cable; both directions run
  pnpm test:serial [--settle <ms>] <serial> [:<port>[@<address>]] [<host>:<port>[,<host>:<port> ...]]
      a serial port wired to a transparent converter: ":<port>" listens for a converter in TCP
      client mode, "@<address>" accepting only the converter at that IP address; the last
      argument is the remote pool for a converter in TCP server mode, its "<host>:<port>" ends
      separated by "," and taken in turn
Options:
  --settle <ms>  how long to leave a converter that has just connected to ":<port>" before
                 writing to it (default 20); a larger value works around a converter that
                 resets a connection receiving data too soon
Examples:
  pnpm test:serial COM4 COM5
  pnpm test:serial COM4 :502 192.168.89.2:502,192.168.89.2:503
  pnpm test:serial --settle 500 COM4 :502@192.168.213.254`;

const options = parse_runner_args(process.argv.slice(2));
if (!options) {
	console.error(USAGE);
	process.exit(2);
}

const settle_env = options.settle === undefined ? {} : { MODBUS_CONVERTER_SETTLE_MS: options.settle };
const settle_note = options.settle === undefined ? '' : ` MODBUS_CONVERTER_SETTLE_MS=${options.settle}`;
const results = [];
for (const spec of options.runs) {
	console.log(`\n=== MODBUS_SERIAL_PORTS=${spec}${settle_note}\n`);
	const { status, error } = spawnSync(process.execPath, ['--test', serial_test], {
		stdio: 'inherit',
		env: { ...process.env, MODBUS_SERIAL_PORTS: spec, ...settle_env },
	});
	if (error) console.error(error.message);
	results.push({ spec, passed: status === 0 });
}

console.log('\n=== Summary');
for (const { spec, passed } of results) console.log(`${passed ? 'pass' : 'FAIL'}  ${spec}`);
process.exitCode = results.every(({ passed }) => passed) ? 0 : 1;
