// Checks the build output `dist/modbus.js` (the package entry) and `native/`, not `src/`.
// Skipped when the bundle is missing or older than `src/`; run `pnpm build` first.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, stat } from 'node:fs/promises';
import { HOST, hex, create_memory_handler } from './helpers.js';

const bundle_url = new URL('../dist/modbus.js', import.meta.url);
const root_url = new URL('../', import.meta.url);
const src_url = new URL('../src/', import.meta.url);

async function check_bundle() {
	let bundle_time;
	try {
		bundle_time = (await stat(bundle_url)).mtimeMs;
	} catch {
		return 'dist/modbus.js not found; run `pnpm build` first';
	}
	for (const name of await readdir(src_url)) {
		if ((await stat(new URL(name, src_url))).mtimeMs > bundle_time) {
			return `dist/modbus.js is older than src/${name}; run \`pnpm build\` first`;
		}
	}
	return false;
}

const skip = await check_bundle();

/** Whether the serialport-rs native addon is loaded in this process. */
function native_addon_loaded() {
	return process.report.getReport().sharedObjects.some((file) => /serialport-rs\.node$/.test(file));
}

describe('build output dist/modbus.js', { skip }, () => {
	let bundle;
	before(async () => {
		bundle = await import(bundle_url);
	});

	test('exports exactly Modbus_Client and Modbus_Server', () => {
		assert.deepEqual(Object.keys(bundle).sort(), ['Modbus_Client', 'Modbus_Server']);
		assert.equal(typeof bundle.Modbus_Client, 'function');
		assert.equal(typeof bundle.Modbus_Server, 'function');
	});

	test('package.json exports points at the bundle', async () => {
		const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
		assert.equal(pkg.exports['.'], './dist/modbus.js');
	});

	test('serialport-rs is bundled without its parsers, not imported from outside', async () => {
		const code = await readFile(bundle_url, 'utf8');
		assert.match(code, /SerialPortStream = class extends/);
		assert.doesNotMatch(code, /ReadlineParser/);
		assert.doesNotMatch(code, /from\s*["']serialport-rs/);
		assert.doesNotMatch(code, /require\(\s*["']serialport-rs/);
		// ES modules have no __dirname; serialport-rs finds native/ from the bundle's directory
		assert.doesNotMatch(code, /\b__dirname\b/);
	});

	test('the native addons and the third-party licenses are next to dist/', async () => {
		const entries = await readdir(new URL('native/', root_url));
		assert.ok(entries.includes('THIRD_PARTY_LICENSES.md'), entries.join());
		assert.ok(entries.some((name) => name.endsWith('-pc-windows-msvc')), entries.join());
		const licenses = await readFile(new URL('THIRD_PARTY_LICENSES', root_url), 'utf8');
		assert.match(licenses, /^serialport-rs@/m);
		// Its NOTICE follows its license text
		assert.match(licenses, /^Copyright \d+ DragonWork$/m);
	});

	test('importing the bundle does not load the native addon; the first serial start does', async () => {
		assert.equal(native_addon_loaded(), false);
		const server = new bundle.Modbus_Server({}, { port: 'COM_NONEXISTENT_ES_MODBUS' });
		server.start();
		const [error] = await once(server, 'error');
		// Opening a missing device fails in the native addon, which therefore loaded
		assert.doesNotMatch(error.message, /native build/);
		assert.equal(native_addon_loaded(), true);
	});

	describe('TCP round trip with the bundled classes', () => {
		let memory;
		let server;
		let client;
		before(async () => {
			memory = create_memory_handler();
			server = new bundle.Modbus_Server(memory.handler, { host: HOST, port: 0, unit_id: [18, 19] });
			server.on('error', () => { });
			const started = once(server, 'start');
			server.start();
			await started;
			client = new bundle.Modbus_Client(HOST, {
				port: server.server.address().port, reconnect_time: 0, timeout: 1000, delay: 0,
			});
			client.on('error', () => { });
			await client.connect();
		});
		after(async () => {
			client.stream.destroy();
			const stopped = once(server, 'stop');
			server.stop();
			await stopped;
		});

		test('reads several units', async () => {
			memory.unit(18).holding[0] = 8018;
			memory.unit(19).holding[0] = 8019;
			const values = await Promise.all([client.read('40001,73', 18), client.read('40001,73', 19)]);
			assert.deepEqual(values.map((v) => [v.length, v.readUInt16BE(0)]), [[146, 8018], [146, 8019]]);
		});

		test('writes and reads back', async () => {
			await client.write('40010', hex('00010002'), 18);
			await client.write('00001', true, 18);
			assert.deepEqual(await client.read('40010,2', 18), hex('00010002'));
			assert.deepEqual(await client.read('00001', 18), hex('01'));
		});

		test('rejects a unit ID the server does not accept', async () => {
			await assert.rejects(client.read('40001', 12), { name: 'Error', message: 'response error: 11' });
		});
	});
});
