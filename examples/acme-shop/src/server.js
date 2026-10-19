import http from 'node:http';
import fs from 'node:fs';
import { products } from './products.js';

const server = http.createServer((req, res) => {
  if (req.url === '/api/products') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(products));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(fs.readFileSync(new URL('../public/index.html', import.meta.url)));
});

server.listen(3000, () => console.log('Acme Shop on http://localhost:3000'));
