---
name: X Check Prod
description: 检查 jt_workbench 线上（生产）单体环境的健康状态与会话有效性；缺少账号/密码时先向用户索要，不得猜测或编造。仅当用户要求检查线上/生产/prod 环境时使用。
---

# 检查线上环境（x-check-prod）

对已部署的线上单体（Spring Boot，`jt_workbench`）做只读健康检查。优先复用本地缓存的会话 cookie；仅当缓存失效或缺失时才 `POST /admin/auth/login`（账号密码登录，密码使用登录页同款 eye 编码）重建会话，并将新 cookie 写入本地 gitignored 缓存。所有 API 返回统一信封 `{success, code, data, message}`；`code === 0`（当前线上实测多为 200，同样视为正常）。

## 凭据与地址约定

- 凭据文件：仓库根目录 `online-token.txt`（已被 `.gitignore` 忽略，**禁止提交/外传/回显**）：
  - 第 1 行：线上 base URL（如 `https://example.com`，末尾不带 `/`）
  - 第 2 行：账号（username）
  - 第 3 行：密码（password）
- 会话缓存：仓库根目录 `online-cookie.txt`（已被 `.gitignore` 忽略，**禁止提交/外传/回显**），由脚本自动维护；会话失效时自动清理并重登。
- **若凭据文件缺失、为空或只有一行**：立即停下来向用户询问（用 question 工具或直接提问），分别索要：
  1. 线上 base URL
  2. 账号（username）
  3. 密码（password）
- 拿到后把三行写入 `online-token.txt`（utf8，编辑工具写入），不要猜测、不要编造、不要用占位符运行；**不得回显密码**。
- 确认 `online-token.txt`、`online-cookie.txt` 未被 git 跟踪（`.gitignore` 已含；若 `git status` 出现它们，说明忽略被破坏，先停下来报告）。

## 执行步骤

1. 工作目录切到仓库根，读取 `online-token.txt`；缺凭据 → 按上述约定向用户索要，写好后再继续。
2. 运行检查脚本（路径相对本 skill 目录）：

   ```sh
   node <skill-dir>/scripts/prod-check.mjs
   ```

   脚本优先使用 `online-cookie.txt` 中的缓存会话 cookie（仅发 GET）；若缓存缺失或失效，才 `POST /admin/auth/login`（`{username, password}`，密码 eye 编码）重建会话并刷新缓存。退出码：0=全部通过，1=有失败，2=缺凭据/缺配置。
3. 按 PASS/FAIL 汇总四个检查项并解释：
   - `POST /admin/auth/login`（登录）：使用缓存时显示 `SKIP`；缓存失效时执行登录并捕获会话 cookie。
   - `GET /admin/public/site-info`（公开）：`data.title` 等公开信息。
   - `GET /admin/public/login-info`（需会话）：验证会话；未登录时 `code=500`、message=「未登录」。
   - `GET /admin/user-center/sessions`（需会话）：验证当前账号有在线会话。
4. 失败处理：
   - 登录失败（`http=401`，或未捕获到会话 cookie）→ 告知用户：请核对账号密码；如账号不存在或密码错误/账户被锁定，请在线上 Web 界面（系统管理→用户管理，或登录页改密）重置/修改密码，更新文件第 3 行后重跑。
   - 网络错误/DNS 失败 → base URL 可能不对：向用户确认地址。
   - 连续 429 → 触发了登录失败限频之外的问题，先停下报告，不要重试。

## 红线

- **检查自身只发 GET**；唯一的 POST 为 `POST /admin/auth/login`，且仅在缓存会话缺失/失效时用于建立本地会话凭证，除非用户在本次对话中明确逐项授权。
- **不在输出、日志、提交信息中回显密码或会话 cookie**（不仅限前 8 字符 + 长度，是不回显）。
- 不把密码/base URL/cookie 写入任何会被提交的文件（AGENTS.md、README、docs、CI 配置等一律不得包含；`online-token.txt`、`online-cookie.txt` 只落本地 gitignored 文件）。
- 检查结果只做报告与建议，不自动执行修复性写操作；**不自行重置或改密线上账号**（改密必须经线上 Web 界面由用户操作）。
