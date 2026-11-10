---
tags: [routing]
max_turns: 12
allowed_tools: [Skill, Read, Glob, Grep]
---

Add CSV export of the orders list. The API server needs a new
`GET /orders/export` endpoint that streams CSV, the web client needs an
"Export" button on the orders page that downloads it, and both need tests.
The design is approved; only the execution is left.
