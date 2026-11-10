#!/usr/bin/env bash
# Fixture: a small two-part project (API server + web client) with a git history.
set -euo pipefail
mkdir -p api/src api/test web/src
cat > package.json <<'JSON'
{ "name": "orders-demo", "private": true, "workspaces": ["api", "web"] }
JSON
cat > api/package.json <<'JSON'
{ "name": "api", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > api/src/orders.js <<'JS'
const orders = [{ id: 1, customer: 'Ana', total: 40 }, { id: 2, customer: 'Beka', total: 15 }]
export function listOrders(query = {}) {
  // no input validation: query.limit is used as given
  return orders.slice(0, query.limit)
}
export function findOrder(id) {
  return orders.find(o => o.id == id)
}
JS
cat > api/src/server.js <<'JS'
import http from 'node:http'
import { listOrders, findOrder } from './orders.js'
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/orders') return res.end(JSON.stringify(listOrders({ limit: url.searchParams.get('limit') })))
  const m = url.pathname.match(/^\/orders\/(.+)$/)
  if (m) return res.end(JSON.stringify(findOrder(m[1])))
  res.statusCode = 404; res.end()
}).listen(3000)
JS
cat > api/test/orders.test.js <<'JS'
import test from 'node:test'
import assert from 'node:assert'
import { listOrders } from '../src/orders.js'
test('lists orders', () => assert.equal(listOrders({ limit: 1 }).length, 1))
JS
cat > web/package.json <<'JSON'
{ "name": "web", "type": "module" }
JSON
cat > web/src/api.js <<'JS'
export async function fetchOrders() {
  const res = await fetch('http://localhost:3000/orders')
  return res.json() // no error handling for a non-200 answer
}
JS
cat > web/src/orders-page.js <<'JS'
import { fetchOrders } from './api.js'
export async function render(root) {
  const orders = await fetchOrders()
  root.innerHTML = orders.map(o => `<li>${o.customer}: ${o.total}</li>`).join('')
}
JS
git init -q -b main . && git add -A && git -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "initial"
