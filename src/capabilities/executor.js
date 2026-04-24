import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { chromium } from 'playwright'
import { nowTimestamp } from '../time.js'
import { searchMemories, insertMemory, normalizeConversationPartyId, createReminder, upsertPrefetchTask, removePrefetchTask, listPrefetchTasks } from '../db.js'
import { emitEvent } from '../events.js'
import { callCapability, listCapabilities } from '../providers/registry.js'
import { isDailyLimitReached } from '../quota.js'
import { setCustomInterval as setTickerInterval, getStatus as getTickerStatus } from '../ticker.js'

// 后台进程注册表：pid → { process, command, startedAt }
const bgProcesses = new Map()

// URL 访问缓存：url → { content, fetchedAt (ms timestamp) }
// 避免同一 URL 在短时间内被反复请求（如天气每天只需查一次）
const urlCache = new Map()
const searchCache = new Map()

const URL_TTL_MS = {
  default: 60 * 60 * 1000,       // 默认：1 小时
  weather: 24 * 60 * 60 * 1000,  // 天气类：24 小时
  news:    30 * 60 * 1000,        // 新闻类：30 分钟
}

function getUrlTtl(url) {
  const u = url.toLowerCase()
  if (u.includes('wttr.in') || u.includes('weather') || u.includes('openweather') || u.includes('tianqi')) {
    return URL_TTL_MS.weather
  }
  if (u.includes('news') || u.includes('rss') || u.includes('feed')) {
    return URL_TTL_MS.news
  }
  return URL_TTL_MS.default
}

import { paths } from '../paths.js'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 文件操作只允许在 sandbox 目录内
const SANDBOX_ROOT = paths.sandboxDir

function createAbortError(reason = 'Aborted') {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason || 'Aborted')
}

function createMergedAbortSignal(signal, timeoutMs) {
  if (!signal && !timeoutMs) return null

  const controller = new AbortController()
  let timeoutId = null

  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason)
  }

  const onAbort = () => abort(signal?.reason || 'Aborted')
  if (signal) {
    if (signal.aborted) abort(signal.reason || 'Aborted')
    else signal.addEventListener('abort', onAbort, { once: true })
  }

  if (timeoutMs) {
    timeoutId = setTimeout(() => abort(`Timeout ${timeoutMs}ms`), timeoutMs)
  }

  return {
    signal: controller.signal,
    cleanup() {
      if (timeoutId) clearTimeout(timeoutId)
      if (signal) signal.removeEventListener('abort', onAbort)
    },
  }
}

function assertInSandbox(resolvedPath) {
  if (!resolvedPath.startsWith(SANDBOX_ROOT)) {
    throw new Error(`访问被拒绝：文件操作只允许在 sandbox 目录内（${SANDBOX_ROOT}）`)
  }
}

// 规范化路径：去掉可能带的 sandbox/ 前缀，统一以 SANDBOX_ROOT 为基准
function normalizeSandboxPath(filePath) {
  return filePath
    .replace(/^sandbox[\\/]/i, '')
    .replace(/^\.[\\/]/, '')
}

// 工具执行器：根据工具名和参数执行对应操作，返回结果字符串
export async function executeTool(name, args, context = {}) {
  try {
    throwIfAborted(context.signal)
    switch (name) {
      case 'express':
        return await execExpress(args, context)
      case 'send_message':
        return await execSendMessage(args, context)
      case 'read_file':
        return await execReadFile(args, context)
      case 'list_dir':
        return await execListDir(args, context)
      case 'write_file':
        return await execWriteFile(args, context)
      case 'delete_file':
        return await execDeleteFile(args, context)
      case 'make_dir':
        return await execMakeDir(args, context)
      case 'exec_command':
        return await execCommand(args, context)
      case 'kill_process':
        return await execKillProcess(args)
      case 'list_processes':
        return await execListProcesses()
      case 'web_search':
        return await execWebSearch(args, context)
      case 'fetch_url':
        return await execFetchUrl(args, context)
      case 'browser_read':
        return await execBrowserRead(args, context)
      case 'search_memory':
        return await execSearchMemory(args)
      case 'speak':
        return await execSpeak(args)
      case 'generate_lyrics':
        return await execGenerateLyrics(args)
      case 'generate_music':
        return await execGenerateMusic(args)
      case 'set_tick_interval':
        return execSetTickInterval(args)
      case 'schedule_reminder':
        return await execScheduleReminder(args, context)
      case 'manage_prefetch_task':
        return execManagePrefetchTask(args)
      default:
        return `错误：未知工具 "${name}"`
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return `执行失败：${err.message}`
  }
}

function resolveAllowedTargetId(targetId, allowedTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedAllowed = [...new Set((allowedTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedAllowed.length) {
    throw new Error('当前提示词未明确注入任何可发送的目标实体，禁止发送消息')
  }

  if (normalizedAllowed.includes(normalizedTarget)) {
    return normalizedTarget
  }

  const compact = value => String(value || '').trim().toLowerCase().replace(/^id:0*/, '')
  const targetCompact = compact(normalizedTarget)
  const fuzzyMatches = normalizedAllowed.filter(id => compact(id) === targetCompact)
  if (fuzzyMatches.length === 1) {
    console.log(`[send_message] ID 严格校验通过（模糊归一）: "${targetId}" → "${fuzzyMatches[0]}"`)
    return fuzzyMatches[0]
  }

  throw new Error(`target_id "${targetId}" 不在当前提示词明确注入的目标实体列表中：${normalizedAllowed.join(', ')}`)
}

function assertVisibleTargetId(targetId, visibleTargetIds = []) {
  const normalizedTarget = normalizeConversationPartyId(targetId)
  const normalizedVisible = [...new Set((visibleTargetIds || []).map(id => normalizeConversationPartyId(id)).filter(Boolean))]
  if (!normalizedVisible.length) {
    throw new Error('当前二层提示词未注入任何对话对象，禁止发送消息')
  }

  if (normalizedVisible.includes(normalizedTarget)) {
    return normalizedTarget
  }

  throw new Error(`target_id "${targetId}" 未出现在当前二层注入的对话记录中：${normalizedVisible.join(', ')}`)
}

function parseReminderDueAt(value) {
  if (!value || typeof value !== 'string') {
    throw new Error('未提供 due_at')
  }
  const dueAt = new Date(value.trim())
  if (Number.isNaN(dueAt.getTime())) {
    throw new Error('due_at 必须是合法的 ISO 8601 绝对时间，例如 2026-04-21T06:00:00+08:00')
  }
  return dueAt
}

function trimAssistantFluff(content) {
  let text = String(content || '').trim()
  if (!text) return text

  const patterns = [
    /[，,、。.!！？~～\s]*(?:从现在起|从今以后|以后)?我就是[\u4e00-\u9fa5A-Za-z0-9 _-]{1,24}[，,、。.!！？~～\s]*为您效劳[！!～~。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[，,、。.!！？~～\s]*(?:随时)?为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*随时为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*为您效劳[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要帮忙的[？?]?[～~！!。.\s]*$/u,
    /[，,、。.!！？~～\s]*有什么需要我帮忙的[？?]?[～~！!。.\s]*$/u,
  ]

  let changed = true
  while (changed) {
    changed = false
    for (const pattern of patterns) {
      const next = text.replace(pattern, '').trim()
      if (next !== text) {
        text = next
        changed = true
      }
    }
  }

  return text
}

// express：表达器入口，根据 format 路由到对应输出渠道
async function execExpress({ target_id, content, format = 'text' }, context = {}) {
  if (!content?.trim()) return '错误：未提供表达内容'
  if (format === 'voice') {
    // 语音表达：先发文字消息再生成语音
    const sendResult = await execSendMessage({ target_id, content }, context)
    if (sendResult.startsWith('错误：') || sendResult.startsWith('执行失败：')) return sendResult
    return await execSpeak({ text: content })
  }
  // 默认：文字表达
  return await execSendMessage({ target_id, content }, context)
}

// send_message：推送到 SSE 流，所有订阅者实时收到
async function execSendMessage({ target_id, content }, context = {}) {
  if (!target_id) return '错误：未提供 target_id'
  if (!content?.trim()) return '错误：未提供消息内容'

  const resolvedId = resolveAllowedTargetId(target_id, context.allowedTargetIds)
  assertVisibleTargetId(resolvedId, context.visibleTargetIds)
  const cleanedContent = trimAssistantFluff(content)
  if (!cleanedContent) return '错误：消息内容为空'

  const timestamp = nowTimestamp()
  console.log(`\n[消息发送] → ${resolvedId}`)
  console.log(`  ${cleanedContent}`)
  console.log(`  时间：${timestamp}`)
  emitEvent('message', { from: 'consciousness', to: resolvedId, content: cleanedContent, timestamp })
  return `消息已发送至 ${resolvedId}`
}

async function execScheduleReminder({ due_at, task, target_id }, context = {}) {
  if (!task?.trim()) return '错误：未提供 task'

  const dueAt = parseReminderDueAt(due_at)
  if (dueAt.getTime() <= Date.now()) {
    throw new Error('提醒时间必须晚于当前时间')
  }

  const fallbackTargetId = context.visibleTargetIds?.[0] || context.allowedTargetIds?.[0] || 'ID:000001'
  const resolvedTargetId = resolveAllowedTargetId(target_id || fallbackTargetId, context.allowedTargetIds)
  const taskText = task.trim()
  const isoDueAt = dueAt.toISOString()
  const systemMessage = `我是系统，根据你设置的提醒，你现在要为用户 ${resolvedTargetId} 执行这件事：${taskText}。请立即处理，并在需要时通过 send_message 把结果发给 ${resolvedTargetId}。`

  const result = createReminder({
    userId: resolvedTargetId,
    dueAt: isoDueAt,
    task: taskText,
    systemMessage,
    source: `tool:schedule_reminder@${nowTimestamp()}`,
  })

  emitEvent('reminder_created', {
    id: Number(result.lastInsertRowid),
    user_id: resolvedTargetId,
    due_at: isoDueAt,
    task: taskText,
  })

  return `提醒已创建：#${result.lastInsertRowid}，将在 ${isoDueAt} 触发，目标用户 ${resolvedTargetId}`
}

// read_file：读取文件内容
async function execReadFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供文件路径'
  const filePath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  const content = fs.readFileSync(resolved, 'utf-8')
  const lines = content.split('\n')
  // 限制单次读取不超过 200 行，避免上下文爆炸
  if (lines.length > 200) {
    return `[文件内容（前200行，共 ${lines.length} 行）]\n` + lines.slice(0, 200).join('\n')
  }
  return content
}

// list_dir：列出目录内容
async function execListDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory || '.'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  const entries = fs.readdirSync(resolved, { withFileTypes: true })
  const result = entries.map(e => {
    const type = e.isDirectory() ? '[目录]' : '[文件]'
    return `${type} ${e.name}`
  }).join('\n')
  return `目录：${resolved}\n\n${result}`
}

const PROTECTED_FILES = new Set(['readme.txt', 'world.txt', 'package.json'])

// write_file：写入文件
async function execWriteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  const content = args.content ?? args.text ?? args.data
  if (!rawPath) return '错误：未提供文件路径'
  if (content === undefined) return '错误：未提供写入内容'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可修改`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  // 确保目录存在
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')
  return `文件已写入：${resolved}`
}

// delete_file：删除沙盒内的文件或目录
async function execDeleteFile(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.filename || args.file_path
  if (!rawPath) return '错误：未提供路径'
  const filePath = normalizeSandboxPath(rawPath)
  if (PROTECTED_FILES.has(path.basename(filePath).toLowerCase())) {
    return `错误：${path.basename(filePath)} 是系统文件，不可删除`
  }
  const resolved = path.resolve(SANDBOX_ROOT, filePath)
  assertInSandbox(resolved)
  if (!fs.existsSync(resolved)) return `错误：路径不存在：${filePath}`
  const stat = fs.statSync(resolved)
  if (stat.isDirectory()) {
    fs.rmSync(resolved, { recursive: true, force: true })
    return `目录已删除：${filePath}`
  } else {
    fs.unlinkSync(resolved)
    return `文件已删除：${filePath}`
  }
}

// make_dir：在沙盒内创建目录（支持多级）
async function execMakeDir(args, context = {}) {
  throwIfAborted(context.signal)
  const rawPath = args.path || args.dir || args.directory
  if (!rawPath) return '错误：未提供目录路径'
  const dirPath = normalizeSandboxPath(rawPath)
  const resolved = path.resolve(SANDBOX_ROOT, dirPath)
  assertInSandbox(resolved)
  fs.mkdirSync(resolved, { recursive: true })
  return `目录已创建：${dirPath}`
}

// exec_command：在沙盒目录内执行 shell 命令
// background=true 时后台运行，返回 PID；否则等待完成，返回输出
async function execCommand(args, context = {}) {
  throwIfAborted(context.signal)
  const command = String(args.command || args.cmd || '').trim()
  if (!command) return toolJson({ ok: false, tool: 'exec_command', error: 'missing command' })

  const background = args.background === true || args.background === 'true'
  // schema 说明单位是秒，转换为毫秒；兼容旧调用（如果传入 >1000 视为已是毫秒）
  const rawTimeout = Number(args.timeout) || 30
  const timeoutMs = Math.max(1000, Math.min(rawTimeout < 1000 ? rawTimeout * 1000 : rawTimeout, 120000))

  console.log(`[exec_command] ${background ? '[后台]' : '[前台]'} ${command}`)
  emitEvent('exec_command', { command, background })

  if (background) {
    return execBackground(command)
  } else {
    return execForeground(command, timeoutMs, context.signal)
  }
}

function toolJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function trimCommandOutput(value = '', max = 6000) {
  const text = String(value || '')
  return text.length > max ? `${text.slice(0, max)}\n\n...` : text
}

function execBackground(command) {
  const child = spawn(command, {
    shell: true,
    cwd: SANDBOX_ROOT,
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = child.pid
  if (!pid) {
    return toolJson({
      ok: false,
      tool: 'exec_command',
      mode: 'background',
      command,
      cwd: SANDBOX_ROOT,
      error: 'process did not start',
    })
  }
  const startedAt = nowTimestamp()
  bgProcesses.set(pid, { process: child, command, startedAt })

  child.on('exit', (code) => {
    console.log(`[exec_command] 后台进程 PID ${pid} 退出，code=${code}`)
    bgProcesses.delete(pid)
    emitEvent('process_exit', { pid, command, code })
  })

  // 收集后台进程的输出，发出 SSE 事件
  child.stdout?.on('data', (data) => {
    const text = data.toString().slice(0, 500)
    emitEvent('process_output', { pid, stream: 'stdout', text })
  })
  child.stderr?.on('data', (data) => {
    const text = data.toString().slice(0, 500)
    emitEvent('process_output', { pid, stream: 'stderr', text })
  })

  return toolJson({
    ok: true,
    tool: 'exec_command',
    mode: 'background',
    command,
    cwd: SANDBOX_ROOT,
    pid,
    started_at: startedAt,
    hint: 'Process is running in the background. Use list_processes to inspect it or kill_process with this pid to stop it.',
  })
}

function execForeground(command, timeoutMs, signal) {
  return new Promise((resolve) => {
    throwIfAborted(signal)
    const child = spawn(command, {
      shell: true,
      cwd: SANDBOX_ROOT,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer = null

    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      merged?.cleanup()
      resolve(value)
    }

    const merged = createMergedAbortSignal(signal)
    const onAbort = () => {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        aborted: true,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: 'command aborted',
      }))
    }
    if (merged?.signal.aborted) {
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        aborted: true,
        stdout: '',
        stderr: '',
        error: 'command aborted before start',
      }))
      return
    }
    merged?.signal.addEventListener('abort', onAbort, { once: true })

    timer = setTimeout(() => {
      timedOut = true
      child.kill()
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        timed_out: true,
        timeout_ms: timeoutMs,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: `command timed out after ${timeoutMs / 1000}s`,
        hint: 'If this is a long-running server, rerun with background=true.',
      }))
    }, timeoutMs)

    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })

    child.on('close', (code) => {
      if (timedOut) return
      finish(toolJson({
        ok: code === 0,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        exit_code: code,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: code === 0 ? null : `command exited with code ${code}`,
        hint: code === 0 ? 'Command completed successfully.' : 'Inspect stderr/stdout before retrying or changing the command.',
      }))
    })

    child.on('error', (err) => {
      if (timedOut) return
      finish(toolJson({
        ok: false,
        tool: 'exec_command',
        mode: 'foreground',
        command,
        cwd: SANDBOX_ROOT,
        stdout: trimCommandOutput(stdout),
        stderr: trimCommandOutput(stderr),
        error: err.message,
      }))
    })
  })
}

// kill_process：停止后台进程（通过 PID）
async function execKillProcess(args) {
  const pid = Number(args.pid)
  if (!pid) return toolJson({ ok: false, tool: 'kill_process', error: 'missing pid' })
  const entry = bgProcesses.get(pid)
  if (!entry) return toolJson({ ok: false, tool: 'kill_process', pid, error: 'process not found or already exited' })
  entry.process.kill()
  bgProcesses.delete(pid)
  return toolJson({
    ok: true,
    tool: 'kill_process',
    pid,
    command: entry.command,
    stopped: true,
  })
}

// list_processes：列出当前后台进程
async function execListProcesses() {
  const processes = [...bgProcesses.entries()].map(([pid, { command, startedAt }]) => ({
    pid,
    command,
    started_at: startedAt,
  }))
  return toolJson({
    ok: true,
    tool: 'list_processes',
    count: processes.length,
    processes,
  })
}

const WEB_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

const BROWSER_VIEWPORT = { width: 1365, height: 900 }

function webJson(payload) {
  return JSON.stringify(payload, null, 2)
}

function normalizeWebUrl(raw) {
  const value = String(raw || '').trim()
  if (!value) return ''
  if (/^https?:\/\//i.test(value)) return value
  return `https://${value}`
}

function decodeHtmlEntities(value = '') {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

function htmlToText(html = '') {
  return decodeHtmlEntities(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractTitle(html = '') {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? htmlToText(match[1]).slice(0, 200) : ''
}

function isLowValuePageText(text = '') {
  const compact = String(text || '').replace(/\s+/g, ' ').trim()
  if (compact.length < 80) return true
  return /^(please wait|just a moment|checking your browser|enable javascript|access denied|forbidden|captcha|安全验证|请稍候|请稍等|正在验证|访问受限)/i.test(compact)
}

async function launchReadableBrowser() {
  const launchOptions = { headless: true }
  try {
    return await chromium.launch(launchOptions)
  } catch (firstError) {
    for (const channel of ['msedge', 'chrome']) {
      try {
        return await chromium.launch({ ...launchOptions, channel })
      } catch {}
    }
    throw firstError
  }
}

async function autoScrollPage(page, signal) {
  for (let i = 0; i < 4; i++) {
    throwIfAborted(signal)
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 800)))
    await page.waitForTimeout(450)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
}

function unwrapDuckDuckGoUrl(url) {
  const decoded = decodeHtmlEntities(url)
  const uddg = decoded.match(/[?&]uddg=([^&]+)/)
  if (uddg) {
    try { return decodeURIComponent(uddg[1]) } catch { return uddg[1] }
  }
  if (decoded.startsWith('//')) return `https:${decoded}`
  return decoded
}

function parseDuckDuckGoResults(html, limit) {
  const results = []
  const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match
  while ((match = resultRegex.exec(html)) !== null && results.length < limit) {
    const url = unwrapDuckDuckGoUrl(match[1])
    const title = htmlToText(match[2])
    if (!url || !title) continue
    const nextStart = resultRegex.lastIndex
    const nextMatch = html.slice(nextStart).match(/<a[^>]+class="result__a"/i)
    const block = nextMatch ? html.slice(nextStart, nextStart + nextMatch.index) : html.slice(nextStart, nextStart + 2000)
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>|class="result__snippet"[^>]*>([\s\S]*?)<\/div>/i)
    const snippet = htmlToText(snippetMatch?.[1] || snippetMatch?.[2] || '').slice(0, 300)
    results.push({ title, url, snippet })
  }
  return results
}

async function execWebSearch(args, context = {}) {
  throwIfAborted(context.signal)
  const query = String(args.query || args.q || args.keyword || '').trim()
  const limit = Math.max(1, Math.min(Number(args.limit) || 5, 8))
  if (!query) return webJson({ ok: false, tool: 'web_search', error: 'missing query' })

  const cacheKey = `${query}::${limit}`
  const cached = searchCache.get(cacheKey)
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
    return webJson({ ...cached.payload, cached: true })
  }

  const searchUrl = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  console.log(`[web_search] ${query}`)
  const merged = createMergedAbortSignal(context.signal, 12000)
  let res
  try {
    res = await fetch(searchUrl, { headers: WEB_HEADERS, signal: merged?.signal })
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    return webJson({ ok: false, tool: 'web_search', query, error: err.message, hint: 'Search request failed. Try a more specific query or fetch a known reliable URL.' })
  }
  merged?.cleanup()

  if (!res.ok) {
    return webJson({ ok: false, tool: 'web_search', query, status: res.status, error: `HTTP ${res.status}`, hint: 'Search engine rejected the request. Try fetch_url with a known URL.' })
  }

  const html = await res.text()
  const results = parseDuckDuckGoResults(html, limit)
  const payload = results.length > 0
    ? { ok: true, tool: 'web_search', query, source: 'duckduckgo_html', results, hint: 'Open 1-3 reliable result URLs with fetch_url, then answer the user.' }
    : { ok: false, tool: 'web_search', query, source: 'duckduckgo_html', results: [], error: 'no results parsed', hint: 'Try a simpler query or a known URL.' }
  if (payload.ok) searchCache.set(cacheKey, { payload, fetchedAt: Date.now() })
  return webJson(payload)
}

// fetch_url: open a known URL, extract readable text, and return structured JSON.
async function execFetchUrl(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'fetch_url', error: 'missing url' })

  const cached = urlCache.get(url)
  const ttl = getUrlTtl(url)
  if (cached && Date.now() - cached.fetchedAt < ttl) {
    const ageMin = Math.round((Date.now() - cached.fetchedAt) / 60000)
    return webJson({ ...cached.payload, cached: true, cache_age_minutes: ageMin })
  }

  console.log(`[fetch_url] -> ${url}`)
  let res
  const merged = createMergedAbortSignal(context.signal, 12000)
  try {
    res = await fetch(url, { headers: WEB_HEADERS, signal: merged?.signal })
  } catch (err) {
    merged?.cleanup()
    if (err.name === 'AbortError') throw err
    console.log(`[fetch_url] failed: ${url} - ${err.message}`)
    return webJson({ ok: false, tool: 'fetch_url', url, error: err.message, hint: 'Network request failed. Use web_search to find an alternate source.' })
  }
  merged?.cleanup()

  if (!res.ok) {
    return webJson({ ok: false, tool: 'fetch_url', url, status: res.status, error: `HTTP ${res.status}`, hint: 'This page could not be read. Use web_search to find another accessible source; do not treat this as page content.' })
  }

  const contentType = res.headers.get('content-type') || ''
  if (contentType && !/text|html|xml|json/i.test(contentType)) {
    return webJson({ ok: false, tool: 'fetch_url', url, status: res.status, content_type: contentType, error: 'unsupported content type', hint: 'Use a text/html source for reading.' })
  }

  const html = await res.text()
  const text = htmlToText(html)
  const title = extractTitle(html)
  if (isLowValuePageText(text)) {
    return webJson({
      ok: false,
      tool: 'fetch_url',
      url,
      status: res.status,
      title,
      error: 'no readable content extracted',
      content_preview: text.slice(0, 300),
      content_length: text.length,
      hint: 'The page opened, but readable article text was not extracted. It may require JavaScript rendering, block crawlers, or be an empty/verification page. Use web_search to find another accessible source.',
    })
  }
  const MAX = 5000
  const content = text.length > MAX ? `${text.slice(0, MAX)}\n\n...` : text
  const payload = {
    ok: true,
    tool: 'fetch_url',
    url,
    status: res.status,
    title,
    content,
    truncated: text.length > MAX,
    content_length: text.length,
    hint: 'Use this page content with other sources if needed, then answer the user.',
  }

  urlCache.set(url, { payload, fetchedAt: Date.now() })
  return webJson(payload)
}

async function execBrowserRead(args, context = {}) {
  throwIfAborted(context.signal)
  const url = normalizeWebUrl(args.url || args.URL || args.link || args.href || args.uri)
  if (!url) return webJson({ ok: false, tool: 'browser_read', error: 'missing url' })

  const timeoutMs = Math.max(5000, Math.min(Number(args.timeout_ms || args.timeout || 20000), 45000))
  const maxChars = Math.max(1000, Math.min(Number(args.max_chars || args.maxChars || 8000), 12000))
  console.log(`[browser_read] -> ${url}`)

  let browser
  let page
  try {
    browser = await launchReadableBrowser()
    const contextOptions = {
      viewport: BROWSER_VIEWPORT,
      locale: 'zh-CN',
      userAgent: WEB_HEADERS['User-Agent'],
    }
    const browserContext = await browser.newContext(contextOptions)
    page = await browserContext.newPage()
    page.setDefaultTimeout(timeoutMs)
    page.setDefaultNavigationTimeout(timeoutMs)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 12000) }).catch(() => {})
    await autoScrollPage(page, context.signal)

    const title = (await page.title()).trim()
    const text = await page.evaluate(() => {
      const selectors = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe']
      selectors.forEach(selector => document.querySelectorAll(selector).forEach(el => el.remove()))
      const candidates = [...document.querySelectorAll('article, main, [role="main"], .article, .post, .content')]
      const best = candidates
        .map(el => ({ el, text: (el.innerText || '').trim() }))
        .sort((a, b) => b.text.length - a.text.length)[0]
      return (best?.text && best.text.length > 200 ? best.text : document.body?.innerText || '').trim()
    })
    const finalUrl = page.url()
    await browser.close()
    browser = null

    if (isLowValuePageText(text)) {
      return webJson({
        ok: false,
        tool: 'browser_read',
        url,
        final_url: finalUrl,
        title,
        error: 'no readable content rendered',
        content_preview: String(text || '').slice(0, 300),
        content_length: String(text || '').length,
        hint: 'The browser opened the page, but did not find readable article text. The page may require login, CAPTCHA, or block automation. Try another source.',
      })
    }

    const content = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n...` : text
    return webJson({
      ok: true,
      tool: 'browser_read',
      url,
      final_url: finalUrl,
      title,
      content,
      truncated: text.length > maxChars,
      content_length: text.length,
      hint: 'Rendered page content extracted by Chromium.',
    })
  } catch (err) {
    if (err.name === 'AbortError') throw err
    return webJson({
      ok: false,
      tool: 'browser_read',
      url,
      error: err.message || String(err),
      hint: 'Browser rendering failed. Try fetch_url or another accessible source.',
    })
  } finally {
    try { await page?.close() } catch {}
    try { await browser?.close() } catch {}
  }
}

// search_memory：主动搜索记忆
async function execSearchMemory({ keyword, limit = 5 }) {
  if (!keyword) return '错误：未提供搜索关键词'
  const rows = searchMemories(keyword, limit)
  if (rows.length === 0) return `未找到包含"${keyword}"的记忆`
  return rows.map(m =>
    `[${m.timestamp.slice(0, 10)}] ${m.event_type}: ${m.content}\n  ${m.detail?.slice(0, 100) ?? ''}`
  ).join('\n\n')
}

// speak：将文字转为语音，保存为音频文件
// 有效的 MiniMax 声音 ID
const VALID_VOICE_IDS = new Set([
  'male-qn-qingse', 'male-qn-jingying', 'male-qn-badao', 'male-qn-daxuesheng',
  'female-shaonv', 'female-yujie', 'female-chengshu', 'female-tianmei',
  'presenter_male', 'presenter_female', 'audiobook_male_1', 'audiobook_female_1',
])
const DEFAULT_VOICE = 'male-qn-qingse'

async function execSpeak(args) {
  const text = args.text || args.content || args.words || args.speech
  const voiceRaw = args.voice_id || args.voice
  const voice_id = VALID_VOICE_IDS.has(voiceRaw) ? voiceRaw : DEFAULT_VOICE
  const { filename } = args
  console.log(`[speak] args:`, JSON.stringify(args))
  if (!text) return '错误：未提供要朗读的文字'
  if (isDailyLimitReached('tts')) return '错误：今日 TTS 配额已用完'
  if (text.length > 1000) return `错误：文字过长（${text.length} 字），请控制在 1000 字以内`

  const result = await callCapability('tts', { text, voice_id })

  // 生成文件名：优先使用传入的，否则自动生成
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = filename ? filename.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '') + '.mp3' : `speech_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'audio', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `audio/${fname}`
  emitEvent('audio_created', { path: relPath, text: text.slice(0, 60) })
  console.log(`[speak] 已生成: ${relPath}`)
  return `语音已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// generate_lyrics：生成歌词
async function execGenerateLyrics({ prompt, mode }) {
  if (!prompt) return '错误：未提供创作方向'
  if (isDailyLimitReached('lyrics')) return '错误：今日歌词生成配额已用完'

  const result = await callCapability('lyrics', { prompt, mode })

  // 自动保存歌词到 sandbox
  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `lyrics_${ts}.txt`
  const content = `# ${result.title}\n风格：${result.style}\n\n${result.lyrics}`
  const resolved = path.resolve(SANDBOX_ROOT, 'lyrics', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, content, 'utf-8')

  emitEvent('lyrics_created', { path: `lyrics/${fname}`, title: result.title })
  return `歌词已生成并保存至 lyrics/${fname}\n\n标题：${result.title}\n风格：${result.style}\n\n${result.lyrics}`
}

// generate_music：生成音乐
async function execGenerateMusic({ prompt, lyrics, instrumental }) {
  if (!prompt) return '错误：未提供音乐描述'
  if (isDailyLimitReached('music')) return '错误：今日音乐生成配额已用完'

  const result = await callCapability('music', { prompt, lyrics, instrumental })

  const ts = nowTimestamp().replace(/[:.+]/g, '-').slice(0, 19)
  const fname = `music_${ts}.mp3`
  const resolved = path.resolve(SANDBOX_ROOT, 'music', fname)
  fs.mkdirSync(path.dirname(resolved), { recursive: true })
  fs.writeFileSync(resolved, result.buffer)

  const relPath = `music/${fname}`
  emitEvent('music_created', { path: relPath, prompt: prompt.slice(0, 60) })
  console.log(`[music] 已生成: ${relPath}`)
  return `音乐已生成：${relPath}（时长约 ${result.duration ?? '?'} 秒）`
}

// manage_prefetch_task：管理预热任务
function execManagePrefetchTask({ action, source, label, url, ttl_minutes, tags }) {
  if (action === 'list') {
    const tasks = listPrefetchTasks()
    if (tasks.length === 0) return '当前没有预热任务。'
    return tasks.map(t =>
      `[${t.enabled ? '✓' : '✗'}] ${t.source}  ${t.label}  TTL=${t.ttl_minutes}min\n  URL: ${t.url}`
    ).join('\n')
  }

  if (action === 'add') {
    if (!source) return '错误：缺少 source'
    if (!label) return '错误：缺少 label'
    if (!url) return '错误：缺少 url'
    upsertPrefetchTask({ source, label, url, ttlMinutes: ttl_minutes ?? 60, tags: tags ?? [] })
    return `预热任务已保存：${source}（${label}），TTL=${ttl_minutes ?? 60}min。下次运行预热时生效。`
  }

  if (action === 'remove') {
    if (!source) return '错误：缺少 source'
    const ok = removePrefetchTask(source)
    return ok ? `预热任务已删除：${source}` : `未找到任务：${source}`
  }

  return `错误：未知 action "${action}"，可选 add / remove / list`
}

// set_tick_interval：L2 调节自身思维节奏
function execSetTickInterval({ seconds, ttl, reason }) {
  const res = setTickerInterval({ seconds, ttl, reason })
  if (!res.ok) return `错误：${res.error}`
  const parts = [`节奏已设为 ${res.seconds}s，持续 ${res.ttl} 轮`]
  if (res.clampedFrom?.seconds !== undefined) parts.push(`（seconds ${res.clampedFrom.seconds} 越界，已 clamp 到 ${res.seconds}）`)
  if (res.clampedFrom?.ttl !== undefined) parts.push(`（ttl ${res.clampedFrom.ttl} 越界，已 clamp 到 ${res.ttl}）`)
  return parts.join('')
}
