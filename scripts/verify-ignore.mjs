// verify-ignore.mjs
import { expandGlob } from '../dist/glob.js';
const all = expandGlob('**/*.ts', process.cwd());
if (all.some(f => f.includes('node_modules'))) throw new Error('node_modules leaked into **');
if (!all.includes('src/glob.ts')) throw new Error('own source went missing');
const explicit = expandGlob('node_modules/@anthropic-ai/sdk/*.d.ts', process.cwd());
if (explicit.length === 0) throw new Error('explicit node_modules pattern must still match');
console.log('IGNORE OK');
