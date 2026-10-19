// Builds the package: bundles src/index.js, with the serialport-rs JavaScript, into
// dist/modbus.js; copies the serialport-rs native addons of the supported platforms to native/;
// and writes the licenses of the bundled packages to THIRD_PARTY_LICENSES.
import { build } from 'rolldown';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = import.meta.dirname;
const require = createRequire(import.meta.url);

// The Rust target triples whose serialport-rs addons ship in native/ ("Serial platforms" in spec.md)
const NATIVE_TARGETS = [
	'x86_64-pc-windows-msvc', 'i686-pc-windows-msvc', 'aarch64-pc-windows-msvc',
	'x86_64-apple-darwin', 'aarch64-apple-darwin',
	'x86_64-unknown-linux-gnu', 'x86_64-unknown-linux-musl',
	'aarch64-unknown-linux-gnu', 'aarch64-unknown-linux-musl',
	'armv7-unknown-linux-gnueabihf', 'armv7-unknown-linux-musleabihf', 'arm-unknown-linux-gnueabihf',
	'aarch64-linux-android', 'armv7-linux-androideabi',
];

/**
 * Bundles src/index.js into dist/modbus.js as a single ES module; returns the bundled module IDs.
 */
async function bundle() {
	await rm(join(root, 'dist'), { recursive: true, force: true });
	const { output: [chunk] } = await build({
		input: join(root, 'src/index.js'),
		platform: 'node',
		// serialport-rs finds its addons from `__dirname`, which an ES module lacks:
		// `<dist>/../native`
		transform: { define: { __dirname: 'import.meta.dirname' } },
		// One file; the serial code stays lazy behind its dynamic import()
		output: { file: join(root, 'dist/modbus.js'), format: 'es', codeSplitting: false },
	});
	return chunk.moduleIds;
}

/**
 * Replaces native/ with the serialport-rs addons of NATIVE_TARGETS, and the licenses of the Rust
 * crates compiled into them.
 */
async function copy_native() {
	const package_dir = dirname(require.resolve('serialport-rs/package.json'));
	const target = join(root, 'native');
	await rm(target, { recursive: true, force: true });
	for (const triple of NATIVE_TARGETS) {
		await cp(join(package_dir, 'native', triple), join(target, triple), { recursive: true });
	}
	await cp(join(package_dir, 'THIRD_PARTY_LICENSES.md'), join(target, 'THIRD_PARTY_LICENSES.md'));
}

/**
 * The directory of the package a bundled module belongs to, or null for a project module.
 */
function package_dir(module_id) {
	const parts = module_id.split(/[\\/]/);
	const index = parts.lastIndexOf('node_modules');
	if (index < 0) return null;
	const length = parts[index + 1].startsWith('@') ? 2 : 1;
	return parts.slice(0, index + 1 + length).join('/');
}

/**
 * Writes the license text of every bundled package to THIRD_PARTY_LICENSES, followed by its
 * NOTICE file when it has one (Apache-2.0 requires it). The native addons belong to
 * serialport-rs, which is bundled too.
 */
async function write_licenses(module_ids) {
	const dirs = [...new Set(module_ids.map(package_dir).filter(Boolean))];
	const packages = [];
	for (const dir of dirs) {
		const { name, version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
		const files = await readdir(dir);
		const file = files.find((name) => /^licen[cs]e/i.test(name));
		if (!file) throw new Error(`No license file in ${name}@${version}`);
		const notice = files.find((name) => /^notice/i.test(name));
		const texts = [file, notice].filter(Boolean).map((name) => readFile(join(dir, name), 'utf8'));
		const text = (await Promise.all(texts)).map((content) => content.trim()).join('\n\n');
		packages.push({ name, version, license, text });
	}
	packages.sort((a, b) => a.name.localeCompare(b.name));

	// Packages with the same license text share one entry
	const groups = Map.groupBy(packages, ({ text }) => text);
	const sections = [...groups].map(([text, group]) => [
		...group.map(({ name, version, license }) => `${name}@${version} (${license})`),
		'',
		text,
	].join('\n'));
	const header = 'es-modbus bundles the following third-party packages in dist/modbus.js and native/.\n'
		+ 'The licenses of the Rust crates compiled into the native addons are in native/THIRD_PARTY_LICENSES.md.';
	const separator = `\n\n${'-'.repeat(72)}\n\n`;
	await writeFile(join(root, 'THIRD_PARTY_LICENSES'), `${[header, ...sections].join(separator)}\n`);
}

const module_ids = await bundle();
await copy_native();
await write_licenses(module_ids);
