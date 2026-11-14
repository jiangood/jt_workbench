# Agent scripts

Add one trusted JavaScript ES module per script as `<id>.mjs`.

Each file must begin with a JSON metadata comment:

```js
/**
 * @script
 * {
 *   "id": "example",
 *   "name": "Example task",
 *   "version": "1.0.0",
 *   "description": "Short purpose",
 *   "schedule": "0 0 */2 * * *",
 *   "enabled": false,
 *   "timeout": 300,
 *   "reliability": "best_effort"
 * }
 */

export async function run(context, payload) {
  // Trusted code only. The runtime does not sandbox this module.
}
```

The Worker release build validates metadata and the six-field Asia/Shanghai Cron,
calculates SHA-256 over the exact UTF-8 source bytes, and copies immutable
`<id>/<version>.mjs` assets plus a generated manifest into `public/agent-scripts`.
Never put credentials in source or metadata. Code is published only through reviewed PRs.
