import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateLegacyLocalStorage, upgradeLegacyFlags } from '../../src/api/historyStorage.js';

test('upgradeLegacyFlags renames snapshot flags, including the nested summary', () => {
  const snapshot = upgradeLegacyFlags({ isAstraUniverseSnapshot: true, historySummary: { isAstraHistorySummary: true } });
  assert.deepEqual(snapshot, { isOrbituneUniverseSnapshot: true, historySummary: { isOrbituneHistorySummary: true } });
});

test('migrateLegacyLocalStorage moves old keys without overwriting new ones', () => {
  const store = { astra_volume: '5', astra_lens: 'old', orbitune_lens: 'new', unrelated: 'x' };
  globalThis.localStorage = new Proxy(store, {
    get(target, prop) {
      if (prop === 'getItem') return key => (key in target ? target[key] : null);
      if (prop === 'setItem') return (key, value) => { target[key] = value; };
      if (prop === 'removeItem') return key => { delete target[key]; };
      return target[prop];
    }
  });
  migrateLegacyLocalStorage();
  delete globalThis.localStorage;
  assert.deepEqual(store, { orbitune_volume: '5', orbitune_lens: 'new', unrelated: 'x' });
});
