const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculatePrice
} = require('../lib/ppobService');

test('PPOB markup is added exactly without price rounding', () => {
  assert.equal(calculatePrice(4500, 500), 5000);
  assert.equal(calculatePrice(4500, 1000), 5500);
});

test('PPOB rejects invalid prices and never applies negative markup', () => {
  assert.equal(calculatePrice('invalid', 500), null);
  assert.equal(calculatePrice(-1, 500), null);
  assert.equal(calculatePrice(4500, -500), 4500);
});
