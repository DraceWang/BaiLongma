import WebSocket from 'ws'
import { requestJson } from './http.js'
import { env } from './utils.js'

const RECONNECT_BASE_MS = 1000
const RECONNECT_MAX_MS = 60000
const HEARTBEAT_ACK_TIMEOUT_MS = 10000

export async function startDiscordConnector({ pushMessage, emitEvent }) {
  const token = env('DISCORD_BOT_TOKEN')
  if (!token) return null

  let stopped = false
  let ws = null
  let heartbeatTimer = null
  let heartbeatAckTimer = null
  let reconnectTimer = null
  let reconnectAttempt = 0
  let seq = null
  let sessionId = null
  let resumeGatewayUrl = null
  let heartbeatAckPending = false

  function clearTimers() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
    if (heartbeatAckTimer) { clearTimeout(heartbeatAckTimer); heartbeatAckTimer = null }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }

  async function getGatewayUrl() {
    const res = await requestJson('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${token}` },
    })
    if (!res.ok || !res.data?.url) throw new Error(`Discord gateway lookup failed: ${res.text}`)
    return res.data.url
  }

  function scheduleReconnect() {
    if (stopped) return
    clearTimers()
    const jitter = Math.random() * 0.3 + 0.85 // 0.85-1.15
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt * jitter, RECONNECT_MAX_MS)
    reconnectAttempt++
    emitEvent?.('social_status', { platform: 'discord', status: 'reconnecting', attempt: reconnectAttempt, delayMs: Math.round(delay) })
    reconnectTimer = setTimeout(() => connect(false), delay)
    reconnectTimer.unref?.()
  }

  function sendWs(payload) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload))
  }

  function startHeartbeat(interval) {
    heartbeatTimer = setInterval(() => {
      if (heartbeatAckPending) {
        // 上一次心跳没收到 ACK，连接是僵尸，强制断开重连
        emitEvent?.('social_status', { platform: 'discord', status: 'zombie_detected' })
        ws?.terminate()
        return
      }
      heartbeatAckPending = true
      sendWs({ op: 1, d: seq })
      // 如果 HEARTBEAT_ACK_TIMEOUT_MS 内没收到 ACK，也强制断开
      heartbeatAckTimer = setTimeout(() => {
        if (heartbeatAckPending) {
          emitEvent?.('social_status', { platform: 'discord', status: 'heartbeat_timeout' })
          ws?.terminate()
        }
      }, HEARTBEAT_ACK_TIMEOUT_MS)
      heartbeatAckTimer.unref?.()
    }, interval)
    heartbeatTimer.unref?.()
  }

  async function connect(fresh = true) {
    if (stopped) return
    try {
      const gatewayUrl = (fresh || !resumeGatewayUrl)
        ? await getGatewayUrl()
        : resumeGatewayUrl
      ws = new WebSocket(`${gatewayUrl}/?v=10&encoding=json`)

      ws.on('message', raw => {
        let msg = null
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (msg.s != null) seq = msg.s

        // op 10: Hello — 启动心跳，然后 IDENTIFY 或 RESUME
        if (msg.op === 10) {
          const interval = msg.d?.heartbeat_interval || 45000
          // 初始心跳加随机抖动，避免所有客户端同步发包
          setTimeout(() => {
            startHeartbeat(interval)
          }, Math.floor(Math.random() * interval))

          if (sessionId && seq && !fresh) {
            sendWs({ op: 6, d: { token, session_id: sessionId, seq } })
          } else {
            sendWs({
              op: 2,
              d: {
                token,
                intents: 512 | 4096 | 32768,
                properties: { os: 'windows', browser: 'bailongma', device: 'bailongma' },
              },
            })
          }
          return
        }

        // op 11: Heartbeat ACK
        if (msg.op === 11) {
          heartbeatAckPending = false
          if (heartbeatAckTimer) { clearTimeout(heartbeatAckTimer); heartbeatAckTimer = null }
          return
        }

        // op 7: Reconnect 指令
        if (msg.op === 7) {
          ws?.close(4000)
          return
        }

        // op 9: Invalid Session — 需要重新 IDENTIFY
        if (msg.op === 9) {
          sessionId = null
          seq = null
          ws?.close(4000)
          return
        }

        if (msg.t === 'READY') {
          reconnectAttempt = 0
          sessionId = msg.d?.session_id || null
          resumeGatewayUrl = msg.d?.resume_gateway_url || null
          emitEvent?.('social_status', { platform: 'discord', status: 'ready', user: msg.d?.user?.username })
          return
        }

        if (msg.t === 'RESUMED') {
          reconnectAttempt = 0
          emitEvent?.('social_status', { platform: 'discord', status: 'resumed' })
          return
        }

        if (msg.t !== 'MESSAGE_CREATE') return
        const event = msg.d || {}
        if (!event.content || event.author?.bot) return
        const fromId = `discord:${event.channel_id}:${event.author?.id || 'unknown'}`
        pushMessage(fromId, event.content, 'DISCORD', {
          social: { platform: 'discord', channel_id: event.channel_id, author_id: event.author?.id || null },
        })
        emitEvent?.('message_in', { from_id: fromId, content: event.content, channel: 'DISCORD', timestamp: new Date().toISOString() })
      })

      ws.on('close', code => {
        clearTimers()
        emitEvent?.('social_status', { platform: 'discord', status: 'closed', code })
        // 4004=token 无效，4014=intent 无权限，不重连
        if (!stopped && code !== 4004 && code !== 4014) scheduleReconnect()
      })

      ws.on('error', error => {
        emitEvent?.('social_status', { platform: 'discord', status: 'error', error: error.message })
      })
    } catch (error) {
      emitEvent?.('social_status', { platform: 'discord', status: 'error', error: error.message })
      scheduleReconnect()
    }
  }

  await connect(true)

  return {
    platform: 'discord',
    stop() {
      stopped = true
      clearTimers()
      try { ws?.close() } catch {}
    },
  }
}
