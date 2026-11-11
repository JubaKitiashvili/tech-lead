---
tags: [routing, guard]
max_turns: 8
allowed_tools: [Skill, Read, Glob, Grep]
---

My test fails with this and I do not understand why:

```
TypeError: Cannot read properties of undefined (reading 'map')
    at render (web/src/orders-page.js:4:28)
```

`orders` comes from `await fetchOrders()`. Why does this fail?
