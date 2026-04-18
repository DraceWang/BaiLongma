export const config = {
  // Tick 间隔（毫秒）- 二层思考器系统 TICK 固定 5 分钟
  tickInterval: 5 * 60 * 1000,

  // LLM 配置
  model: 'MiniMax-M2.7',
  apiKey: process.env.MINIMAX_API_KEY,
  baseURL: 'https://api.minimax.chat/v1',
}
