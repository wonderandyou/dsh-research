// 资料网插件后端：管理站点清单、同步检查工具调用，并向宿主注册提示词和本机 HTTP 接口。
// 本模块不启动服务器、不访问网络；所有文件操作和注册均在 apply 生命周期内执行。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const DEFAULTS = {
  file: '',
  windowMinutes: 15,
  maxBlocks: 2,
  enabled: true,
}

// 取一个宿主服务：新版 DSH 只允许经 ctx.inject 拿到的 ctx 访问服务（直接读属性会抛
// "cannot get property \"xxx\" without inject"）。两种读法都试，取到哪个用哪个。
function serviceOf(target, name) {
  if (!target) return undefined
  try {
    if (typeof target.get === 'function') {
      const viaGet = target.get(name)
      if (viaGet) return viaGet
    }
  } catch {}
  try {
    return target[name]
  } catch {
    return undefined
  }
}

export function apply(ctx, rawConfig) {
  let logFile = ''

  function log(level, msg) {
    try {
      if (!logFile) return
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      const line = JSON.stringify({ time: Date.now(), level, msg: String(msg) }) + '\n'
      fs.appendFileSync(logFile, line, 'utf8')
      if (fs.statSync(logFile).size > 512 * 1024) {
        const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
        fs.writeFileSync(logFile, lines.slice(-200).join('\n') + '\n', 'utf8')
      }
    } catch {}
  }

  function reason(error) {
    try {
      return String(error?.message ?? error ?? '未知错误').slice(0, 2000)
    } catch {
      return '未知错误'
    }
  }

  try {
    const researchDir = path.join(os.homedir(), '.dsh', 'research')
    logFile = path.join(researchDir, 'log.jsonl')
    const input = { ...DEFAULTS, ...(rawConfig ?? {}) }
    const cfg = {
      file: typeof input.file === 'string' && input.file.trim()
        ? path.resolve(input.file.trim())
        : path.join(researchDir, 'sites.json'),
      windowMinutes: typeof input.windowMinutes === 'number'
        && Number.isFinite(input.windowMinutes) && input.windowMinutes >= 0
        && Number.isFinite(input.windowMinutes * 60000)
        ? input.windowMinutes : DEFAULTS.windowMinutes,
      maxBlocks: Number.isSafeInteger(input.maxBlocks) && input.maxBlocks >= 0
        ? input.maxBlocks : DEFAULTS.maxBlocks,
      enabled: input.enabled !== false,
    }
    const WORK_TOOLS = new Set([
      'bash', 'pwsh', 'write', 'edit', 'str_replace_editor', 'present', 'blender_run', 'blender_save',
    ])
    const NATIVE_CHECK_TOOLS = new Set(['web_search', 'web_fetch'])
    // MCP 检索服务（如 free-search）暴露的工具名形如 mcp__<server>__<verb>，
    // 这些动词都代表“真的去查了资料”，与原生 web_search / web_fetch 同等放行。
    const MCP_CHECK_VERBS = [
      'search', 'research', 'fetch', 'fetch_batch', 'compare',
      'cache_search', 'paper_graph', 'extract_structured', 'read_doc',
    ].map((verb) => verb.replace(/[^a-z0-9]/g, ''))
    function isCheckTool(toolName) {
      if (typeof toolName !== 'string') return false
      if (NATIVE_CHECK_TOOLS.has(toolName)) return true
      const match = /^mcp__[a-z0-9_-]+__(.+)$/i.exec(toolName)
      if (!match) return false
      // fetchBatch / fetch-batch / fetch_batch 视为同一个动作
      return MCP_CHECK_VERBS.includes(match[1].toLowerCase().replace(/[^a-z0-9]/g, ''))
    }
    const PATHS = ['config.json', 'ping.json', 'reset.json'].flatMap((name) => [
      '/api/research/' + name, '/research/' + name,
    ])
    const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
    const BODY_LIMIT = 64 * 1024
    const agents = new Map()
    let lastCheck = 0
    let blocked = 0
    let allowed = 0
    let writeSerial = 0
    let active = true
    let store = { version: 1, updatedAt: 0, sites: defaultSites() }
    let loadError = ''

    function defaultSites() {
      return [
        { id: 'github', name: 'GitHub', domain: 'github.com', on: true },
        { id: 'bilibili', name: '哔哩哔哩', domain: 'bilibili.com', on: true },
        { id: 'tieba', name: '百度贴吧', domain: 'tieba.baidu.com', on: true },
        { id: 'zhihu', name: '知乎', domain: 'zhihu.com', on: true },
        { id: 'csdn', name: 'CSDN', domain: 'csdn.net', on: true },
        { id: 'stackoverflow', name: 'Stack Overflow', domain: 'stackoverflow.com', on: true },
      ]
    }

    function normalizeSites(sites) {
      if (!Array.isArray(sites)) throw new Error('sites 必须是数组')
      if (sites.length > 30) throw new Error('站点最多 30 条')
      const domains = new Set()
      const ids = new Set()
      // 先预留显式 ID，避免自动生成的 ID 占用后续站点的 ID。
      for (const site of sites) {
        if (!site || typeof site !== 'object' || Array.isArray(site)) {
          throw new Error('每条站点必须是对象')
        }
        if (site.id !== undefined) {
          if (typeof site.id !== 'string' || !/^[a-z0-9-]+$/.test(site.id)) {
            throw new Error('id 只能包含小写字母、数字和连字符，且不能为空')
          }
          if (ids.has(site.id)) throw new Error('站点 id 重复：' + site.id)
          ids.add(site.id)
        }
      }
      return sites.map((site, index) => {
        const name = typeof site.name === 'string' ? site.name.trim() : ''
        const domain = typeof site.domain === 'string' ? site.domain.trim().toLowerCase() : ''
        if (!name || Array.from(name).length > 32) {
          throw new Error('第 ' + (index + 1) + ' 条站点名称须为 1–32 个字符')
        }
        if (!domain || domain.length > 64 || !domain.split('.').every((label) =>
          /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
        )) {
          throw new Error('第 ' + (index + 1) + ' 条域名须为有效域名，最多 64 字符，不含协议或路径')
        }
        if (domains.has(domain)) throw new Error('域名重复：' + domain)
        domains.add(domain)
        if (site.on !== undefined && typeof site.on !== 'boolean') {
          throw new Error('站点 on 必须是布尔值')
        }
        let id = site.id
        if (id === undefined) {
          const base = domain.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site'
          id = base
          let suffix = 2
          while (ids.has(id)) id = base + '-' + suffix++
          ids.add(id)
        }
        return { id, name, domain, on: site.on ?? true }
      })
    }

    function saveSites(sites) {
      let temporary = ''
      try {
        const normalized = normalizeSites(sites)
        const next = { version: 1, updatedAt: Date.now(), sites: normalized }
        fs.mkdirSync(path.dirname(cfg.file), { recursive: true })
        temporary = cfg.file + '.' + process.pid + '.' + Date.now() + '.' + (++writeSerial) + '.tmp'
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
        fs.renameSync(temporary, cfg.file)
        temporary = ''
        store = next
        loadError = ''
        log('info', '保存站点：' + store.sites.length + ' 条')
        return { ok: true, sites: store.sites, updatedAt: store.updatedAt }
      } catch (error) {
        const message = reason(error)
        log('warn', '保存站点失败：' + message)
        return { ok: false, reason: message }
      } finally {
        if (temporary) {
          try { fs.unlinkSync(temporary) } catch {}
        }
      }
    }

    function loadSites() {
      try {
        let data
        try {
          data = JSON.parse(fs.readFileSync(cfg.file, 'utf8'))
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          const result = saveSites(defaultSites())
          if (!result.ok) throw new Error(result.reason)
          return
        }
        if (!data || data.version !== 1 || !Number.isSafeInteger(data.updatedAt) || data.updatedAt < 0) {
          throw new Error('站点文件格式错误：需要 version: 1 和有效 updatedAt')
        }
        store = { version: 1, updatedAt: data.updatedAt, sites: normalizeSites(data.sites) }
        loadError = ''
      } catch (error) {
        store = { version: 1, updatedAt: 0, sites: defaultSites() }
        const message = reason(error)
        if (message !== loadError) log('warn', '读取站点失败：' + message)
        loadError = message
      }
    }

    function enabledSites() {
      return store.sites.filter((site) => site.on)
    }

    function siteList(sites) {
      return sites.map((site) => site.domain + '（' + site.name + '）').join('、')
    }

    // 各家检索工具的入参命名不一致：原生 web_search 用 queries[]，MCP 用 query /
    // question / urls[]。这里统一把“可能是查询词或网址的字段”摊平成一个字符串。
    const QUERY_KEYS = ['query', 'q', 'text', 'question', 'keyword', 'keywords']
    const URL_KEYS = ['url', 'urls', 'source', 'href']

    function collectText(target, value) {
      if (typeof value === 'string') {
        if (value) target.push(value)
        return
      }
      if (Array.isArray(value)) {
        for (const item of value) collectText(target, item)
        return
      }
      if (!value || typeof value !== 'object') return
      for (const key of QUERY_KEYS) collectText(target, value[key])
      for (const key of URL_KEYS) collectText(target, value[key])
    }

    function queryText(exec) {
      let args = exec.arguments
      if (typeof args === 'string') args = JSON.parse(args)
      if (!args || typeof args !== 'object') return ''
      const parts = []
      for (const key of QUERY_KEYS) collectText(parts, args[key])
      for (const key of URL_KEYS) collectText(parts, args[key])
      // 原生 web_search 的 queries 既可能是字符串数组，也可能是 { query | q | text }
      collectText(parts, args.queries)
      return parts.join(' ').toLowerCase()
    }

    function guardCall(exec) {
      try {
        if (!active || !cfg.enabled) return undefined
        const toolName = exec?.tool?.name ?? (typeof exec?.tool === 'string' ? exec.tool : undefined)
          ?? exec?.toolName ?? exec?.name
        if (!WORK_TOOLS.has(toolName) && !isCheckTool(toolName)) return undefined
        const rawKey = exec?.agent?.sessionId ?? exec?.agent?.id
        const agentKey = typeof rawKey === 'string' && rawKey ? rawKey : 'default'
        const state = agents.get(agentKey) ?? { checkedAt: 0, blocks: 0, allowed: 0, count: 0 }
        agents.set(agentKey, state)
        const now = Date.now()
        const sites = enabledSites()
        if (isCheckTool(toolName)) {
          const text = queryText(exec)
          if (sites.some((site) => text.includes(site.domain) || text.includes(site.name.toLowerCase()))) {
            state.checkedAt = now
            state.count += 1
            state.blocks = 0
            lastCheck = now
          }
          return undefined
        }
        if (state.checkedAt > 0 && now - state.checkedAt >= 0 && now - state.checkedAt < cfg.windowMinutes * 60000) {
          return undefined
        }
        if (state.blocks >= cfg.maxBlocks) {
          state.allowed += 1
          allowed += 1
          return undefined
        }
        state.blocks += 1
        blocked += 1
        log('info', '拦截工具：' + toolName + '，agent=' + agentKey.slice(0, 128) + '，次数=' + state.blocks)
        if (!sites.length) {
          return '动手前请先查资料：本机资料网插件要求，改文件/跑命令前先用 web_search（或 MCP 检索工具）检索社区方案。\n'
            + '当前没有启用站点，请先在资料网启用至少一个站点，再用 site:站点域名 <你的问题关键词> 检索。'
        }
        return '动手前请先查资料：本机资料网插件要求，改文件/跑命令前先用 web_search（或 MCP 检索工具）检索社区方案。\n'
          + '请用这样的查询词试一次：site:' + sites[0].domain + ' <你的问题关键词>\n'
          + '可用的站点：' + siteList(sites) + '\n查到任意一条即可继续。'
      } catch (error) {
        log('warn', '工具闸门异常，已放行：' + reason(error))
        return undefined
      }
    }

    function buildPromptText() {
      try {
        if (!active || !cfg.enabled) return ''
        const sites = enabledSites()
        return '【资料网】\n'
          + '本机装了「资料网」插件：动手（改文件 / 跑命令 / 写代码）之前，先用 web_search（或 MCP 检索工具）查社区现成方案，\n'
          + '查询词带上站点域名（如 site:' + (sites[0]?.domain ?? '站点域名') + ' xxx），命中任意启用站点即放行。\n'
          + '当前启用站点：' + (siteList(sites) || '无，请先在资料网启用站点') + '\n'
          + '同一回合最多被拦 ' + cfg.maxBlocks + ' 次；被拦时按提示补一次检索即可。'
      } catch (error) {
        log('warn', '生成提示词失败：' + reason(error))
        return ''
      }
    }

    function send(res, status, payload) {
      try {
        if (res.destroyed || res.writableEnded || res.headersSent) return
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(payload))
      } catch (error) {
        log('warn', '发送 HTTP 响应失败：' + reason(error))
      }
    }

    function readBody(req, res) {
      return new Promise((resolve, reject) => {
        let settled = false
        let size = 0
        const chunks = []
        const fail = (error) => {
          if (settled) return
          settled = true
          chunks.length = 0
          reject(error)
        }
        const tooLarge = () => {
          if (settled) return
          settled = true
          chunks.length = 0
          const destroy = () => {
            try { req.destroy() } catch (error) { log('warn', '关闭超限请求失败：' + reason(error)) }
          }
          // 等 413 写完再销毁请求，避免先断开 socket 导致客户端收不到拒绝原因。
          try {
            req.pause()
            res.once('finish', destroy)
            res.once('close', destroy)
            send(res, 413, { ok: false, reason: '请求体超过 64KB' })
            if (res.destroyed) destroy()
          } catch (error) {
            log('warn', '拒绝超限请求失败：' + reason(error))
            destroy()
          }
          resolve(null)
        }
        try {
          req.on('error', fail)
          req.on('aborted', () => fail(new Error('请求已中断')))
          req.on('close', () => {
            if (!settled) fail(new Error('请求在读取完成前关闭'))
          })
          req.on('data', (chunk) => {
            try {
              if (settled) return
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              size += bytes.length
              if (size > BODY_LIMIT) return tooLarge()
              chunks.push(bytes)
            } catch (error) { fail(error) }
          })
          req.on('end', () => {
            try {
              if (settled) return
              const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
              settled = true
              chunks.length = 0
              resolve({ body })
            } catch (error) { fail(error) }
          })
          const length = Number(req.headers?.['content-length'])
          if (Number.isFinite(length) && length > BODY_LIMIT) tooLarge()
        } catch (error) { fail(error) }
      })
    }

    async function handler(req, res) {
      try {
        if (!LOCAL_ADDRESSES.has(req.socket?.remoteAddress)) {
          send(res, 403, { ok: false, reason: '仅允许本机访问' })
          return
        }
        if (!active) {
          send(res, 503, { ok: false, reason: '资料网插件已卸载' })
          return
        }
        const url = new URL(req.url, 'http://127.0.0.1')
        if (!PATHS.includes(url.pathname)) {
          send(res, 404, { ok: false, reason: '接口不存在' })
          return
        }
        if (url.pathname.endsWith('/config.json') && req.method === 'GET') {
          loadSites()
          send(res, 200, {
            ok: !loadError,
            ...(loadError ? { reason: loadError } : {}),
            sites: store.sites,
            enabled: cfg.enabled,
            updatedAt: store.updatedAt,
          })
          return
        }
        if (url.pathname.endsWith('/config.json') && req.method === 'POST') {
          let sites
          try {
            const result = await readBody(req, res)
            if (!result) return
            sites = normalizeSites(result.body?.sites)
          } catch (error) {
            log('warn', '配置请求无效：' + reason(error))
            send(res, 400, { ok: false, reason: reason(error) })
            return
          }
          // 读取 body 期间宿主可能已经卸载插件，不能在卸载后继续落盘。
          if (!active) {
            send(res, 503, { ok: false, reason: '资料网插件已卸载' })
            return
          }
          const result = saveSites(sites)
          send(res, result.ok ? 200 : 500, result)
          return
        }
        if (url.pathname.endsWith('/ping.json') && req.method === 'GET') {
          send(res, 200, {
            ok: true,
            enabled: cfg.enabled,
            total: store.sites.length,
            enabledCount: enabledSites().length,
            lastCheck,
            blocked,
            allowed,
          })
          return
        }
        if (url.pathname.endsWith('/reset.json') && req.method === 'GET') {
          const result = saveSites(defaultSites())
          send(res, result.ok ? 200 : 500, result.ok ? { ok: true, sites: result.sites } : result)
          return
        }
        send(res, 405, { ok: false, reason: '不支持的请求方法' })
      } catch (error) {
        log('warn', 'HTTP 接口异常：' + reason(error))
        send(res, 500, { ok: false, reason: reason(error) })
      }
    }

    function safeDispose(disposer) {
      return () => {
        try {
          if (typeof disposer === 'function') disposer()
        } catch (error) { log('warn', '卸载注册失败：' + reason(error)) }
      }
    }

    function effect(register, label) {
      try {
        ctx.effect(() => {
          try {
            if (!active) return () => {}
            return safeDispose(register())
          } catch (error) {
            log('warn', label + ' 注册失败：' + reason(error))
            return () => {}
          }
        }, label)
      } catch (error) { log('warn', label + ' effect 失败：' + reason(error)) }
    }

    loadSites()
    log('info', '加载站点：' + store.sites.length + ' 条')
    effect(() => () => {
      active = false
      agents.clear()
    }, 'research.state')

    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['tools'], (toolCtx) => {
          try {
            const tools = toolCtx && toolCtx.tools
            if (!active || !tools || typeof tools.guard !== 'function') return
            const owner = toolCtx && typeof toolCtx.effect === 'function' ? toolCtx : ctx
            owner.effect(() => tools.guard((exec) => guardCall(exec)), 'research.guard')
          } catch (error) { log('warn', '注入工具服务失败：' + reason(error)) }
        })
      }
    } catch (error) { log('warn', '注册工具注入失败：' + reason(error)) }

    // systemPrompt 同样是服务：必须经 inject 取得，直接读 ctx.systemPrompt 在新版
    // DSH 会抛 "cannot get property systemPrompt without inject"，导致这段提示永远
    // 注册不上（旧版只会静默降级）。
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['systemPrompt'], (promptCtx) => {
          try {
            const prompt = serviceOf(promptCtx, 'systemPrompt')
            if (!active || !prompt || typeof prompt.section !== 'function') return
            const owner = promptCtx && typeof promptCtx.effect === 'function' ? promptCtx : ctx
            owner.effect(() => prompt.section({
              name: 'research:sites',
              order: 30,
              interpolate: false,
              text: () => buildPromptText(),
            }), 'research.section')
          } catch (error) { log('warn', '注入提示词服务失败：' + reason(error)) }
        })
      }
    } catch (error) { log('warn', '注册提示词注入失败：' + reason(error)) }

    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (webCtx) => {
          try {
            const server = webCtx && webCtx.webServer
            if (!active || !server || typeof server.register !== 'function') return
            const owner = webCtx && typeof webCtx.effect === 'function' ? webCtx : ctx
            owner.effect(() => {
              const disposers = []
              const dispose = () => {
                for (const disposer of disposers.reverse()) safeDispose(disposer)()
                disposers.length = 0
              }
              try {
                for (const route of PATHS) {
                  disposers.push(server.register({ kind: 'exact', path: route, handler }))
                }
                return dispose
              } catch (error) {
                dispose()
                throw error
              }
            }, 'research.routes')
          } catch (error) { log('warn', '注入 HTTP 服务失败：' + reason(error)) }
        })
      }
    } catch (error) { log('warn', '注册 HTTP 注入失败：' + reason(error)) }
  } catch (error) {
    log('warn', '资料网初始化失败：' + reason(error))
  }
}

// 自检：9 组模拟宿主测试通过；导入无文件副作用，仅导出 DEFAULTS / apply。
// 已覆盖：双路径接口、本机限制、站点校验、64KB 字节边界和异常请求流。
// 已覆盖：agent 隔离、查询匹配、15 分钟边界、两次拦截后放行和总开关。
// 已覆盖：原子保存失败保留旧数据、损坏文件回退、恢复默认和日志轮转。
// 已覆盖：延迟注入、部分注册回滚、卸载清理和卸载期间的在途 POST。
// 刻意 fail-open：闸门内部异常放行；日志写入失败静默；注册失败只记日志。
// blocks 按 agentKey 生命周期累计；宿主未提供回合标识，不推测额外的回合重置规则。
// 尚未在真实 DSH 宿主中安装联调。
