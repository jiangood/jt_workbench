import { api, esc, fmtTime, icon } from '../lib.js'

export async function render(main) {
  const [nodes, params] = await Promise.all([api('/api/admin/nodes'), api('/api/admin/params')])

  main.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="page-title">系统管理</h1>
        <p class="page-sub">节点、任务运行与参数诊断（只读）</p>
      </div>
    </div>

    <div class="section-head"><h5>执行节点</h5></div>
    <table style="max-width: 860px">
      <thead><tr><th>节点</th><th>agent 版本</th><th>状态</th><th>最后心跳</th></tr></thead>
      <tbody>
        ${
          nodes.nodes
            .map(
              (n) => `
          <tr>
            <td class="mono">${esc(n.node_id)}</td>
            <td>${esc(n.agent_version)}</td>
            <td>${
              n.online
                ? `<span class="pill ok"><span class="dot"></span>在线</span>`
                : `<span class="pill bad"><span class="dot"></span>离线（30min 无心跳）</span>`
            }</td>
            <td class="small">${fmtTime(n.last_seen_at)}</td>
          </tr>`,
            )
            .join('') || '<tr><td colspan="4" class="muted">无节点记录——检查宿主机 compose 的 NODE_ID/NODE_KEY</td></tr>'
        }
      </tbody>
    </table>

    <div class="section-head"><h5>最近任务运行（7 天）</h5></div>
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

    <div class="section-head"><h5>参数诊断</h5></div>
    <table style="max-width: 860px">
      <thead><tr><th>项</th><th>说明</th><th>状态</th><th>配置位置</th></tr></thead>
      <tbody>
        ${
          params.params
            .map(
              (p) => `
          <tr>
            <td class="mono small">${esc(p.key)}</td>
            <td class="small">${esc(p.label)}</td>
            <td>${
              p.configured
                ? '<span class="pill ok"><span class="dot"></span>已配置</span>'
                : '<span class="pill"><span class="dot"></span>未配置</span>'
            }${p.value ? ` <code class="small">${esc(p.value)}</code>` : ''}</td>
            <td class="small muted">${esc(p.where)}</td>
          </tr>`,
            )
            .join('')
        }
      </tbody>
    </table>

    <div class="section-head"><h5>账号安全</h5></div>
    <div class="card" style="max-width: 640px">
      <div class="card-body">
        <div>登录账号：<code>admin</code>；密码存 D1（<code>auth_state</code>），不再依赖 worker secret</div>
        <form id="pwd" class="mt-2" style="max-width: 420px">
          <input class="field" name="oldPassword" type="password" placeholder="当前密码" autocomplete="current-password" required />
          <input class="field mt-2" name="newPassword" type="password" placeholder="新密码（至少 8 位）" autocomplete="new-password" minlength="8" required />
          <input class="field mt-2" name="confirm" type="password" placeholder="确认新密码" autocomplete="new-password" minlength="8" required />
          <button class="btn primary sm mt-2" id="pwd-submit">${icon('gear')}更新密码</button>
          <div id="pwd-msg" class="small mt-2"></div>
        </form>
        <div class="small muted mt-2">改密后所有已登录会话立即失效（含当前），需用新密码重新登录。</div>
        <button class="btn sm warn mt-2" id="rotate">${icon('gear')}撤销全部旧会话（不改密码）</button>
      </div>
    </div>`

  const pwdForm = main.querySelector('#pwd')
  const pwdMsg = main.querySelector('#pwd-msg')
  const pwdSubmit = main.querySelector('#pwd-submit')

  pwdForm.onsubmit = async (e) => {
    e.preventDefault()
    pwdMsg.className = 'small mt-2'
    pwdMsg.textContent = ''
    const data = new FormData(pwdForm)
    const newPassword = String(data.get('newPassword') || '')
    if (newPassword.length < 8) {
      pwdMsg.className = 'small mt-2 danger-text'
      pwdMsg.textContent = '新密码至少 8 位'
      return
    }
    if (newPassword !== data.get('confirm')) {
      pwdMsg.className = 'small mt-2 danger-text'
      pwdMsg.textContent = '两次输入的新密码不一致'
      return
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

export function destroy() {}
