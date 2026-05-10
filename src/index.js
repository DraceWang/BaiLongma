import { config, getMinimaxKey as _getMinimaxKey } from './config.js'
import { callLLM } from './llm.js'
import { buildSystemPrompt } from './prompt.js'
import { runRecognizer } from './memory/recognizer.js'
import { runInjector, formatMemoriesForPrompt, formatTaskKnowledge, formatPrefetchedItems, formatActiveUICards } from './memory/injector.js'
import { gatherContext, formatExtraContext } from './context/gatherer.js'
import { getDB, getConfig, setConfig, getKnownEntities, getOrInitBirthTime, insertConversation, insertMemory, getRecentConversationPartners, getDueReminders, markReminderFired, advanceReminderDueAt, getNextPendingReminder, getMemoryCount } from './db.js'
import { calculateNextDueAt, autoSpeakForVoiceReply } from './capabilities/executor.js'
import { popMessage, hasMessages, hasUserMessages, getQueueSnapshot, setInterruptCallback, requeueMessage, pushMessage } from './queue.js'
import { startTUI } from './tui.js'
import { startAPI } from './api.js'
import { emitEvent, emitUICommand, addActiveUICard, hasACUIClient } from './events.js'
import { formatTick, nowTimestamp, describeExistence } from './time.js'
import { getAdaptiveTickInterval, getQuotaStatus, setRateLimited, isRateLimited, getTickInterval } from './quota.js'
import { registerProvider } from './providers/registry.js'
import { MinimaxProvider } from './providers/minimax.js'
import { isRunning, setScheduler } from './control.js'
import { getCustomIntervalMs, consumeTick as consumeTickerTick, getStatus as getTickerStatus } from './ticker.js'
import { seedSandboxOnce } from './paths.js'
import { ensureSkillMemories } from './memory/seed-skills.js'
import { dispatchSocialMessage } from './social/dispatch.js'
import { startSocialConnectors } from './social/index.js'
import { buildHotspotRuntimeContext, buildHotspotPanelStateContext } from './hotspots.js'
import { buildPersonCardRuntimeContext, buildPersonCardPanelStateContext } from './person-cards.js'
import { buildWeatherRuntimeContext, getWeatherCardProps } from './weather.js'
import { buildDocRuntimeContext, buildDocPanelStateContext, detectDocTopic, setDocPanelState } from './docs.js'

// 首次启动时把资源目录里的 sandbox 种子文件拷到用户数据目录（Electron 安装场景）
seedSandboxOnce()

// 当前 LLM 处理的 AbortController（主循环打断用）
let currentAbortController = null
let currentExecution = null

const PRIORITY = {
  tick: 10,
  background: 50,
  user: 100,
}

const PRIMARY_USER_ID = 'ID:000001'
const L2_CONTEXT_HOURS = 24 * 7
const STARTUP_SELF_CHECK_VERSION = 'v1'
const STARTUP_SELF_CHECK_CONFIG_KEY = 'l2_startup_self_check'

// 初始化数据库
getDB()
if (getMemoryCount() === 0) {
  console.log('[系统] 记忆库为空，注入默认 seed memories')
  await import('../scripts/seed-memories.js')
}
const birthTime = getOrInitBirthTime()

// 从数据库恢复持久化任务（重启后不丢失）
const persistedTask = getConfig('current_task')
let persistedTaskSteps = []
try {
  const raw = getConfig('current_task_steps')
  if (raw) persistedTaskSteps = JSON.parse(raw)
} catch {}
if (persistedTask) {
  console.log(`[系统] 恢复进行中的任务：${persistedTask.slice(0, 80)}`)
  if (persistedTaskSteps.length) console.log(`[系统] 恢复任务步骤：${persistedTaskSteps.length} 步`)
}

// 注册 Provider（多媒体能力用 MiniMax，独立于 LLM 选择）
// 本文件下方的 `function process(...)` 会遮蔽全局 process，所以用 globalThis.process 访问环境变量。
function registerMinimaxIfAvailable() {
  const envKey = globalThis.process.env.MINIMAX_API_KEY
  const configKey = config.provider === 'minimax' ? config.apiKey : null
  const storedKey = _getMinimaxKey()
  const key = envKey || configKey || storedKey
  if (key) registerProvider(new MinimaxProvider({ apiKey: key }))
}
registerMinimaxIfAvailable()

if (config.needsActivation) {
  console.log('[LLM] 未激活，等待用户在激活页填入 API Key')
} else {
  console.log(`[LLM] 使用 ${config.provider}（模型: ${config.model}）`)
}

// 运行状态
const state = {
  action: null,
  task: persistedTask || null,
  taskSteps: persistedTaskSteps,  // [{ text, status, note }]，status: pending/done/failed/skipped
  taskIdleTickCount: 0,           // 连续空转 tick 计数（task 模式下无工具调用则累加）
  prev_recall: null,
  lastToolResult: null, // 上一轮工具调用结果，下一个 TICK 由注入器注入后清空
  sessionCounter: 0,
  recentActions: [], // 最近几轮的行动摘要，格式：{ ts, summary }
  thoughtStack: [],  // 念头栈，最多保留 3 个，格式：{ concept, line }
  startupSelfCheck: null,
}

const TASK_IDLE_TICK_LIMIT = 5  // 连续 N 次 task tick 无工具调用则自动 clear

function autoCompleteTask(reason) {
  const clearedTask = state.task
  state.task = null
  state.taskSteps = []
  state.taskIdleTickCount = 0
  setConfig('current_task', '')
  setConfig('current_task_steps', '[]')
  console.log(`[任务] 自动清除（${reason}）：${clearedTask}`)
  emitEvent('task_cleared', { task: clearedTask, summary: `自动清除：${reason}` })
  if (clearedTask) {
    insertMemory({
      event_type: 'task_complete',
      content: `任务已自动清除：${clearedTask.slice(0, 60)}`,
      detail: `清除原因：${reason}`,
      entities: [], concepts: [], tags: ['task_complete'],
      timestamp: nowTimestamp(),
    })
  }
}

function newSessionRef() {
  state.sessionCounter++
  return `session_${Date.now()}_${state.sessionCounter}`
}

function readStartupSelfCheckState() {
  try {
    const raw = getConfig(STARTUP_SELF_CHECK_CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function writeStartupSelfCheckState(value) {
  setConfig(STARTUP_SELF_CHECK_CONFIG_KEY, JSON.stringify(value))
}

function ensureStartupSelfCheckState() {
  const current = readStartupSelfCheckState()
  if (current?.version === STARTUP_SELF_CHECK_VERSION && current.status === 'completed') {
    state.startupSelfCheck = { ...current, active: false }
    return state.startupSelfCheck
  }

  const now = nowTimestamp()
  const next = {
    version: STARTUP_SELF_CHECK_VERSION,
    status: 'running',
    started_at: current?.started_at || now,
    updated_at: now,
    attempts: Number(current?.attempts || 0) + (current?.status === 'running' ? 0 : 1),
    results: current?.version === STARTUP_SELF_CHECK_VERSION && current?.results ? current.results : {},
    active: true,
  }
  writeStartupSelfCheckState(next)
  state.startupSelfCheck = next
  return next
}

function buildStartupSelfCheckDirections(checkState) {
  if (!checkState?.active) return ''
  return [
    `当前是 L2 启动自检流程（${STARTUP_SELF_CHECK_VERSION}）。这是一次性流程；完成后必须调用 complete_startup_self_check 记录结果，以后不再重复检查。`,
    `自检目标：探索运行环境和关键能力，但不要骚扰用户。除非发现严重问题，否则不要主动 send_message；过程展示在 L2 面板和工具日志即可。`,
    `必须按顺序执行，并且每个 UI 能力都要先打开/展示，确认工具返回，再关闭，然后才能进行下一项：`,
    `1. 文件环境：list_dir/read_file 是 sandbox 范围内的只读文件工具。用 list_dir 探索 sandbox 根目录及其可见子目录（例如 articles、lyrics、music、downloads、notes 等实际存在的目录），只读探索，不要写文件；如果某个目录不存在，记录 skipped_missing_dir。`,
    `2. 上网能力：用 web_search 做一个低风险连通性查询，记录 ok/error。`,
    `3. 热点面板：hotspot_mode show/open，确认返回后 hotspot_mode hide/close。`,
    `4. 音乐能力：先 music scan 或 music list；如果有曲目，用 media_mode mode=music action=show/play 展示播放器，然后 media_mode mode=music action=hide/close；没有曲目则记录 skipped_no_tracks。不要下载音乐。`,
    `5. 专注横幅：focus_banner show 展示一个短测试任务，确认返回后 focus_banner hide。`,
    `6. UI 卡片：优先用 ui_show_inline 创建一个极简测试卡片，拿到 id 后必须 ui_hide；如果没有 UI 客户端，记录 skipped_no_ui_client。不要注册永久组件。`,
    `结果记录规则：每项结果使用 ok、degraded、error 或 skipped_*。即使某项失败，也继续后续项目；最后调用 complete_startup_self_check，传入 summary 和 results 对象。`,
  ].join('\n')
}

function trimAssistantFluff(content) {
  let text = String(content || '').trim()
  if (!text) return text

  text = text
    .replace(/^(?:\s*\[assistant(?:\s+to\s+[^\]\r\n]+)?(?:\s+\d{4}-\d{2}-\d{2}T[^\]\r\n]+)?\]\s*)+/giu, '')
    .trim()

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

function requiresToolForUserMessage(text = '') {
  const input = String(text || '')
  const fileIntent = /(sandbox|文件|目录|创建|新建|写入|读取|删除|列出|保存|test-\d+|\.txt|\.json|\.md|\.js|\.html|\.css)/i.test(input)
    && /(创建|新建|写入|读取|删除|列出|保存|改|修改|生成|create|write|read|delete|list|save)/i.test(input)
  const commandIntent = /(执行命令|运行命令|跑命令|exec|command|npm|node|git|powershell|cmd)/i.test(input)
  const webIntent = /(打开网页|抓取|联网|搜索|查询最新|fetch|url|https?:\/\/)/i.test(input)
  return fileIntent || commandIntent || webIntent
}

function hasNonMessageToolCall(toolCallLog = []) {
  return toolCallLog.some(t => t.name && t.name !== 'send_message')
}

export function buildToolContext({ currentTargetId = null, conversationWindow = [], includeRecentPartners = false } = {}) {
  const visibleTargetIds = [
    currentTargetId,
    ...conversationWindow.flatMap(item => [item.from_id, item.to_id]),
  ].filter(id => id && id !== 'jarvis')

  // TICK 场景：补充近期熟人和主用户，让意识体可主动联系已建立连接的对象。
  if (includeRecentPartners && !currentTargetId) {
    visibleTargetIds.push(PRIMARY_USER_ID, ...getRecentConversationPartners(L2_CONTEXT_HOURS, 20))
  }

  const unique = [...new Set(visibleTargetIds.filter(Boolean))]
  return { allowedTargetIds: unique, visibleTargetIds: unique }
}

function buildToolContextForProcess(msg, injection) {
  const base = buildToolContext({
    currentTargetId: msg?.reminderTargetId || msg?.fromId || null,
    conversationWindow: injection.conversationWindow || [],
    includeRecentPartners: true,
  })

  return {
    ...base,

    onSetTask: (description, steps) => {
      state.task = description
      state.taskSteps = steps.map(s => ({ text: s, status: 'pending', note: '' }))
      setConfig('current_task', description)
      setConfig('current_task_steps', JSON.stringify(state.taskSteps))
      console.log(`[任务] 已开启：${description}（${steps.length} 步）`)
      emitEvent('task_set', { task: description, steps })
    },

    onCompleteTask: (summary) => {
      const clearedTask = state.task
      state.task = null
      state.taskSteps = []
      state.taskIdleTickCount = 0
      setConfig('current_task', '')
      setConfig('current_task_steps', '[]')
      console.log(`[任务] 已完成：${clearedTask}`)
      emitEvent('task_cleared', { task: clearedTask, summary })
      if (clearedTask) {
        insertMemory({
          event_type: 'task_complete',
          content: `任务已完成：${clearedTask.slice(0, 60)}${summary ? ' — ' + summary.slice(0, 60) : ''}`,
          detail: '任务已通过 complete_task 工具标记为完成',
          entities: [], concepts: [], tags: ['task_complete'],
          timestamp: nowTimestamp(),
        })
      }
    },

    onUpdateTaskStep: (idx, status, note) => {
      if (!state.taskSteps[idx]) return { error: `步骤 ${idx + 1} 不存在（共 ${state.taskSteps.length} 步）` }
      state.taskSteps[idx] = { ...state.taskSteps[idx], status, note }
      setConfig('current_task_steps', JSON.stringify(state.taskSteps))
      const done = state.taskSteps.filter(s => s.status === 'done').length
      emitEvent('task_step_updated', { index: idx, status, note, progress: `${done}/${state.taskSteps.length}` })
      // 方案 C：全部步骤完成时自动清除任务
      const terminal = ['done', 'failed', 'skipped']
      const allTerminal = state.taskSteps.length > 0 && state.taskSteps.every(s => terminal.includes(s.status))
      if (allTerminal) autoCompleteTask('所有步骤已完成')
      return {}
    },

    startupSelfCheck: state.startupSelfCheck,
    onCompleteStartupSelfCheck: ({ summary = '', results = {} } = {}) => {
      const now = nowTimestamp()
      const completed = {
        version: STARTUP_SELF_CHECK_VERSION,
        status: 'completed',
        started_at: state.startupSelfCheck?.started_at || now,
        completed_at: now,
        updated_at: now,
        results,
        summary,
      }
      writeStartupSelfCheckState(completed)
      state.startupSelfCheck = { ...completed, active: false }
      insertMemory({
        mem_id: `system_l2_startup_self_check_${STARTUP_SELF_CHECK_VERSION}`,
        type: 'system',
        title: `L2 startup self-check ${STARTUP_SELF_CHECK_VERSION}`,
        content: `L2 启动自检已完成：${summary || '无摘要'}`,
        detail: JSON.stringify({ summary, results }, null, 2),
        tags: ['system', 'l2', 'startup_self_check', STARTUP_SELF_CHECK_VERSION],
        entities: [],
        timestamp: now,
      })
      emitEvent('startup_self_check_completed', completed)
      return completed
    },

    onRecall: (query) => {
      state.prev_recall = query
    },
  }
}

function formatConversationMessage(row, currentMsg = null) {
  if (row.role === 'jarvis') {
    return {
      role: 'assistant',
      content: trimAssistantFluff(row.content || ''),
    }
  }

  // 时间戳只保留到分钟（去掉秒和时区）
  const ts = row.timestamp ? row.timestamp.slice(0, 16).replace('T', ' ') : ''
  const channel = row.channel || currentMsg?.channel || ''

  const isSystemSignal = row.from_id === 'SYSTEM' || channel === 'APP_SIGNAL' || channel === 'REMINDER'

  if (isSystemSignal) {
    const channelLabel = channel ? ` · ${channel}` : ''
    return {
      role: 'user',
      content: `[system signal · ${ts}${channelLabel}]\n${row.content || ''}\n(Respond with tools only. Do NOT call send_message.)`.trim(),
    }
  }

  const isCurrent = currentMsg
    && row.role === 'user'
    && row.from_id === currentMsg.fromId
    && row.timestamp === currentMsg.timestamp
    && row.content === currentMsg.content
  const marker = isCurrent ? 'current user message' : 'user message'
  // TUI/API 是默认渠道，不显示；只显示有意义的渠道
  const channelLabel = (channel && channel !== 'TUI' && channel !== 'API') ? ` · ${channel}` : ''

  return {
    role: 'user',
    content: `[${marker} · ${row.from_id || 'unknown'} · ${ts}${channelLabel}]\n${row.content || ''}`.trim(),
  }
}

function formatTaskSteps(taskSteps = []) {
  if (!taskSteps?.length) return ''
  const statusIcon = { done: '✓', failed: '✗', skipped: '—', pending: '○' }
  const lines = taskSteps.map((s, i) => {
    const icon = statusIcon[s.status] || '○'
    const note = s.note ? ` (${s.note})` : ''
    return `  ${i + 1}. [${icon}] ${s.text}${note}`
  })
  const done = taskSteps.filter(s => s.status === 'done').length
  const total = taskSteps.length
  return `任务步骤进度（${done}/${total}）：\n${lines.join('\n')}`
}

function buildRuntimeContextMessages({ recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [] } = {}) {
  const parts = []

  if (taskSteps?.length > 0) {
    parts.push(formatTaskSteps(taskSteps))
  }

  if (recentActions?.length > 0) {
    const lines = recentActions.map(item => `- ${item.ts?.slice(11, 16) || ''} ${item.summary || ''}`).join('\n')
    parts.push(`Recent assistant actions:\n${lines}\nAvoid immediately repeating the same action unless the current user message asks for it.`)
  }

  if (actionLog?.length > 0) {
    const lines = actionLog.slice(-10).map(item => {
      const time = item.timestamp?.slice(11, 16) || ''
      const detail = item.detail ? `\n  ${item.detail}` : ''
      return `- ${time} ${item.tool || ''} · ${item.summary || ''}${detail}`
    }).join('\n')
    parts.push(`Recent tool/action log:\n${lines}\nUse this as runtime context only. Do not repeat completed actions unless the current task requires it.`)
  }

  if (lastToolResult) {
    const argsSummary = Object.entries(lastToolResult.args || {})
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(', ')
    const resultPreview = String(lastToolResult.result || '').slice(0, 500)
    parts.push(`Previous tool result:\n${lastToolResult.name}(${argsSummary}) ->\n${resultPreview}\nAbsorb this result before deciding the next step.`)
  }

  if (parts.length === 0) return []
  return [{
    role: 'user',
    content: `[runtime context]\n${parts.join('\n\n')}`,
  }]
}

function buildLLMMessages({ systemPrompt, conversationWindow = [], input, msg = null, recentActions = [], actionLog = [], lastToolResult = null, taskSteps = [] }) {
  const messages = [{ role: 'system', content: systemPrompt }]
  messages.push(...buildRuntimeContextMessages({ recentActions, actionLog, lastToolResult, taskSteps }))

  const rows = Array.isArray(conversationWindow) ? conversationWindow : []
  for (const row of rows) {
    if (!row?.content) continue
    const formatted = formatConversationMessage(row, msg)
    if (formatted.content) messages.push(formatted)
  }

  const hasCurrentMessage = !!msg && rows.some(row =>
    row.role === 'user'
    && row.from_id === msg.fromId
    && row.timestamp === msg.timestamp
    && row.content === msg.content
  )

  if (!hasCurrentMessage) {
    messages.push({
      role: 'user',
      content: input,
    })
  }

  return messages
}

const MAX_MESSAGE_RETRIES = 3

function createAbortError(reason = 'Aborted') {
  const err = new Error(reason)
  err.name = 'AbortError'
  return err
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError(signal.reason || 'Aborted')
}

function getProcessPriority(msg) {
  if (!msg) return PRIORITY.tick
  return typeof msg.priority === 'number' ? msg.priority : PRIORITY.background
}

function isVoiceChannel(channel) {
  return channel === '语音识别' || channel === 'FocusBanner'
}

function isFastUserMessage(msg) {
  return !!msg && getProcessPriority(msg) >= PRIORITY.user
}

function shouldPreemptFor(entry) {
  if (!entry || !processing || !currentExecution) return true
  const incomingPriority = entry.priority || PRIORITY.background
  if (incomingPriority > currentExecution.priority) return true

  // 用户实时消息之间也允许相互抢占。
  // 这样当前如果正卡在工具调用里，新的用户消息仍然可以立刻打断并优先处理。
  if (incomingPriority >= PRIORITY.user && currentExecution.priority >= PRIORITY.user) return true

  return false
}

function beginExecution({ priority, kind, label, controller }) {
  currentAbortController = controller
  currentExecution = {
    priority,
    kind,
    label,
    startedAt: Date.now(),
  }
}

function clearExecution(controller) {
  if (currentAbortController === controller) currentAbortController = null
  if (currentExecution && currentAbortController === null) currentExecution = null
}

function enqueueDueReminders() {
  const now = new Date().toISOString()
  const dueReminders = getDueReminders(now, 20)
  for (const reminder of dueReminders) {
    if (reminder.recurrence_type) {
      let nextDueIso
      try {
        const config = JSON.parse(reminder.recurrence_config || '{}')
        nextDueIso = calculateNextDueAt(reminder.recurrence_type, config, new Date()).toISOString()
      } catch (err) {
        console.error(`[提醒 #${reminder.id}] 周期下一次时间计算失败：${err.message}，回退为单次触发`)
        const marked = markReminderFired(reminder.id, now)
        if (!marked.changes) continue
      }
      if (nextDueIso) {
        const advanced = advanceReminderDueAt(reminder.id, nextDueIso)
        if (!advanced.changes) continue
      }
    } else {
      const marked = markReminderFired(reminder.id, now)
      if (!marked.changes) continue
    }
    pushMessage('SYSTEM', reminder.system_message, 'REMINDER', {
      reminderTargetId: reminder.user_id,
      reminderId: reminder.id,
    })
    emitEvent('reminder_fired', {
      id: reminder.id,
      user_id: reminder.user_id,
      due_at: reminder.due_at,
      task: reminder.task,
      recurrence_type: reminder.recurrence_type,
    })
  }
}

// LLM 失败后的通用处理：429 设限流，消息重入队列，超限放弃
function handleLLMFailure(err, label, msg) {
  console.error('LLM 调用失败:', err.message)
  if (err.message?.includes('429') || err.status === 429) setRateLimited()
  emitEvent('error', { label, error: err.message })
  if (msg) {
    const nextRetry = (msg.retryCount || 0) + 1
    if (nextRetry <= MAX_MESSAGE_RETRIES) {
      console.log(`[系统] 消息重入队列（第 ${nextRetry}/${MAX_MESSAGE_RETRIES} 次重试）`)
      emitEvent('message_requeued', { fromId: msg.fromId, retryCount: nextRetry, error: err.message })
      requeueMessage(msg, nextRetry)
    } else {
      console.error(`[系统] 消息重试 ${MAX_MESSAGE_RETRIES} 次仍失败，放弃：${msg.content?.slice(0, 60)}`)
      emitEvent('message_dropped', { fromId: msg.fromId, retryCount: nextRetry - 1, reason: err.message })
    }
  }
}

async function process(input, label, msg = null) {
  const sessionRef = newSessionRef()
  const isTick = !msg
  const priority = getProcessPriority(msg)
  const fastUserPath = isFastUserMessage(msg)
  const controller = new AbortController()
  let llmResult = null
  let toolCallLog = []

  console.log(`\n── ${label} ──`)
  emitEvent(isTick ? 'tick' : 'message_received', { label, input: input.slice(0, 300) })

  // 用户消息已在 pushMessage 阶段写入 conversations（到达即入聊天记录），此处不再重复写。
  try {
    beginExecution({
      priority,
      kind: isTick ? 'tick' : (fastUserPath ? 'user' : 'background'),
      label,
      controller,
    })

    if (isTick) ensureStartupSelfCheckState()

    // 1. 注入器
    const injection = await runInjector({ message: input, state })
    throwIfAborted(controller.signal)

    const directions = [...(injection.directions || [])]
    if (isTick) {
      directions.unshift(
        `当前是 L2 自主心跳轮次，没有新的用户消息。你拥有完整工具权限，可以主动行动——不需要等用户发起。\n` +
        `你可以主动做的事（示例，不限于此）：\n` +
        `- 根据时间段（早晨/晚上/深夜）主动问候或关心用户\n` +
        `- 查看 sandbox 文件夹，检查进行中的项目或文件变化，必要时汇报\n` +
        `- 搜索记忆库，找出有未完成承诺、待跟进事项或到期提醒，主动推进\n` +
        `- 发现近期对话里有值得延伸的话题，主动分享一个想法或信息\n` +
        `- 网络搜索用户感兴趣的内容，把有价值的发现推送给用户\n` +
        `- 检查任务进度或 prefetch 数据（天气/新闻），有变化时主动告知\n` +
        `行动准则：\n` +
        `- 主动但不骚扰：不重复说刚说过的话，不在深夜无故打扰（23:00–06:00 只在有明确价值时才发消息）\n` +
        `- 有实质内容：发消息前确保有真正值得说的东西，不要只是"打个招呼"\n` +
        `- 不需要全部都做：每轮选一件最有价值的事做，做完即可，不要在单轮里堆砌多个行动\n` +
        `- 如果确实没有值得做的事，可以静默，不调用任何工具`
      )
      const startupSelfCheckDirections = buildStartupSelfCheckDirections(state.startupSelfCheck)
      if (startupSelfCheckDirections) directions.unshift(startupSelfCheckDirections)
    }
    if (fastUserPath) {
      directions.unshift('Current turn is a real-time external user message. Understand it quickly and reply directly with send_message before doing slow tools or deep context gathering. Use heavier tools only when the reply depends on them. During execution, whenever there is meaningful progress or a useful finding, send_message to keep the user in the loop. Do not ask for permission for actions you can safely perform; act, and speak when there is something worth saying.')
    }
    if (isVoiceChannel(msg?.channel)) {
      directions.push('The current user message came from voice input. Speak naturally and concisely — like talking to a person, not writing an article. Get to the point, avoid filler phrases, and do not use Markdown formatting (no bullet points, asterisks, or headers). Say what needs to be said and stop.')
    }

    const memoriesText = formatMemoriesForPrompt(injection.memories, injection.recallMemories)
    const directionsText = directions.join('\n')
    const taskKnowledgeText = formatTaskKnowledge(injection.taskKnowledge)

    // 用户实时消息走快速路径：跳过重型上下文采集，避免被任务背景拖慢。
    const prefetchText = formatPrefetchedItems(injection.prefetchedItems)
    const hotspotStateText = buildHotspotPanelStateContext()
    const hotspotContextText = buildHotspotRuntimeContext(msg?.content || input)
    const personCardStateText = buildPersonCardPanelStateContext()
    const personCardContextText = buildPersonCardRuntimeContext(msg?.content || input)
    const weatherContextText = await buildWeatherRuntimeContext(msg?.content || input)
    // 关键词检测只作为软提示注入上下文，由 Agent 自己判断是否需要打开文档面板
    const detectedDocTopic = detectDocTopic(msg?.content || input)
    const docStateText = buildDocPanelStateContext(detectedDocTopic)
    const docContextText = buildDocRuntimeContext(msg?.content || input)

    // 天气关键词触发时，延迟 1 秒自动弹出 WeatherCard
    if (weatherContextText && hasACUIClient()) {
      setTimeout(() => {
        getWeatherCardProps(msg?.content || input).then(cardProps => {
          if (!cardProps) return
          const id = `weathercard-${Date.now()}`
          emitUICommand({ op: 'mount', id, component: 'WeatherCard', props: cardProps, hint: { placement: 'notification', enter: 'flash-in', exit: 'flash-out' } })
          addActiveUICard(id, { component: 'WeatherCard' })
        }).catch(() => {})
      }, 1000)
    }

    let extraContextText = ''
    if (state.task && !fastUserPath) {
      const extraContext = await gatherContext({
        task: state.task,
        taskKnowledge: taskKnowledgeText,
        memories: memoriesText,
        message: input,
        signal: controller.signal,
      })
      throwIfAborted(controller.signal)
      extraContextText = formatExtraContext(extraContext)
      if (extraContext.length > 0) {
        console.log(`[采集器] 补充了 ${extraContext.length} 项上下文`)
        emitEvent('context_gathered', { count: extraContext.length, items: extraContext.map(c => c.label) })
      }
    }

    // 发出注入器结果事件（供 brain.html 展示）
    emitEvent('injector_result', {
      directions,
      tools: injection.tools || [],
      matchedMemories: (injection.memories || []).map(m => ({
        id: m.id,
        mem_id: m.mem_id || '',
        event_type: m.event_type || '',
        content: m.content || '',
        detail: m.detail || '',
      })),
      recallMemories: (injection.recallMemories || []).map(m => ({
        id: m.id,
        mem_id: m.mem_id || '',
        event_type: m.event_type || '',
        content: m.content || '',
        detail: m.detail || '',
      })),
      constraints: (injection.constraints || []).map(m => m.content),
      thought: injection.thought || null,
      lastToolResult: injection.lastToolResult
        ? `${injection.lastToolResult.name}: ${String(injection.lastToolResult.result).slice(0, 120)}`
        : null,
      conversationWindow: (injection.conversationWindow || []).map(m => ({
        role: m.role,
        from_id: m.from_id,
        to_id: m.to_id,
        content: (m.content || '').slice(0, 120),
        timestamp: m.timestamp,
      })),
      personMemory: injection.personMemory
        ? { content: injection.personMemory.content, detail: injection.personMemory.detail || '' }
        : null,
      fastUserPath,
    })

    // 更新念头栈
    if (injection.thought) {
      state.thoughtStack.push(injection.thought)
      if (state.thoughtStack.length > 3) state.thoughtStack.shift()
    }

    // 2. 组装系统提示词
    const persona = getConfig('persona') || ''
    const agentName = getConfig('agent_name') || 'Longma'
    const entities = getKnownEntities()
    const hasActiveTask = !!state.task
    const systemPrompt = buildSystemPrompt({
      agentName,
      persona,
      memories: memoriesText,
      directions: directionsText,
      constraints: injection.constraints || [],
      personMemory: injection.personMemory || null,
      thoughtStack: state.thoughtStack,
      entities,
      hasActiveTask,
      task: state.task || null,
      taskKnowledge: taskKnowledgeText,
      extraContext: [hotspotStateText, hotspotContextText, personCardStateText, personCardContextText, weatherContextText, docStateText, docContextText, prefetchText, extraContextText, injection.uiSignalSummary, formatActiveUICards(injection.activeUICards)].filter(Boolean).join('\n\n'),
      existenceDesc: describeExistence(birthTime),
    })

    const llmMessages = buildLLMMessages({
      systemPrompt,
      conversationWindow: injection.conversationWindow || [],
      input,
      msg,
      recentActions: state.recentActions,
      actionLog: injection.actionLog || [],
      lastToolResult: injection.lastToolResult || null,
      taskSteps: state.taskSteps,
    })

    // 发出完整系统提示词事件
    emitEvent('system_prompt', { content: systemPrompt, fastUserPath })

    // 3. 调用 Jarvis LLM（可被新消息打断）
    const toolContext = buildToolContextForProcess(msg, injection)
    llmResult = await callLLM({
      systemPrompt,
      message: input,
      messages: llmMessages,
      tools: injection.tools || ['send_message'],
      maxTokens: undefined,
      temperature: config.temperature,
      signal: controller.signal,
      toolContext,
      mustReply: !!msg?.fromId,
      onToolCall: (name, args, result) => {
        const resultText = String(result)
        let ok = true
        try {
          const parsed = JSON.parse(resultText)
          if (parsed && parsed.ok === false) ok = false
        } catch {
          ok = !/^(错误|请求失败|执行失败|命令超时|命令执行失败)/.test(resultText.trim())
        }
        emitEvent('tool_call', { name, args, result: resultText.slice(0, 1000), ok })
        toolCallLog.push({ name, args, result: resultText.slice(0, 500), ok })
        // 记录 Jarvis 发出的消息
        if (name === 'send_message' && args?.target_id && args?.content) {
          const cleanedContent = trimAssistantFluff(args.content)
          if (!cleanedContent) return
          insertConversation({
            role: 'jarvis',
            from_id: 'jarvis',
            to_id: args.target_id,
            content: cleanedContent,
            timestamp: nowTimestamp(),
          })
          // 用户用语音输入时，通知前端播放 TTS 语音回复
          if (isVoiceChannel(msg?.channel)) {
            autoSpeakForVoiceReply(cleanedContent)
          }
        }
      },
      onRetry: ({ attempt, nextAttempt, maxAttempts, delayMs, error }) => {
        emitEvent('llm_retry', { attempt, nextAttempt, maxAttempts, delayMs, error })
      },
      onStream: ({ event, mode, text }) => {
        if (event === 'start') emitEvent('stream_start', { mode })
        else if (event === 'chunk') emitEvent('stream_chunk', { text })
        else if (event === 'end') emitEvent('stream_end', {})
      },
    })
    throwIfAborted(controller.signal)
  } catch (err) {
    if (err.name === 'AbortError') {
      console.log('[系统] LLM 处理被打断（新消息到达）')
      llmResult = { content: '', toolResult: null, aborted: true }
    } else {
      handleLLMFailure(err, label, msg)
      return
    }
  } finally {
    clearExecution(controller)
  }

  if (llmResult.aborted) {
    // 微信式打断：丢弃半成品，下轮处理最新消息时从 conversationWindow 自然读到本条上下文。
    console.log('[系统] 当前处理被新消息打断，丢弃半成品')
    return
  }

  const response = llmResult.content

  // 存储工具结果供下一个 TICK 注入
  state.lastToolResult = llmResult.toolResult || null

  console.log('\nJarvis:', response)
  emitEvent('response', { sessionRef, label, content: response })

  // 用户消息不能静默失败：如果模型生成了正文但忘记调用 send_message，
  // 由运行时兜底投递给当前用户；TICK/主动消息仍必须走显式工具调用。
  if (msg && msg.fromId && !toolCallLog.some(t => t.name === 'send_message')) {
    const fallbackContent = trimAssistantFluff(
      response
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/\[RECALL:\s*.+?\]/g, '')
        .replace(/\[SET_TASK:\s*[\s\S]+?\]/g, '')
        .replace(/\[CLEAR_TASK\]/g, '')
        .replace(/\[UPDATE_PERSONA:\s*[\s\S]+?\]/g, '')
        .trim()
    )

    if (fallbackContent && requiresToolForUserMessage(input) && !hasNonMessageToolCall(toolCallLog)) {
      const timestamp = nowTimestamp()
      const blockedContent = '我刚才没有真正调用工具完成这个操作，所以不能声称已经完成。请重新发送一次，我会先执行对应工具，再基于工具结果回复。'
      console.warn(`[协议兜底] 阻止了一次需要工具但未调用工具的文本回复。from=${msg.fromId}`)
      if (isVoiceChannel(msg.channel)) autoSpeakForVoiceReply(blockedContent)
      emitEvent('message', {
        from: 'consciousness',
        to: msg.fromId,
        content: blockedContent,
        timestamp,
      })
      dispatchSocialMessage(msg.fromId, blockedContent).catch(err => console.warn('[social] fallback send failed:', err.message))
      insertConversation({
        role: 'jarvis',
        from_id: 'jarvis',
        to_id: msg.fromId,
        content: blockedContent,
        timestamp,
      })
      toolCallLog.push({
        name: 'send_message',
        args: { target_id: msg.fromId, content: blockedContent },
        result: 'fallback blocked missing required tool call',
      })
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_required_tool_call',
        fromId: msg.fromId,
        content: fallbackContent.slice(0, 500),
      })
    } else if (fallbackContent) {
      const timestamp = nowTimestamp()
      console.warn(`[协议兜底] 模型未调用 send_message，已将正文发给 ${msg.fromId}`)
      if (isVoiceChannel(msg.channel)) autoSpeakForVoiceReply(fallbackContent)
      emitEvent('message', {
        from: 'consciousness',
        to: msg.fromId,
        content: fallbackContent,
        timestamp,
      })
      dispatchSocialMessage(msg.fromId, fallbackContent).catch(err => console.warn('[social] fallback send failed:', err.message))
      insertConversation({
        role: 'jarvis',
        from_id: 'jarvis',
        to_id: msg.fromId,
        content: fallbackContent,
        timestamp,
      })
      toolCallLog.push({
        name: 'send_message',
        args: { target_id: msg.fromId, content: fallbackContent },
        result: 'fallback delivered from plain response',
      })
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_send_message_fallback_delivered',
        fromId: msg.fromId,
        content: fallbackContent.slice(0, 500),
      })
    } else {
      console.warn(`[协议违规] 模型未调用 send_message，且没有可兜底发送的正文。from=${msg.fromId}`)
      emitEvent('protocol_violation', {
        label,
        reason: 'missing_send_message',
        fromId: msg.fromId,
        content: response.slice(0, 500),
      })
    }
  }

  // 4. 检测 [RECALL: ...]
  const recallMatch = response.match(/\[RECALL:\s*(.+?)\]/)
  if (recallMatch) {
    state.prev_recall = recallMatch[1]
    console.log(`[系统] 回忆请求：${state.prev_recall}`)
    emitEvent('recall_requested', { query: state.prev_recall })
  } else {
    state.prev_recall = null
  }

  // 5. 检测 [UPDATE_PERSONA: ...]
  const personaMatch = response.match(/\[UPDATE_PERSONA:\s*([\s\S]+?)\]/)
  if (personaMatch) {
    const newPersona = personaMatch[1].trim()
    setConfig('persona', newPersona)
    console.log(`[系统] 人格已更新`)
    emitEvent('persona_updated', { persona: newPersona.slice(0, 200) })
  }

  // 6. 检测 [SET_TASK: ...] / [CLEAR_TASK]
  const setTaskMatch = response.match(/\[SET_TASK:\s*([\s\S]+?)\]/)
  if (setTaskMatch) {
    state.task = setTaskMatch[1].trim()
    setConfig('current_task', state.task)
    console.log(`[系统] 任务设置：${state.task}`)
    emitEvent('task_set', { task: state.task })
  }
  if (/\[CLEAR_TASK\]/.test(response)) {
    const clearedTask = state.task
    console.log(`[系统] 任务完成：${clearedTask}`)
    emitEvent('task_cleared', { task: clearedTask })
    state.task = null
    state.taskIdleTickCount = 0
    setConfig('current_task', '')
    // 写入 task_complete 记忆，防止后续注入时旧任务记忆让 Jarvis 误以为任务仍在进行
    if (clearedTask) {
      insertMemory({
        event_type: 'task_complete',
        content: `任务已完成：${clearedTask.slice(0, 60)}`,
        detail: '任务已通过 [CLEAR_TASK] 标记为完成，不再继续执行',
        entities: [], concepts: [], tags: ['task_complete'],
        timestamp: nowTimestamp(),
      })
    }
  }

  // 更新最近行动记录（保留最近 5 条）
  if (toolCallLog.length > 0) {
    const summary = toolCallLog.map(t => {
      if (t.name === 'send_message') return `send_message → ${t.args.target_id}`
      if (t.name === 'fetch_url') return `fetch_url(${t.args.url?.slice(0, 40)})`
      if (t.name === 'write_file') return `write_file(${t.args.path})`
      if (t.name === 'read_file') return `read_file(${t.args.path})`
      return t.name
    }).join(', ')
    state.recentActions.push({ ts: nowTimestamp(), summary })
    if (state.recentActions.length > 5) state.recentActions.shift()
  }

  // 方案 B：task 空转检测——连续 N 次 tick 无工具调用则自动清除
  if (state.task && isTick) {
    if (toolCallLog.length === 0) {
      state.taskIdleTickCount++
      console.log(`[任务] 空转计数 ${state.taskIdleTickCount}/${TASK_IDLE_TICK_LIMIT}`)
      if (state.taskIdleTickCount >= TASK_IDLE_TICK_LIMIT) {
        autoCompleteTask(`连续 ${TASK_IDLE_TICK_LIMIT} 次 tick 无工具调用`)
      }
    } else {
      state.taskIdleTickCount = 0
    }
  }

  // 6. 识别器：分离 think 块和正文，传入完整经历
  //    后台运行，不阻塞下一轮消息/TICK 处理
  const thinkMatch = response.match(/<think>([\s\S]*?)<\/think>/i)
  const jarvisThink = thinkMatch ? thinkMatch[1].trim() : ''
  const jarvisText = response.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  runRecognizer({
    userMessage: input,
    jarvisThink,
    jarvisResponse: jarvisText,
    toolCallLog,
    task: state.task,
    sessionRef,
  }).then(memories => {
    emitEvent('memories_written', { count: memories?.length || 0, memories: memories || [] })
  }).catch(err => {
    console.error('[识别器] 后台运行失败:', err)
  })
}

let processing = false
let currentTimer = null  // 当前 pending 的下一轮 timer，pushMessage 时可清掉以立即执行

async function onTick() {
  if (processing) return
  processing = true

  try {
    enqueueDueReminders()
    if (hasMessages()) {
      const msg = popMessage()
      const lane = msg.queueName === 'background' ? 'BG' : 'L1'
      await process(msg.raw, `${lane} 消息 from ${msg.fromId}`, msg)
    } else {
      const tick = formatTick()
      await process(tick, 'L2 TICK')
    }
  } finally {
    processing = false
    // 消耗一轮自定义节奏 TTL（到期自动回归默认）
    consumeTickerTick()
  }
}

// 调度优先级（从高到低）：
//   1. 有消息待处理 → 0
//   2. 429 rate-limited → quota 的 10 分钟
//   3. L2 自定义节奏（ttl > 0）→ L2 指定值
//   4. 有任务 → 30s
//   5. 空闲 → config.tickInterval
function scheduleNextTick() {
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }

  enqueueDueReminders()

  const hasPending = hasMessages()
  const hasPendingUser = hasUserMessages()
  const queueSnapshot = getQueueSnapshot()
  const rateLimited = isRateLimited()
  const customMs = getCustomIntervalMs()
  const taskActive = !!state.task
  const nextReminder = getNextPendingReminder()

  let interval
  let label
  if (hasPendingUser) {
    interval = 0
    label = '立即（用户消息待处理）'
  } else if (hasPending) {
    interval = 0
    label = '立即（后台消息待处理）'
  } else if (rateLimited) {
    interval = getTickInterval(config.tickInterval)
    label = `限流中（${interval / 1000}s）`
  } else if (customMs !== null) {
    const ticker = getTickerStatus()
    interval = customMs
    label = `L2 自定义 ${interval / 1000}s（剩 ${ticker.ttl} 轮${ticker.reason ? ' · ' + ticker.reason : ''}）`
  } else if (taskActive) {
    interval = 30000
    label = '任务模式 30s'
  } else {
    interval = config.tickInterval
    label = `${interval / 1000}s`
  }

  if (nextReminder) {
    const dueInMs = Math.max(0, new Date(nextReminder.due_at).getTime() - Date.now())
    if (dueInMs < interval) {
      interval = dueInMs
      label = `提醒触发 ${Math.ceil(dueInMs / 1000)}s`
    }
  }

  const quota = getQuotaStatus()
  console.log(`[配额] ${quota.rpmUsed} RPM | ${quota.tpmUsed} TPM | 占用 ${quota.ratio} | 队列 U:${queueSnapshot.user} B:${queueSnapshot.background} | 下次 Tick ${label}`)
  emitEvent('quota', { ...quota, nextTickMs: interval, ticker: getTickerStatus(), queue: queueSnapshot })
  currentTimer = setTimeout(async () => {
    currentTimer = null
    await onTick()
    scheduleNextTick()
  }, interval)
}

// 新消息到达时调用：清掉当前 pending timer，立即跑下一轮
// 如果当前正在 processing，则依赖 abort 机制让它快速结束，finally 后 scheduleNextTick 会用 interval=0 立即续跑
function triggerImmediateTick() {
  if (processing) return  // 由 abort + 结束后的 scheduleNextTick 接力
  if (!isRunning()) return
  if (currentTimer) { clearTimeout(currentTimer); currentTimer = null }
  // 异步启动一轮，不等结果
  ;(async () => {
    await onTick()
    scheduleNextTick()
  })()
}

let loopStarted = false

async function startConsciousnessLoop({ runImmediateTick = true } = {}) {
  if (loopStarted) return
  loopStarted = true

  // 注册调度函数，供控制层（stop/start）唤起
  setScheduler(scheduleNextTick)

  // 注册打断回调：新消息到达时打断当前 LLM 处理 + 立即触发下一轮（不等定时器）
  setInterruptCallback((entry) => {
    if (currentAbortController && shouldPreemptFor(entry)) {
      console.log(`[系统] 更高优先级消息到达，打断当前处理：${entry.fromId} (${entry.queueName})`)
      emitEvent('processing_preempted', {
        by: entry.fromId,
        queueName: entry.queueName,
        priority: entry.priority,
        current: currentExecution,
      })
      currentAbortController.abort('higher-priority-message')
    }
    triggerImmediateTick()
  })

  // 是否立即打一发 L2 TICK 由调用方决定；首次激活会用它触发启动自检。
  if (runImmediateTick) {
    await onTick()
  }
  scheduleNextTick()
}

async function main() {
  console.log('Jarvis 启动中...')

  // 同步 ACUI 技能记忆（AGENT_GUIDE.md hash 比对，按需更新 skill-ui-* 条目）
  ensureSkillMemories()

  const persona = getConfig('persona')
  if (persona) {
    console.log(`[系统] 已加载人格：${persona.slice(0, 60)}...`)
  } else {
    console.log('[系统] 人格未设置，等待 Jarvis 自我定义')
  }

  // 启动 HTTP API —— 无论是否激活都要起，激活页本身就靠它
  const apiPort = Number(globalThis.process.env.BAILONGMA_PORT) || 3721
  startAPI(apiPort, {
    getStateSnapshot: () => ({
      action: state.action,
      task: state.task,
      taskSteps: (state.taskSteps || []).map(s => ({ ...s })),
      prev_recall: state.prev_recall,
      lastToolResult: state.lastToolResult
        ? { ...state.lastToolResult, args: { ...(state.lastToolResult.args || {}) } }
        : null,
      sessionCounter: state.sessionCounter,
      recentActions: (state.recentActions || []).map(item => ({ ...item })),
      thoughtStack: (state.thoughtStack || []).map(item => ({ ...item })),
    }),
    onActivated: () => {
      console.log(`[LLM] 激活成功：${config.provider}（${config.model}）`)
      registerMinimaxIfAvailable()
      startConsciousnessLoop({ runImmediateTick: true }).catch(err => console.error('[系统] 主循环启动失败:', err))
    },
  })
  startSocialConnectors({ pushMessage, emitEvent }).catch(err => console.warn('[social] startup failed:', err.message))

  // 启动 TUI
  startTUI('ID:000001')

  if (config.needsActivation) {
    console.log(`输入消息前请先在浏览器打开 http://127.0.0.1:${apiPort}/activation 完成激活\n`)
    return
  }

  console.log('输入消息后按回车发送给 Jarvis\n')
  await startConsciousnessLoop()
}

main()
