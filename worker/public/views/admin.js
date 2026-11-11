import { api, closeModal, esc, fmtTime, icon, showDialog } from '../lib.js'

// 重置 JWT 密钥后跳登录页的定时器：切页要清掉，避免 destroy 之后还跳转
let redirectTimer = 0
// 弹窗里等待节点首次接入的轮询定时器（切页 / 关弹窗 / 上线都要停）
let installPollTimer = 0

export async function render(main) {
  const [nodes, cfg] = await Promise.all([
    api('/api/admin/nodes'),
    api('/api/admin/config'),
  ])

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">系统管理</h1>
        <p class="page-sub">节点、任务运行与参数维护（参数全部存 D1，可随时改）</p>
      </div>
    </div>

    <div class="section-head">
      <h2>执行节点</h2>
      <button class="btn primary sm" id="node-add" type="button">${icon('plus')}添加节点</button>
    </div>
    <div class="small muted" style="max-width: 980px">
      添加节点后立刻登记（接入前显示离线），并生成一条 <code>curl | sh</code> 接入命令（<strong>长期有效</strong>）：
      在目标 Linux 机器的任意目录执行，会自动创建 <code>workbench-agent/docker-compose.yml</code>（仅此一个文件）并启动。
      宿主机不需要 <code>.env</code>，密钥由后台生成并只写进 compose、页面不展示；
      现场不能马上接入也没关系，之后随时点该行「查看接入方式」取回命令。需要换密钥点「重置密钥」。
    </div>
    <table style="max-width: 980px">
      <thead><tr><th>节点</th><th>版本</th><th>状态</th><th>最后心跳</th><th>在持任务</th><th></th></tr></thead>
      <tbody id="nodes-body"></tbody>
    </table>
    <div class="small mt-2" id="node-msg" role="status"></div>


    <div class="section-head"><h2>最近任务运行（7 天）</h2></div>
    <table style="max-width: 860px">
      <thead><tr><th>时间</th><th>节点</th><th>版本</th><th>任务</th><th>结果</th><th>耗时</th></tr></thead>
      <tbody>
        ${
          nodes.recentRuns
            .map(
              (r) => `
          <tr>
            <td class="small">${fmtTime(r.run_at)}</td>
            <td class="mono small">${esc(r.node_id)}</td>
            <td class="small">${esc(r.agent_version)}</td>
            <td class="small mono">#${esc(r.job_id)}</td>
            <td class="small">${r.ok ? '<span class="pill ok"><span class="dot"></span>OK</span>' : '<span class="pill bad"><span class="dot"></span>FAIL</span>'}
              <span class="muted">${esc((r.message || '').slice(0, 80))}</span></td>
            <td class="small">${r.ms != null ? esc(r.ms) + 'ms' : '—'}</td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="6" class="muted">暂无运行记录</td></tr>'
        }
      </tbody>
    </table>

    <div class="section-head"><h2>参数与密钥</h2></div>
    <div class="small muted" style="max-width: 860px">
      全部存 D1 <code>app_config</code>，保存即生效，不再需要 <code>wrangler secret</code>；
      管理员密码在下方「账号安全」，节点由上面「执行节点」直接登记。
    </div>
    <div id="cfg-list" class="mt-2" style="max-width: 860px"></div>
    <div id="cfg-note" class="small mt-2" role="status" style="max-width: 860px"></div>
    <div class="small muted mt-2" style="max-width: 860px">
      知识星球 token 也在这里维护：下发 <code>zsxq_sync</code> 任务时由 Worker 注入 payload，agent 侧无需任何环境变量。
    </div>

    <div class="section-head"><h2>账号安全</h2></div>
    <div class="card" style="max-width: 640px">
      <div class="card-body">
        <div>登录账号：<code>admin</code>；密码存 D1（<code>auth_state</code>），不再依赖 worker secret</div>
        <form id="pwd" class="mt-2" style="max-width: 420px">
          <label class="sr-only" for="pwd-old">当前密码</label>
          <input class="field" id="pwd-old" name="oldPassword" type="password" placeholder="当前密码" autocomplete="current-password" required aria-describedby="pwd-msg" />
          <label class="sr-only" for="pwd-new">新密码</label>
          <input class="field mt-2" id="pwd-new" name="newPassword" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" minlength="8" required aria-describedby="pwd-msg" />
          <label class="sr-only" for="pwd-confirm">确认新密码</label>
          <input class="field mt-2" id="pwd-confirm" name="confirm" type="password" placeholder="确认新密码" autocomplete="new-password" minlength="8" required aria-describedby="pwd-msg" />
          <button class="btn primary sm mt-2" id="pwd-submit">${icon('gear')}更新密码</button>
          <div id="pwd-msg" class="small mt-2" role="alert"></div>
        </form>
        <div class="small muted mt-2">改密后所有已登录会话立即失效（含当前），需用新密码重新登录。</div>
        <button class="btn sm warn mt-2" id="rotate">${icon('gear')}撤销全部旧会话（不改密码）</button>
      </div>
    </div>`

  // ---------- 节点登记（添加即入库 + 长期有效的接入方式，v4.13） ----------
  let nodeList = nodes.nodes ?? []
  const nodeBody = main.querySelector('#nodes-body')
  const nodeMsg = main.querySelector('#node-msg')
  let currentInstall = null

  const nodeSay = (text, bad = false) => {
    nodeMsg.className = bad ? 'small mt-2 danger-text' : 'small mt-2'
    nodeMsg.textContent = text
  }

  const paintNodes = () => {
    nodeBody.innerHTML =
      nodeList
        .map(
          (n) => `
          <tr>
            <td class="mono">${esc(n.node_id)}</td>
            <td>${esc(n.agent_version || '—')}</td>
            <td>${
              n.online
                ? `<span class="pill ok"><span class="dot"></span>在线</span>`
                : `<span class="pill bad"><span class="dot"></span>离线</span>`
            }</td>
            <td class="small">${fmtTime(n.last_seen_at)}</td>
            <td class="small">${esc(n.heldJobs ?? 0)}</td>
            <td style="white-space: nowrap">
              <button class="btn sm" data-act="install" data-node="${esc(n.node_id)}" type="button">查看接入方式</button>
              <button class="btn sm warn" data-act="rotate" data-node="${esc(n.node_id)}" type="button">重置密钥</button>
              <button class="btn sm warn" data-act="del" data-node="${esc(n.node_id)}" type="button">注销</button>
            </td>
          </tr>`,
        )
        .join('') ||
      '<tr><td colspan="6" class="muted">还没有节点——点右上角「添加节点」登记，接入前会一直显示离线</td></tr>'
  }
  paintNodes()

  const installStatusHtml = (online) =>
    online
      ? `<span class="pill ok"><span class="dot"></span>节点已接入（在线）</span>
         <span class="small muted">换机 / 重装可直接使用下面的命令</span>`
      : `<span class="pill"><span class="dot"></span>等待接入</span>
         <span class="small muted">命令长期有效，可以先关掉页面，之后从该行「查看接入方式」取回</span>`

  const installHtml = (install, online) => `
    <h2>接入方式『${esc(install.nodeId)}』</h2>
    <div class="small muted">
      在目标 Linux 机器的<strong>任意目录</strong>执行下面命令，脚本会创建
      <code>workbench-agent/docker-compose.yml</code> 并启动容器。
    </div>
    <div class="mt-2" id="install-status" role="status">${installStatusHtml(online)}</div>

    <div class="section-head"><h2>一键脚本</h2></div>
    <pre class="code-block">${esc(install.command)}</pre>
    <button class="btn primary sm" data-copy="command" type="button">复制命令</button>

    <details class="mt-3">
      <summary class="small" style="cursor: pointer">手动方案（自己创建 compose）</summary>
      <div class="small muted mt-2">在目标机器的任意目录依次执行：</div>
      <pre class="code-block">mkdir -p workbench-agent &amp;&amp; cd workbench-agent
cat &gt; docker-compose.yml &lt;&lt;'YAML'
${esc(install.compose)}YAML
docker compose up -d</pre>
      <button class="btn sm" data-copy="compose" type="button">复制 compose</button>
    </details>

    <div class="small muted mt-3">
      compose 里已内联节点密钥，请勿提交仓库或外传。命令长期有效，重装时会自动带上
      <code>WORKBENCH_AGENT_FORCE=1</code> 覆盖已有 compose；重置密钥后旧命令立即失效。
    </div>
    <div class="dlg-foot"><button class="btn sm" data-close type="button">关闭</button></div>`

  const stopInstallPoll = () => {
    if (installPollTimer) clearInterval(installPollTimer)
    installPollTimer = 0
  }

  /** 弹窗打开期间轮询列表：该节点首次 poll 上线后自动提示（关掉弹窗就停） */
  const startInstallPoll = (install, online) => {
    stopInstallPoll()
    if (online) return
    const dlg = document.getElementById('dlg')
    installPollTimer = setInterval(async () => {
      if (!dlg.open) {
        stopInstallPoll() // 用户按 Esc 关闭原生 dialog
        return
      }
      try {
        const res = await api('/api/admin/nodes')
        nodeList = res.nodes
        paintNodes()
        const node = nodeList.find((n) => n.node_id === install.nodeId)
        if (!node || !node.online) return
        stopInstallPoll()
        const el = document.getElementById('install-status')
        if (el) el.innerHTML = installStatusHtml(true)
      } catch {
        // 网络抖动：下一轮继续
      }
    }, 3000)
  }

  const showInstall = (install) => {
    currentInstall = install
    const node = nodeList.find((n) => n.node_id === install.nodeId)
    const online = !!node?.online
    const { body } = showDialog(installHtml(install, online), { xl: true })
    body.onclick = async (e) => {
      if (e.target.closest('[data-close]')) {
        stopInstallPoll()
        closeModal()
        return
      }
      const btn = e.target.closest('button[data-copy]')
      if (!btn || !currentInstall) return
      const text = btn.dataset.copy === 'compose' ? currentInstall.compose : currentInstall.command
      try {
        await navigator.clipboard.writeText(text)
        btn.textContent = '已复制'
      } catch {
        btn.textContent = '复制失败，请手动选中'
      }
    }
    startInstallPoll(install, online)
  }


  nodeBody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const node = nodeList.find((n) => n.node_id === btn.dataset.node)
    if (!node) return

    if (btn.dataset.act === 'install') {
      btn.disabled = true
      try {
        const res = await api(`/api/admin/nodes/${encodeURIComponent(node.node_id)}/install`)
        showInstall(res.install)
      } catch (err) {
        nodeSay(err.message, true)
      } finally {
        btn.disabled = false
      }
      return
    }

    if (btn.dataset.act === 'rotate') {
      if (
        !confirm(
          `重置节点 ${node.node_id} 的密钥？旧密钥立即失效，该 agent 会持续 401，必须用新的接入命令重新部署（会覆盖已有 compose）。`,
        )
      )
        return
      btn.disabled = true
      try {
        const res = await api(`/api/admin/nodes/${encodeURIComponent(node.node_id)}/rotate-key`, { method: 'POST' })
        nodeList = res.nodes
        paintNodes()
        nodeSay(`已重置 ${node.node_id} 的密钥：旧密钥立即失效，点「查看接入方式」取新命令重新部署`)
      } catch (err) {
        nodeSay(err.message, true)
        btn.disabled = false
      }
      return
    }

    if (btn.dataset.act === 'del') {
      if (!confirm(`注销节点 ${node.node_id}？密钥与接入命令立即失效，该 agent 会持续 401 直到重新添加。`)) return
      btn.disabled = true
      try {
        const res = await api(`/api/admin/nodes/${encodeURIComponent(node.node_id)}`, { method: 'DELETE' })
        nodeList = res.nodes
        paintNodes()
        nodeSay(`已注销 ${node.node_id}`)
      } catch (err) {
        nodeSay(err.message, true)
        btn.disabled = false
      }
    }
  }

  main.querySelector('#node-add').onclick = () => {
    stopInstallPoll()
    const { body } = showDialog(`
      <h2>添加节点</h2>
      <p class="small muted">节点名称只用于展示（建议用主机名，如 nas-01）。添加后立刻登记到列表（接入前显示离线），
      密钥由后台生成，只出现在接入命令里。</p>
      <form id="node-add-form">
        <label class="sr-only" for="node-add-name">节点名称</label>
        <input class="field" id="node-add-name" name="name" placeholder="节点名称" maxlength="32" autocomplete="off" required aria-describedby="node-add-msg" />
        <div class="small danger-text mt-2" id="node-add-msg" role="alert"></div>
        <div class="dlg-foot">
          <button class="btn sm" type="button" data-close>取消</button>
          <button class="btn primary sm" type="submit">添加</button>
        </div>
      </form>`)
    const form = body.querySelector('#node-add-form')
    const msg = body.querySelector('#node-add-msg')
    const nameEl = body.querySelector('#node-add-name')
    nameEl.addEventListener('input', () => {
      msg.textContent = ''
      nameEl.removeAttribute('aria-invalid')
    })
    body.onclick = (e) => {
      if (e.target.closest('[data-close]')) {
        stopInstallPoll()
        closeModal()
      }
    }
    form.onsubmit = async (e) => {
      e.preventDefault()
      const name = String(new FormData(form).get('name') || '').trim()
      if (!name) {
        msg.textContent = '请填写节点名称'
        nameEl.setAttribute('aria-invalid', 'true')
        nameEl.focus()
        return
      }
      const submit = form.querySelector('button[type="submit"]')
      submit.disabled = true
      msg.textContent = ''
      try {
        const res = await api('/api/admin/nodes', { method: 'POST', body: JSON.stringify({ name }) })
        nodeList = res.nodes
        paintNodes()
        nodeSay(`已添加 ${name}：接入前显示离线，之后随时点该行「查看接入方式」取命令`)
        showInstall(res.install)
      } catch (err) {
        msg.textContent = err.message
        submit.disabled = false
      }
    }
  }

  // ---------- 参数与密钥（D1 app_config，决策 #23） ----------
  const cfgList = main.querySelector('#cfg-list')
  const cfgNote = main.querySelector('#cfg-note')
  let cfgFields = cfg.fields
  const cfgState = new Map(cfgFields.map((f) => [f.key, f]))
  const cfgShown = new Set()
  // 邮件卡片最多一张：group 相同的字段合并进来（模板 / 账号 / 授权码 + 高级折叠区）
  const MAIL_GROUP = 'mail'
  const MAIL_KEYS = ['mail_provider', 'smtp_user', 'smtp_pass', 'reminder_to', 'smtp_host', 'smtp_port', 'smtp_secure', 'reminder_from', 'resend_api_key']
  // 卡片里的状态行：保存后整块重绘，提示要跟着重绘一起保留
  let mailNote = null

  const cfgSayNote = (text, bad = false) => {
    cfgNote.className = bad ? 'small mt-2 danger-text' : 'small mt-2'
    cfgNote.textContent = text
  }

  const cfgVal = (key) => cfgState.get(key)?.value ?? ''
  const cfgOptions = (key) => cfgState.get(key)?.options ?? []

  const maskValue = (v) => (v.length > 10 ? `${v.slice(0, 4)}${'•'.repeat(8)}${v.slice(-2)}` : '•'.repeat(8))
  const cfgSource = (f) =>
    f.source === 'd1'
      ? '<span class="pill ok"><span class="dot"></span>D1</span>'
      : '<span class="pill bad"><span class="dot"></span>未配置</span>'
  const cfgMeta = (f) => (f.updatedAt ? `更新于 ${fmtTime(f.updatedAt)}` : '尚未入库')

  const cfgHtml = (f) => {
    const shown = cfgShown.has(f.key)
    const masked = f.kind === 'secret' && !shown
    // 有 options 的字段渲染成下拉框
    const formField = f.options
      ? `<select class="field" name="value" aria-label="「${esc(f.label)}」的取值" aria-describedby="cfg-msg-${esc(f.key)}">
          <option value="">（未选择）</option>
          ${f.options
            .map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`)
            .join('')}
        </select>`
      : `<input class="field" name="value" autocomplete="off" spellcheck="false"
          aria-label="「${esc(f.label)}」的新值" aria-describedby="cfg-msg-${esc(f.key)}"
          placeholder="输入新值${f.required ? '' : '（留空 = 清空）'}" />`
    return `
      <div class="card" style="margin-bottom: 8px">
        <div class="card-body">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <strong>${esc(f.label)}</strong>
            <code class="mono small muted">${esc(f.key)}</code>
            ${cfgSource(f)}
          </div>
          <div class="small muted mt-2">${esc(f.hint)}</div>
          <div class="mt-2" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <code class="mono" data-act="val">${f.value ? esc(masked ? maskValue(f.value) : f.value) : '<span class="muted">（空）</span>'}</code>
            ${f.kind === 'secret' ? `<button class="btn sm" data-act="eye" type="button">${shown ? '隐藏' : '显示'}</button>` : ''}
            <button class="btn sm" data-act="copy" type="button" ${f.value ? '' : 'disabled'}>复制</button>
            <button class="btn sm" data-act="edit" type="button">编辑</button>
            ${f.canGenerate ? '<button class="btn sm" data-act="rotate" type="button">随机重置</button>' : ''}
          </div>
          <form data-act="form" class="mt-2" style="display: none; gap: 8px; flex-wrap: wrap">
            ${formField}
            <button class="btn sm" type="submit">保存</button>
            <button class="btn sm" type="button" data-act="cancel">收起</button>
          </form>
          <div class="small muted mt-2" data-act="meta">${cfgMeta(f)}</div>
          <div class="small mt-2" data-act="msg" id="cfg-msg-${esc(f.key)}" role="status"></div>
        </div>
      </div>`
  }

  // ---------- 邮件提醒：一张卡片搞定（模板 + 账号 + 授权码） ----------
  const mailReady = () => {
    if (!cfgVal('reminder_to')) return false
    // 与 mail.ts 的兜底一致：未选模板时有 Resend Key 走旧通道，否则按 SMTP
    const provider = cfgVal('mail_provider') || (cfgVal('resend_api_key') ? 'resend' : 'qq')
    if (provider === 'resend') return !!cfgVal('resend_api_key')
    return !!cfgVal('smtp_user') && !!cfgVal('smtp_pass')
  }

  const mailInput = (name, label, { type = 'text', placeholder = '', value = '', autocomplete = 'off', inputmode = '' } = {}) => `
    <label class="small" style="display: grid; gap: 4px">
      <span>${esc(label)}</span>
      <input class="field" name="${name}" type="${type}"${inputmode ? ` inputmode="${inputmode}"` : ''}
        autocomplete="${autocomplete}" spellcheck="false" placeholder="${esc(placeholder)}" value="${esc(value)}" />
    </label>`

  const mailSelect = (name, label, options, empty = '（未选择）') => `
    <label class="small" style="display: grid; gap: 4px">
      <span>${esc(label)}</span>
      <select class="field" name="${name}">
        <option value="">${esc(empty)}</option>
        ${options
          .map((o) => `<option value="${esc(o.value)}"${o.value === cfgVal(name) ? ' selected' : ''}>${esc(o.label)}</option>`)
          .join('')}
      </select>
    </label>`

  const mailCardHtml = () => {
    const provider = cfgVal('mail_provider')
    const hasPass = !!cfgVal('smtp_pass')
    const hasResendKey = !!cfgVal('resend_api_key')
    const advancedOpen = provider === 'custom' || provider === 'resend'
    return `
      <div class="card" style="margin-bottom: 8px">
        <div class="card-body">
          <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap">
            <strong>邮件提醒</strong>
            ${mailReady() ? '<span class="pill ok"><span class="dot"></span>已配置</span>' : '<span class="pill bad"><span class="dot"></span>待完善</span>'}
            <span class="small muted">选模板 + 填账号和授权码即可</span>
          </div>
          <div class="small muted mt-2">
            SMTP 主机 / 端口 / 加密方式按所选模板自动配好；QQ / 163 / 126 的「密码」要填邮箱<strong>授权码</strong>（邮箱设置里开启 SMTP 后获取），不是登录密码。
          </div>
          <form id="mail-form" class="mt-3" style="display: grid; gap: 10px; max-width: 420px">
            ${mailSelect('mail_provider', '服务商模板', cfgOptions('mail_provider'))}
            ${mailInput('smtp_user', '邮箱账号', { placeholder: 'you@qq.com', value: cfgVal('smtp_user'), autocomplete: 'username', inputmode: 'email' })}
            ${mailInput('smtp_pass', '授权码 / 密码', { type: 'password', placeholder: hasPass ? '已保存，留空则不修改' : '填邮箱授权码', autocomplete: 'new-password' })}
            ${mailInput('reminder_to', '收件邮箱', { placeholder: '提醒统一发到这里', value: cfgVal('reminder_to'), autocomplete: 'email', inputmode: 'email' })}
            <details${advancedOpen ? ' open' : ''}>
              <summary class="small" style="cursor: pointer">高级：自建 SMTP / 发件人 / Resend Key</summary>
              <div class="mt-2" style="display: grid; gap: 10px">
                ${mailInput('smtp_host', 'SMTP 主机', { placeholder: 'smtp.example.com', value: cfgVal('smtp_host') })}
                ${mailInput('smtp_port', 'SMTP 端口', { placeholder: '465', value: cfgVal('smtp_port'), inputmode: 'numeric' })}
                ${mailSelect('smtp_secure', '加密方式', cfgOptions('smtp_secure'), '（跟随模板）')}
                ${mailInput('reminder_from', '发件人（默认 = 邮箱账号）', { placeholder: '留空即用邮箱账号', value: cfgVal('reminder_from'), inputmode: 'email' })}
                ${mailInput('resend_api_key', 'Resend Key（旧通道）', { type: 'password', placeholder: hasResendKey ? '已保存，留空则不修改' : '仅 Resend 通道需要', autocomplete: 'new-password' })}
              </div>
            </details>
            <div style="display: flex; gap: 8px; flex-wrap: wrap">
              <button class="btn primary sm" type="submit">保存</button>
              <button class="btn sm" type="button" data-act="mail-test">发送测试邮件</button>
            </div>
            <div class="small${mailNote?.bad ? ' danger-text' : ''}" data-act="mail-msg" role="status">${mailNote ? esc(mailNote.text) : ''}</div>
          </form>
        </div>
      </div>`
  }

  const sayMail = (text, bad = false) => {
    mailNote = text ? { text, bad } : null
    const el = main.querySelector('[data-act="mail-msg"]')
    if (!el) return
    el.className = bad ? 'small danger-text' : 'small'
    el.textContent = text
  }

  /** 只提交改动过的字段；授权码 / Key 留空 = 保持原值 */
  const mailChanges = (form) => {
    const data = new FormData(form)
    const changes = []
    for (const key of MAIL_KEYS) {
      const raw = data.get(key)
      if (raw == null) continue
      const value = String(raw).trim()
      if ((key === 'smtp_pass' || key === 'resend_api_key') && !value) continue
      if (value === cfgVal(key)) continue
      changes.push({ key, value })
    }
    // 模板放最前：Worker 套模板时会连带写好主机 / 端口 / 加密方式，后面的显式值再覆盖
    return changes.sort((a, b) => (a.key === 'mail_provider' ? -1 : b.key === 'mail_provider' ? 1 : 0))
  }

  function bindMailCard(wrap) {
    const form = wrap.querySelector('#mail-form')
    if (!form) return
    const submit = form.querySelector('button[type="submit"]')
    const testBtn = form.querySelector('[data-act="mail-test"]')

    form.onsubmit = async (e) => {
      e.preventDefault()
      sayMail('')
      const changes = mailChanges(form)
      if (!changes.length) return sayMail('没有改动')
      submit.disabled = true
      let applied = 0
      try {
        for (const { key, value } of changes) {
          await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ key, value }) })
          applied++
        }
      } catch (err) {
        // 前几项已落库：重拉一次，避免卡片继续显示旧值
        mailNote = { text: err.message, bad: true }
        if (applied) await reloadCfg().catch(() => {})
        else sayMail(err.message, true)
        submit.disabled = false
        return
      }
      mailNote = { text: `已保存（${applied} 项）` } // 重绘会整块替换，先把提示写上
      await reloadCfg().catch((err) => sayMail(err.message, true))
    }

    testBtn.onclick = async () => {
      if (mailChanges(form).length) return sayMail('有未保存的改动，请先点「保存」', true)
      testBtn.disabled = true
      sayMail('正在发送测试邮件…')
      try {
        await api('/api/admin/mail/test', { method: 'POST' })
        sayMail('测试邮件已发送，请检查收件邮箱')
      } catch (err) {
        sayMail(err.message, true)
      } finally {
        testBtn.disabled = false
      }
    }
  }

  function bindCfg(wrap, key) {
    const field = () => cfgState.get(key)
    const q = (act) => wrap.querySelector(`[data-act="${act}"]`)
    const say = (text, bad = false) => {
      const el = q('msg')
      if (!el) return
      el.className = bad ? 'small mt-2 danger-text' : 'small mt-2'
      el.textContent = text
    }
    const repaint = () => {
      wrap.innerHTML = cfgHtml(field())
      bindCfg(wrap, key)
    }

    const eye = q('eye')
    if (eye) {
      eye.onclick = () => {
        if (cfgShown.has(key)) cfgShown.delete(key)
        else cfgShown.add(key)
        repaint()
      }
    }

    q('copy').onclick = async () => {
      const value = field().value
      if (!value) return
      try {
        await navigator.clipboard.writeText(value)
        say('已复制到剪贴板')
      } catch {
        cfgShown.add(key)
        repaint()
        say('浏览器不允许写剪贴板，已展开明文，请手动复制', true)
      }
    }

    const form = q('form')
    const input = form.querySelector('[name="value"]')
    q('edit').onclick = () => {
      const open = form.style.display !== 'flex'
      form.style.display = open ? 'flex' : 'none'
      if (open) {
        input.value = field().value
        input.focus()
      }
    }
    q('cancel').onclick = () => {
      form.style.display = 'none'
      if (input.tagName === 'SELECT') input.value = field().value
      else input.value = ''
    }

    form.onsubmit = async (e) => {
      e.preventDefault()
      const submit = form.querySelector('button[type="submit"]')
      submit.disabled = true
      try {
        cfgState.set(key, await api('/api/admin/config', { method: 'POST', body: JSON.stringify({ key, value: input.value }) }))
        cfgShown.add(key)
        cfgSayNote('')
        repaint()
        say('已保存')
      } catch (err) {
        say(err.message, true)
        submit.disabled = false
      }
    }

    const rotate = q('rotate')
    if (rotate) {
      rotate.onclick = async () => {
        const hint =
          key === 'jwt_secret'
            ? '重新生成 JWT 密钥？所有已登录会话（含当前页面）立即失效，需重新登录。'
            : `随机生成新的「${field().label}」？旧值立即失效。`
        if (!confirm(hint)) return
        rotate.disabled = true
        try {
          cfgState.set(key, await api(`/api/admin/config/${key}/rotate`, { method: 'POST' }))
          cfgShown.add(key)
          repaint()
          say('已生成新值')
          if (key === 'jwt_secret') redirectTimer = setTimeout(() => (location.href = '/login'), 1200)
        } catch (err) {
          say(err.message, true)
          rotate.disabled = false
        }
      }
    }
  }

  const paintCfgList = () => {
    // 邮件相关字段全部收进第一张卡片；其余字段各占一张
    const others = cfgFields.filter((f) => f.group !== MAIL_GROUP)
    cfgList.innerHTML =
      `<div data-cfg="${MAIL_GROUP}">${mailCardHtml()}</div>` +
      others.map((f) => `<div data-cfg="${esc(f.key)}">${cfgHtml(f)}</div>`).join('')
    bindMailCard(cfgList.querySelector(`[data-cfg="${MAIL_GROUP}"]`))
    cfgList.querySelectorAll('[data-cfg]').forEach((wrap) => {
      if (wrap.dataset.cfg !== MAIL_GROUP) bindCfg(wrap, wrap.dataset.cfg)
    })
  }

  /** 保存后重新拉全量参数（套模板会连带改主机 / 端口 / 加密方式） */
  const reloadCfg = async () => {
    const res = await api('/api/admin/config')
    cfgFields = res.fields
    cfgState.clear()
    for (const f of cfgFields) cfgState.set(f.key, f)
    paintCfgList()
  }

  paintCfgList()

  const pwdForm = main.querySelector('#pwd')
  const pwdMsg = main.querySelector('#pwd-msg')
  const pwdSubmit = main.querySelector('#pwd-submit')
  const pwdFields = ['oldPassword', 'newPassword', 'confirm'].map((n) => pwdForm.elements.namedItem(n))
  const pwdFail = (el, text) => {
    pwdMsg.className = 'small mt-2 danger-text'
    pwdMsg.textContent = text
    for (const f of pwdFields) f.removeAttribute('aria-invalid')
    el.setAttribute('aria-invalid', 'true')
    el.focus()
  }
  for (const f of pwdFields) {
    f.addEventListener('input', () => {
      f.removeAttribute('aria-invalid')
      if (pwdMsg.classList.contains('danger-text')) {
        pwdMsg.className = 'small mt-2'
        pwdMsg.textContent = ''
      }
    })
  }

  pwdForm.onsubmit = async (e) => {
    e.preventDefault()
    pwdMsg.className = 'small mt-2'
    pwdMsg.textContent = ''
    const data = new FormData(pwdForm)
    const newPassword = String(data.get('newPassword') || '')
    if (newPassword.length < 8) {
      return pwdFail(pwdForm.elements.namedItem('newPassword'), '新密码至少 8 位')
    }
    if (newPassword !== data.get('confirm')) {
      return pwdFail(pwdForm.elements.namedItem('confirm'), '两次输入的新密码不一致')
    }
    pwdSubmit.disabled = true
    try {
      await api('/api/admin/password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: data.get('oldPassword'), newPassword }),
      })
      pwdMsg.textContent = '密码已更新，请重新登录…'
      setTimeout(() => {
        location.href = '/login'
      }, 700)
    } catch (err) {
      pwdMsg.className = 'small mt-2 danger-text'
      pwdMsg.textContent = err.message
      pwdSubmit.disabled = false
    }
  }

  main.querySelector('#rotate').onclick = async () => {
    if (!confirm('确认撤销所有登录会话？该操作不会修改密码。')) return
    await api('/api/admin/rotate-session', { method: 'POST' })
    location.href = '/login'
  }
}

export function destroy() {
  clearTimeout(redirectTimer)
  redirectTimer = 0
  if (installPollTimer) clearInterval(installPollTimer)
  installPollTimer = 0
  // 弹窗由 router 关闭；这里清掉本视图挂上的复制/关闭委托，避免切页后残留
  const body = document.getElementById('dlg-body')
  if (body) body.onclick = null
}
