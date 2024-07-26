import pkg from './package.json' with { type: 'json' };
import commonjs from '@rollup/plugin-commonjs';
import resolve from '@rollup/plugin-node-resolve';
import json from '@rollup/plugin-json';

export default [{
    input: 'src/index.js',
    output: [{
        file: pkg.exports['.'],
        format: 'es',
    }],
    plugins: [
        resolve({ preferBuiltins: true }),
        commonjs(),
        json()
    ],
    external: [],
}];
