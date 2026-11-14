# Agent scripts

Add one trusted JavaScript ES module per immutable version as `<id>/<version>.mjs`. Keep older versions in the tree so in-flight executions can recover the exact code they were created with.

Each file must begin with a JSON metadata comment:

```js
// @script
// {
//   "id": "example",
//   "name": "Example task",
//   "version": "1.0.0",
//   "description": "Short purpose",
//   "schedule": "0 0 */2 * * *",
//   "enabled": false,
//   "timeout": 300,
//   "reliability": "best_effort"
// }

export async function run(context, payload) {
  // Trusted code only. The runtime does not sandbox this module.
}
```

The Worker release build validates metadata and the six-field Asia/Shanghai Cron,
calculates SHA-256 over the exact UTF-8 source bytes, copies every immutable version
into `public/agent-scripts/<id>/<version>.mjs`, and marks the highest semver as the
active version in the generated manifest.
Never put credentials in source or metadata. Code is published only through reviewed PRs.
