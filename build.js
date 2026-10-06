// Builds the package: bundles src/index.js, with the serialport JavaScript, into
// dist/modbus.js; copies the serialport native prebuilds to prebuilds/; and writes the
// licenses of the bundled packages to THIRD_PARTY_LICENSES.
import { build } from 'rolldown';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const root = import.meta.dirname;
const require = createRequire(import.meta.url);

/**
 * Bundles src/index.js into dist/modbus.js as a single ES module; returns the bundled module IDs.
 */
async function bundle() {
	await rm(join(root, 'dist'), { recursive: true, force: true });
	const { output: [chunk] } = await build({
		input: join(root, 'src/index.js'),
		platform: 'node',
		// The bindings find their prebuilds from `__dirname`, which an ES module lacks:
		// `<dist>/../prebuilds`
		transform: { define: { __dirname: 'import.meta.dirname' } },
		// One file; the serial code stays lazy behind its dynamic import()
		output: { file: join(root, 'dist/modbus.js'), format: 'es', codeSplitting: false },
	});
	return chunk.moduleIds;
}

/**
 * Replaces prebuilds/ with the native prebuilds of @serialport/bindings-cpp.
 */
async function copy_prebuilds() {
	const bindings_dir = dirname(require.resolve('@serialport/bindings-cpp/package.json'));
	const target = join(root, 'prebuilds');
	await rm(target, { recursive: true, force: true });
	await cp(join(bindings_dir, 'prebuilds'), target, { recursive: true });
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
 * Writes the license text of every bundled package to THIRD_PARTY_LICENSES. The native
 * prebuilds belong to @serialport/bindings-cpp, which is bundled too.
 */
async function write_licenses(module_ids) {
	const dirs = [...new Set(module_ids.map(package_dir).filter(Boolean))];
	const packages = [];
	for (const dir of dirs) {
		const { name, version, license } = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
		const file = (await readdir(dir)).find((name) => /^licen[cs]e/i.test(name));
		if (!file) throw new Error(`No license file in ${name}@${version}`);
		const text = (await readFile(join(dir, file), 'utf8')).trim();
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
	const header = 'es-modbus bundles the following third-party packages in dist/modbus.js and prebuilds/.';
	const separator = `\n\n${'-'.repeat(72)}\n\n`;
	await writeFile(join(root, 'THIRD_PARTY_LICENSES'), `${[header, ...sections].join(separator)}\n`);
}

const module_ids = await bundle();
await copy_prebuilds();
await write_licenses(module_ids);
