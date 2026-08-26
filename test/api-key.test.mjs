// resolveApiKey(): the credential resolution order and the ZCode opt-in
// boundary, exercised against a throwaway HOME so the suite never reads (or
// depends on) the real configuration on the machine running it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiKey } from '../dist/glm.js';

// A throwaway home directory holding whichever key sources a test wants present.
const fakeHome = ({ keyFile, zcodeKey } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'glm-api-key-test-'));
  if (keyFile !== undefined) {
    mkdirSync(join(home, '.config', 'zai'), { recursive: true });
    writeFileSync(join(home, '.config', 'zai', 'api-key'), keyFile);
  }
  if (zcodeKey !== undefined) {
    mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'v2', 'config.json'), JSON.stringify({
      provider: { 'builtin:zai-coding-plan': { options: { apiKey: zcodeKey } } },
    }));
  }
  return home;
};

// Point os.homedir() at the fixture and pin every credential variable; returns
// a restore function. os.homedir() reads HOME on POSIX and USERPROFILE on
// Windows, so both are set.
const isolate = (home) => {
  const saved = {};
  for (const name of ['HOME', 'USERPROFILE', 'ZAI_API_KEY', 'GLM_MCP_ALLOW_ZCODE_KEY']) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
};

const withHome = (fixture, fn) => () => {
  const home = fakeHome(fixture);
  const restore = isolate(home);
  try {
    fn();
  } finally {
    restore();
    rmSync(home, { recursive: true, force: true });
  }
};

test('ZAI_API_KEY wins over the key file and the ZCode key', withHome(
  { keyFile: 'sk-file\n', zcodeKey: 'sk-zcode' },
  () => {
    process.env.ZAI_API_KEY = 'sk-env';
    process.env.GLM_MCP_ALLOW_ZCODE_KEY = '1'; // even opted in, the env var has priority
    assert.equal(resolveApiKey(), 'sk-env');
  },
));

test('the key file is used before the ZCode key', withHome(
  { keyFile: 'sk-file\n', zcodeKey: 'sk-zcode' },
  () => {
    process.env.GLM_MCP_ALLOW_ZCODE_KEY = '1';
    assert.equal(resolveApiKey(), 'sk-file');
  },
));

test('the ZCode key is rejected unless GLM_MCP_ALLOW_ZCODE_KEY=1', withHome(
  { zcodeKey: 'sk-zcode' },
  () => {
    assert.throws(resolveApiKey, /No z\.ai API key/,
      'another application\'s credential must not be read by default');
    process.env.GLM_MCP_ALLOW_ZCODE_KEY = '1';
    assert.equal(resolveApiKey(), 'sk-zcode');
  },
));

test('only the exact value 1 unlocks the ZCode key', withHome(
  { zcodeKey: 'sk-zcode' },
  () => {
    for (const value of ['true', 'yes', '0', '']) {
      process.env.GLM_MCP_ALLOW_ZCODE_KEY = value;
      assert.throws(resolveApiKey, /No z\.ai API key/, `GLM_MCP_ALLOW_ZCODE_KEY=${JSON.stringify(value)}`);
    }
  },
));

test('no key anywhere throws with guidance', withHome({}, () => {
  assert.throws(resolveApiKey, (e) => {
    assert.ok(e instanceof Error);
    assert.match(e.message, /ZAI_API_KEY/);
    assert.match(e.message, /GLM_MCP_ALLOW_ZCODE_KEY/);
    return true;
  });
}));

test('a whitespace-only ZAI_API_KEY falls through to the key file', withHome(
  { keyFile: 'sk-file\n' },
  () => {
    process.env.ZAI_API_KEY = '   ';
    assert.equal(resolveApiKey(), 'sk-file');
  },
));

test('an empty key file falls through to the ZCode key', withHome(
  { keyFile: '\n', zcodeKey: 'sk-zcode' },
  () => {
    process.env.GLM_MCP_ALLOW_ZCODE_KEY = '1';
    assert.equal(resolveApiKey(), 'sk-zcode');
  },
));
