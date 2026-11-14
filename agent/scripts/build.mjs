import { mkdir } from 'node:fs/promises'
import { build } from 'esbuild'

// 版本号在镜像构建时注入（release.yml 传发布 tag，这里去掉前缀 v）；本地构建回退 dev
const agentVersion = (process.env.AGENT_VERSION ?? '').trim().replace(/^v/, '') || 'dev'

// pino 等 CJS 依赖打进 ESM 单文件后，动态 require 需 createRequire 兜底
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/agent.mjs',
  define: {
    __AGENT_VERSION__: JSON.stringify(agentVersion),
  },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
})

await mkdir('dist/remote-libs', { recursive: true })
await build({
  entryPoints: ['src/jobs/zsxq.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  packages: 'external',
  outfile: 'dist/remote-libs/zsxq-jobs.mjs',
  logLevel: 'info',
})
