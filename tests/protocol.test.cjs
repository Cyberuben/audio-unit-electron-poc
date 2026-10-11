const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateCommand } = require('../src/protocol.cjs');
test('renderer cannot load arbitrary filesystem paths or terminate the host', () => {
  for (const command of ['load', 'quit', '__proto__'])
    assert.throws(() => validateCommand({ command, path: '/etc/passwd' }));
  assert.deepEqual(validateCommand({ command: 'play', path: '/etc/passwd' }), { command: 'play' });
});
test('mix accepts the actual signed AU parameter range and rejects invalid input', () => {
  for (const value of [-100, 0, 100])
    assert.deepEqual(validateCommand({ command: 'mix', value }), { command: 'mix', value });
  for (const value of [NaN, Infinity, -101, 101, '20', null])
    assert.throws(() => validateCommand({ command: 'mix', value }));
});
test('boolean controls reject ambiguous values', () => {
  for (const command of ['loop', 'bypass']) {
    assert.deepEqual(validateCommand({ command, value: false }), { command, value: false });
    assert.throws(() => validateCommand({ command, value: 'false' }));
  }
});
