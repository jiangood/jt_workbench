// M1 Spike · 验证「cron 迁移零换算」：croner 解析 Spring Quartz 风格 seed cron（含 ? 与 MON-FRI）
import { Cron } from 'croner'

// 抄自 D:\ws\workbench\WorkbenchDataInitializer.java 的 9 条 seed（含已砍/合并任务，一并验证解析）
const cases = [
  ['IT资讯-抓取', '0 0 */2 * * ?'],
  ['IT资讯-正文清理', '0 30 3 * * ?'],
  ['自选股-行情同步', '0 35 15 ? * MON-FRI'],
  ['自选股-盘中刷新', '0 */10 9-14 ? * MON-FRI'],
  ['运维-数据备份', '0 0 */6 * * ?'],
  ['提醒-扫描发送', '0 */10 * * * ?'],
  ['影音-下载清理', '0 40 4 * * ?'],
  ['知识星球-同步', '0 20 * * * ?'],
  ['知识星球-数据处理', '0 45 * * * ?'],
]

let failed = 0
for (const [name, expr] of cases) {
  try {
    const job = new Cron(expr, { timezone: 'Asia/Shanghai' })
    const runs = [job.nextRun(), job.nextRun(job.nextRun()), job.nextRun(job.nextRun(job.nextRun()))]
    console.log(`OK   ${name}  ${expr}`)
    console.log(`     next: ${runs.map((d) => (d ? fmt(d) : 'null')).join(' | ')}`)
  } catch (e) {
    failed++
    console.log(`FAIL ${name}  ${expr}  -> ${e.message}`)
  }
}
console.log(failed ? `\n${failed} 条解析失败，需最小换算` : '\n9 条全部解析成功，零换算成立')

function fmt(d) {
  // Asia/Shanghai 语义校验：+8h 后的 ISO
  return new Date(d.getTime() + 8 * 3600_000).toISOString().replace('T', ' ').replace('Z', '+08:00')
}
