// Runs the serial tests over every direction of a serial port (see design-test.md, "Serial test
// runner"): `node test/run-serial.js COMn COMm` or `node test/run-serial.js COMn [:port]
// [host:port ...]`. Each run is a `node --test test/serial.test.js` child process with
// MODBUS_SERIAL_PORTS set for it only, started once the previous one has exited.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Not a constant: it depends on where the file is at run time
const serial_test = fileURLToPath(new URL('./serial.test.js', import.meta.url));
const USAGE = `Usage:
  pnpm test:serial <serial> <serial>
      two serial ports linked like a null-modem cable; both directions run
  pnpm test:serial <serial> [:<port>] [<host>:<port> ...]
      a serial port wired to a transparent converter: ":<port>" listens for a converter in TCP
      client mode; the "<host>:<port>" ends form a remote pool for a converter in TCP server mode
Examples:
  pnpm test:serial COM4 COM5
  pnpm test:serial COM4 :502 192.168.89.2:502 192.168.89.2:503`;

const is_tcp = (end) => end.includes(':');

/**
 * Expands the arguments into the values of MODBUS_SERIAL_PORTS, one per run, in order. Returns
 * null when the arguments match neither form.
 */
function expand(args) {
	if (args.length < 2 || is_tcp(args[0])) return null;
	const [serial, ...rest] = args;
	if (!rest.some(is_tcp)) {
		if (rest.length !== 1) return null;
		return [`${serial},${rest[0]}`, `${rest[0]},${serial}`];
	}
	if (!rest.every(is_tcp)) return null;
	const listen_index = rest.findIndex((end) => end.startsWith(':'));
	const listens = rest.filter((end) => end.startsWith(':'));
	if (listens.length > 1 || listen_index > 0) return null;
	const remotes = rest.filter((end) => !end.startsWith(':'));
	const runs = listens.map((listen) => `${serial},${listen}`);
	if (remotes.length > 0) runs.push(`${serial},${remotes.join('|')}`);
	return runs;
}

const runs = expand(process.argv.slice(2));
if (!runs) {
	console.error(USAGE);
	process.exit(2);
}

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
