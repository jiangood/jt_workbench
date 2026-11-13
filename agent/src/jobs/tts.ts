import { spawn } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { getConfig } from '../config.js'
import type { JobHandler } from '../types.js'

const segmentSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{1,64}$/i),
  text: z.string().min(1).max(4000),
})

const payloadSchema = z.object({
  bookId: z.number().int().positive(),
  voice: z.string().regex(/^[a-zA-Z0-9._-]+$/).default('zh_CN-huayan-medium'),
  segments: z.array(segmentSchema).min(1).max(400),
})

const PIPER_BIN = process.env.PIPER_BIN || '/opt/piper/piper'
const PIPER_VOICE_DIR = process.env.PIPER_VOICE_DIR || '/opt/piper/voices'

function runPiper(text: string, modelPath: string, outPath: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(PIPER_BIN, ['--model', modelPath, '--output_file', outPath], {
      stdio: ['pipe', 'ignore', 'pipe'],
      signal,
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += String(d)
      if (stderr.length > 2000) stderr = stderr.slice(-2000)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`piper exited ${code}: ${stderr.trim()}`))
    })
    child.stdin.end(text)
  })
}

async function uploadAudio(params: {
  serverUrl: string
  nodeKey: string
  bookId: number
  voice: string
  key: string
  filePath: string
  signal: AbortSignal
}): Promise<void> {
  const url = `${params.serverUrl}/node/tts/upload?bookId=${params.bookId}&key=${encodeURIComponent(params.key)}&voice=${encodeURIComponent(params.voice)}`
  const body = createReadStream(params.filePath)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'audio/wav',
      'x-node-key': params.nodeKey,
    },
    body: body as any,
    duplex: 'half',
    signal: params.signal,
  } as RequestInit)
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`upload HTTP ${res.status} ${txt.slice(0, 200)}`)
  }
}

export const ttsHandler: JobHandler = async (payload, ctx) => {
  const { bookId, voice, segments } = payloadSchema.parse(payload)
  const cfg = getConfig()
  const modelPath = path.join(PIPER_VOICE_DIR, `${voice}.onnx`)
  await fs.access(modelPath)

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-'))
  let okCount = 0
  try {
    for (const seg of segments) {
      if (ctx.signal.aborted) throw new Error('aborted')
      const outPath = path.join(tmpDir, `${seg.key}.wav`)
      await runPiper(seg.text, modelPath, outPath, ctx.signal)
      await uploadAudio({
        serverUrl: cfg.serverUrl,
        nodeKey: cfg.nodeKey,
        bookId,
        voice,
        key: seg.key.toLowerCase(),
        filePath: outPath,
        signal: ctx.signal,
      })
      okCount++
      await fs.unlink(outPath).catch(() => {})
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }

  return { items: [], summary: `tts: ${okCount}/${segments.length} segments (book ${bookId}, ${voice})` }
}
