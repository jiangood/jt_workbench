import { api, closeModal, esc, fmtTime, icon, showDialog } from '../lib.js'

// 重置 JWT 密钥后跳登录页的定时器：切页要清掉，避免 destroy 之后还跳转
let redirectTimer = 0
// 等待节点首次上线时的轮询定时器（切页 / 关弹窗 / 成功都要停）
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
      添加节点后生成密钥和一条 <code>curl | sh</code> 安装命令（<strong>10 分钟内有效</strong>）：在目标 Linux 机器的任意目录执行，
      会自动创建 <code>workbench-agent/docker-compose.yml</code>（仅此一个文件）并启动。宿主机不需要 <code>.env</code>。
    </div>
    <table style="max-width: 980px">
      <thead><tr><th>节点</th><th>密钥</th><th>版本</th><th>状态</th><th>最后心跳</th><th>在持任务</th><th></th></tr></thead>
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
      邮件服务商内置 QQ / 163 / Gmail 等模板，选中后 SMTP 主机 / 端口 / 加密方式自动填好。
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

  // ---------- 节点登记（后台生成密钥 + 一键安装脚本，v4.12） ----------
  let nodeList = nodes.nodes ?? []
  const shownKeys = new Set()
  const nodeBody = main.querySelector('#nodes-body')
  const nodeMsg = main.querySelector('#node-msg')
  let currentInstall = null

  const nodeSay = (text, bad = false) => {
    nodeMsg.className = bad ? 'small mt-2 danger-text' : 'small mt-2'
    nodeMsg.textContent = text
  }

  const maskKey = (key) => (key ? `${key.slice(0, 6)}${'•'.repeat(8)}${key.slice(-4)}` : '—')

  const paintNodes = () => {
    nodeBody.innerHTML =
      nodeList
        .map((n) => {
          const shown = shownKeys.has(n.node_id)
          return `
          <tr>
            <td class="mono">${esc(n.node_id)}</td>
            <td class="small">
              <code class="mono">${esc(shown ? n.node_key : maskKey(n.node_key))}</code>
              <button class="btn sm" data-act="eye" data-node="${esc(n.node_id)}" type="button">${shown ? '隐藏' : '显示'}</button>
              <button class="btn sm" data-act="copy" data-node="${esc(n.node_id)}" type="button">复制</button>
            </td>
            <td>${esc(n.agent_version || '—')}</td>
            <td>${
              n.online
                ? `<span class="pill ok"><span class="dot"></span>在线</span>`
                : `<span class="pill bad"><span class="dot"></span>离线</span>`
            }</td>
            <td class="small">${fmtTime(n.last_seen_at)}</td>
            <td class="small">${esc(n.heldJobs ?? 0)}</td>
            <td style="white-space: nowrap">
              <button class="btn sm" data-act="install" data-node="${esc(n.node_id)}" type="button">安装命令</button>
              <button class="btn sm warn" data-act="del" data-node="${esc(n.node_id)}" type="button">注销</button>
            </td>
          </tr>`
        })
        .join('') ||
      '<tr><td colspan="7" class="muted">还没有节点——点右上角「添加节点」生成安装命令</td></tr>'
  }
  paintNodes()

  const installStatusHtml = (install) =>
    install.pending
      ? `<span class="pill"><span class="dot"></span>等待节点首次连接…</span>
         <span class="small muted">请保持本页面打开：节点上线后这里会自动提示成功（安装命令 10 分钟内有效）</span>`
      : `<span class="pill ok"><span class="dot"></span>节点已登记</span>
         <span class="small muted">重装 / 换机可直接使用下面的命令</span>`

  const installHtml = (install) => `
    <h2>安装节点『${esc(install.nodeId)}』</h2>
    <div class="small muted">
      在目标 Linux 机器的<strong>任意目录</strong>执行下面命令，脚本会创建
      <code>workbench-agent/docker-compose.yml</code> 并启动容器。
    </div>
    <div class="mt-2" id="install-status" role="status">${installStatusHtml(install)}</div>

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
      compose 里已内联节点密钥，请勿提交仓库或外传。${install.expiresAt ? `安装命令约 ${fmtTime(install.expiresAt)} 过期，过期后用同名重新添加即可。` : ''}
    </div>
    <div class="dlg-foot"><button class="btn sm" data-close type="button">关闭</button></div>`

  const stopInstallPoll = () => {
    if (installPollTimer) clearInterval(installPollTimer)
    installPollTimer = 0
  }

  /** 待认领节点的页面轮询：列表里出现该 nodeId = agent 首次 poll 成功（注册由 Worker 自动完成） */
  const startInstallPoll = (install) => {
    stopInstallPoll()
    if (!install.pending) return
    const dlg = document.getElementById('dlg')
    installPollTimer = setInterval(async () => {
      if (!dlg.open) {
        stopInstallPoll() // 用户按 Esc 关闭原生 dialog
        return
      }
      if (install.expiresAt && Date.now() > install.expiresAt) {
        stopInstallPoll()
        const el = document.getElementById('install-status')
        if (el) {
          el.innerHTML =
            '<span class="pill bad"><span class="dot"></span>安装命令已过期</span> <span class="small muted">点「添加节点」用同名重新生成</span>'
        }
        return
      }
      try {
        const res = await api('/api/admin/nodes')
        if (!res.nodes.some((n) => n.node_id === install.nodeId)) return
        stopInstallPoll()
        nodeList = res.nodes
        paintNodes()
        const el = document.getElementById('install-status')
        if (el) el.innerHTML = '<span class="pill ok"><span class="dot"></span>节点已上线，安装成功</span>'
      } catch {
        // 网络抖动：下一轮继续
      }
    }, 2000)
  }

  const showInstall = (install) => {
    currentInstall = install
    const { body } = showDialog(installHtml(install), { xl: true })
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
    startInstallPoll(install)
  }


  nodeBody.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]')
    if (!btn) return
    const node = nodeList.find((n) => n.node_id === btn.dataset.node)
    if (!node) return

    if (btn.dataset.act === 'eye') {
      if (shownKeys.has(node.node_id)) shownKeys.delete(node.node_id)
      else shownKeys.add(node.node_id)
      paintNodes()
      return
    }

    if (btn.dataset.act === 'copy') {
      try {
        await navigator.clipboard.writeText(node.node_key)
        nodeSay(`已复制 ${node.node_id} 的密钥`)
      } catch {
        shownKeys.add(node.node_id)
        paintNodes()
        nodeSay('浏览器不允许写剪贴板，已展开明文，请手动复制', true)
      }
      return
    }

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

    if (btn.dataset.act === 'del') {
      if (!confirm(`注销节点 ${node.node_id}？密钥与安装链接立即失效，该 agent 会持续 401 直到重新添加。`)) return
      btn.disabled = true
      try {
        const res = await api(`/api/admin/nodes/${encodeURIComponent(node.node_id)}`, { method: 'DELETE' })
        nodeList = res.nodes
        shownKeys.delete(node.node_id)
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
      <p class="small muted">节点名称只用于展示（建议用主机名，如 nas-01）；密钥由后台生成并写进安装脚本。</p>
      <form id="node-add-form">
        <label class="sr-only" for="node-add-name">节点名称</label>
        <input class="field" id="node-add-name" name="name" placeholder="节点名称" maxlength="32" autocomplete="off" required aria-describedby="node-add-msg" />
        <div class="small danger-text mt-2" id="node-add-msg" role="alert"></div>
        <div class="dlg-foot">
          <button class="btn sm" type="button" data-close>取消</button>
          <button class="btn primary sm" type="submit">生成安装命令</button>
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

  const cfgSayNote = (text, bad = false) => {
    cfgNote.className = bad ? 'small mt-2 danger-text' : 'small mt-2'
    cfgNote.textContent = text
  }

  const maskValue = (v) => (v.length > 10 ? `${v.slice(0, 4)}${'•'.repeat(8)}${v.slice(-2)}` : '•'.repeat(8))
  const cfgSource = (f) =>
    f.source === 'd1'
      ? '<span class="pill ok"><span class="dot"></span>D1</span>'
      : '<span class="pill bad"><span class="dot"></span>未配置</span>'
  const cfgMeta = (f) => (f.updatedAt ? `更新于 ${fmtTime(f.updatedAt)}` : '尚未入库')

  const cfgHtml = (f) => {
    const shown = cfgShown.has(f.key)
    const masked = f.kind === 'secret' && !shown
    // 有 options 的字段（邮件服务商 / 加密方式）渲染成下拉框
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
        if (key === 'mail_provider') {
          // 套模板会同时改 smtp_host / smtp_port / smtp_secure：整块重取，避免其它卡片还显示旧值
          await reloadCfg()
          cfgSayNote('已套用内置模板：SMTP 主机 / 端口 / 加密方式已自动填写')
        } else {
          cfgSayNote('')
          repaint()
          say('已保存')
        }
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
    cfgList.innerHTML = cfgFields.map((f) => `<div data-cfg="${f.key}">${cfgHtml(f)}</div>`).join('')
    cfgList.querySelectorAll('[data-cfg]').forEach((wrap) => bindCfg(wrap, wrap.dataset.cfg))
  }

  /** 套用服务商模板后重新拉全量参数（其它字段的值也会变） */
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
