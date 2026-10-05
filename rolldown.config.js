import { defineConfig } from 'rolldown';
import pkg from './package.json' with { type: 'json' };

// Rolldown resolves node_modules, CommonJS and JSON natively,
// so no extra plugins are needed.
export default defineConfig({
    input: 'src/index.js',
    platform: 'node',
    output: {
        file: pkg.exports['.'],
        format: 'es',
    },
    external: ['serialport'],
});
