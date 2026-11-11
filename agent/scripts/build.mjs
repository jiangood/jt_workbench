import { build } from 'esbuild'

// pino 等 CJS 依赖打进 ESM 单文件后，动态 require 需 createRequire 兜底
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/agent.mjs',
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
})
