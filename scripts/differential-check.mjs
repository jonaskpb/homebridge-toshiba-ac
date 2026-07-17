#!/usr/bin/env node
/* eslint-disable */
/**
 * Differential test: run the same operations through the compiled TypeScript
 * codec and the original Python library, and compare results.
 *
 * Usage: node scripts/differential-check.mjs /path/to/Toshiba-AC-control-main
 * (a checkout of https://github.com/KaSroka/Toshiba-AC-control)
 *
 * Requires `npm run build` first and python3 on PATH.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const { FcuState } = require(path.join(repoRoot, 'dist/toshiba/fcuState.js'));
const { Features } = require(path.join(repoRoot, 'dist/toshiba/features.js'));

const pythonLibPath = process.argv[2];
if (!pythonLibPath) {
  console.error('Usage: node scripts/differential-check.mjs /path/to/Toshiba-AC-control-main');
  process.exit(2);
}

// --- deterministic PRNG so failures are reproducible ---
let seed = 0xc0ffee;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const randomByteHex = () => Math.floor(rand() * 256).toString(16).padStart(2, '0');
const randomStateHex = () => Array.from({ length: 19 }, randomByteHex).join('');

const HEX_CHARS = '0123456789abcdef';
const randomMerit = (length) =>
  Array.from({ length }, () => HEX_CHARS[Math.floor(rand() * 16)]).join('');

// --- build request list ---
const requests = [];

for (let i = 0; i < 500; i++) {
  requests.push({ op: 'roundtrip', hex: randomStateHex() });
}
// Extra characters beyond the 38-char layout must be ignored
for (let i = 0; i < 50; i++) {
  requests.push({ op: 'roundtrip', hex: randomStateHex() + randomByteHex() });
}
for (let i = 0; i < 500; i++) {
  requests.push({ op: 'update', base: randomStateHex(), update: randomStateHex() });
}

const MODELS = ['1', '2', '3'];
for (let bitIndex = 0; bitIndex < 16; bitIndex++) {
  const merit = (1 << (15 - bitIndex)).toString(16).padStart(4, '0');
  for (const model of MODELS) {
    requests.push({ op: 'features', merit, model });
  }
}
for (let i = 0; i < 200; i++) {
  requests.push({ op: 'features', merit: randomMerit(4), model: MODELS[i % 3] });
}
for (const merit of ['', 'c', '03', 'fff']) {
  for (const model of MODELS) {
    requests.push({ op: 'features', merit, model });
  }
}
for (const mode of ['AUTO', 'COOL', 'HEAT', 'DRY', 'FAN']) {
  for (const model of MODELS) {
    requests.push({ op: 'featuresForMode', merit: 'ffff', model, mode });
  }
}

// --- TypeScript answers ---
const featuresToComparable = (features) => ({
  modes: [...features.acMode].sort(),
  fanModes: [...features.acFanMode].sort(),
  swingModes: [...features.acSwingMode].sort(),
  powerSelections: [...features.acPowerSelection].sort(),
  meritA: [...features.acMeritA].sort(),
  meritB: [...features.acMeritB].sort(),
  pureIon: [...features.acAirPureIon].sort(),
  selfCleaning: [...features.acSelfCleaning].sort(),
  energyReport: features.acEnergyReport,
});

const tsAnswer = (request) => {
  try {
    switch (request.op) {
    case 'roundtrip':
      return { encoded: FcuState.fromHexState(request.hex).encode() };
    case 'update': {
      const state = FcuState.fromHexState(request.base);
      const changed = state.update(request.update);
      return { encoded: state.encode(), changed };
    }
    case 'features':
      return featuresToComparable(Features.fromMeritStringAndModel(request.merit, request.model));
    case 'featuresForMode':
      return featuresToComparable(
        Features.fromMeritStringAndModel(request.merit, request.model).forAcMode(request.mode),
      );
    default:
      return { error: `unknown op ${request.op}` };
    }
  } catch (e) {
    return { error: `${e.constructor.name}: ${e.message}` };
  }
};

// --- Python answers ---
const python = spawn('python3', [path.join(repoRoot, 'scripts/differential_check.py'), pythonLibPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let stdout = '';
python.stdout.on('data', (chunk) => (stdout += chunk));

const pythonDone = new Promise((resolve, reject) => {
  python.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`python exited ${code}`))));
  python.on('error', reject);
});

python.stdin.write(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
python.stdin.end();
await pythonDone;

const pythonAnswers = stdout
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

if (pythonAnswers.length !== requests.length) {
  console.error(`Expected ${requests.length} answers from python, got ${pythonAnswers.length}`);
  process.exit(1);
}

// --- compare ---
let mismatches = 0;
requests.forEach((request, i) => {
  const ts = tsAnswer(request);
  const py = pythonAnswers[i];
  // Both erroring counts as agreement (e.g. invalid input rejected by both).
  if (ts.error && py.error) {
    return;
  }
  if (JSON.stringify(ts) !== JSON.stringify(py)) {
    mismatches += 1;
    if (mismatches <= 10) {
      console.error(`MISMATCH on ${JSON.stringify(request)}`);
      console.error(`  ts: ${JSON.stringify(ts)}`);
      console.error(`  py: ${JSON.stringify(py)}`);
    }
  }
});

if (mismatches > 0) {
  console.error(`\n${mismatches}/${requests.length} mismatches`);
  process.exit(1);
}
console.log(`OK — ${requests.length} operations agree between TypeScript and Python`);
