export const products = [
  { id: 'kb-01', name: 'Mechanical Keyboard', price: 129.0, stock: 12 },
  { id: 'ms-02', name: 'Wireless Mouse', price: 49.5, stock: 40 },
  { id: 'mn-03', name: '27" 4K Monitor', price: 389.99, stock: 5 },
  { id: 'hd-04', name: 'Noise-cancelling Headphones', price: 219.0, stock: 0 },
];

export function findProduct(id) {
  return products.find((p) => p.id === id);
}
