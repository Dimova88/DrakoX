import { findProduct } from './products.js';

const CODES = {
  WELCOME10: { type: 'percent', value: 10 },
  FIVEOFF: { type: 'fixed', value: 5 },
};

export class Cart {
  constructor() {
    this.items = new Map();
    this.code = null;
  }

  add(id, qty = 1) {
    const product = findProduct(id);
    if (!product) throw new Error(`Unknown product ${id}`);
    if (product.stock === 0) throw new Error(`${product.name} is out of stock`);
    const current = this.items.get(id) ?? 0;
    this.items.set(id, current + qty);
  }

  remove(id) {
    this.items.delete(id);
  }

  applyCode(code) {
    if (!CODES[code]) throw new Error(`Invalid code ${code}`);
    this.code = code;
  }

  subtotal() {
    let sum = 0;
    for (const [id, qty] of this.items) sum += findProduct(id).price * qty;
    return sum;
  }

  /** Total after discount, rounded to cents. */
  total() {
    const subtotal = this.subtotal();
    const discount = this.code ? CODES[this.code] : null;
    let total = subtotal;
    if (discount?.type === 'percent') total = subtotal - subtotal * discount.value;
    if (discount?.type === 'fixed') total = subtotal - discount.value;
    return Math.round(total * 100) / 100;
  }
}
