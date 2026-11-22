---
name: X Check Prod
description: 检查 jt_workbench 线上（生产）单体环境的健康状态与会话有效性；缺少 token 时先向用户索要，不得猜测或编造。仅当用户要求检查线上/生产/prod 环境时使用。
---

# 检查线上环境（x-check-prod）

对已部署的线上单体（Node + SQLite + R2）做**只读**健康检查。所有 API 返回统一信封 `{code, data, message}`，`code === 0` 为正常。

## 凭据与地址约定

- 凭据文件：仓库根目录 `online-token.txt`（已被 `.gitignore` 忽略，**禁止提交/外传/回显**）：
  - 第 1 行：线上 base URL（如 `https://example.com`，末尾不带 `/`）
  - 第 2 行：会话 token（登录后 cookie `wb_token` 的 JWT 值）
- **若文件缺失、为空或只有一行：立即停下来向用户询问**（用 question 工具或直接提问），分别索要：
  1. 线上 base URL
  2. 会话 token（`wb_token` cookie 的值）
- 拿到后把两行写入 `online-token.txt`（utf8，编辑工具写入），不要猜测、不要编造、不要用占位符运行。
- 确认该文件未被 git 跟踪（`.gitignore` 已含 `online-token.txt`；若 `git status` 出现它，说明忽略被破坏，先停下来报告）。

## 执行步骤

1. 工作目录切到仓库根，读取 `online-token.txt`；缺 token → 按上述约定向用户索要，写好后再继续。
2. 运行只读检查脚本（路径相对本 skill 目录）：

   ```sh
   node <skill-dir>/scripts/prod-check.mjs
   ```

   脚本只发 GET、自动读取 `online-token.txt`、不回显 token。退出码：0=全部通过，1=有失败，2=缺凭据/缺配置。
3. 按 PASS/FAIL 汇总四个检查项并解释：
   - `GET /api/health`（公开）：`data.bootedAt` 为 epoch 毫秒，可换算进程已运行时长。
   - `GET /api/auth/status`（公开）：`data.initialized` 应为 `true`。
   - `GET /api/me`（需会话）：验证 token 是否有效，`data.username` 为当前用户。
   - `GET /api/admin/summary`（需会话）：管理端可读。
4. 失败处理：
   - `http=401 message=unauthorized|session revoked` → token 过期/被撤销：告知用户，请其重新提供新 token，更新文件第 2 行后重跑。
   - 网络错误/DNS 失败 → base URL 可能不对：向用户确认地址。
   - 连续 429 → 触发了登录失败限频之外的问题，先停下报告，不要重试。

## 红线

- **只读**：仅 GET。禁止任何 POST/PUT/DELETE/PATCH（包括 `/api/admin/config`、`rotate`、`password`、`mail/test` 等写入口），除非用户在本次对话中明确逐项授权。
- 不在输出、日志、提交信息中回显完整 token；展示时最多前 8 字符 + 长度。
- 不把 token/base URL 写入任何会被提交的文件（AGENTS.md、README、docs、CI 配置等一律不得包含）。
- 检查结果只做报告与建议，不自动执行修复性写操作。
