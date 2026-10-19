import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';

test('adds items and computes the subtotal', () => {
  const cart = new Cart();
  cart.add('kb-01');
  cart.add('ms-02', 2);
  assert.equal(cart.subtotal(), 228);
});

test('rejects out-of-stock products', () => {
  const cart = new Cart();
  assert.throws(() => cart.add('hd-04'), /out of stock/);
});

test('applies a fixed discount', () => {
  const cart = new Cart();
  cart.add('ms-02');
  cart.applyCode('FIVEOFF');
  assert.equal(cart.total(), 44.5);
});

test('applies a percentage discount', () => {
  const cart = new Cart();
  cart.add('kb-01');
  cart.applyCode('WELCOME10');
  assert.equal(cart.total(), 116.1);
});
