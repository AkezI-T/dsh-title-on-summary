/**
 * C 方案：总结之后调一次辅助模型，让它读总结正文写标题。
 *
 * 本模块**零依赖**（只用 ./title.js 与宿主传入的 ctx.llm），因为插件一直保持
 * "package.json 无 runtime dependencies" 的形状。为此这里自带两件本该由
 * `@deepseek-ai/dsh-llm` 提供的最小实现：
 *   1. 一条一次性 user 消息的形状（等价 RequestUserInput，见 dsh-llm types.d.ts:457-462）；
 *   2. 收流用的极简收集器（chunk 协议见 dsh-llm types.d.ts:406-436）。
 *
 * 两个必须踩住的坑：
 *   - **失败不抛异常**：`LlmRuntime.stream()` 会把适配器选择/派发/迭代失败规范化成
 *     终端的 `error` / `aborted` finish chunk（dsh-llm lib/types/types.d.ts:402-404），
 *     所以光用 try/catch 包 `for await` 抓不到失败，必须显式看 finish。
 *   - **输入必须自己截断**：发行版 `dsh-session-title-llm` 超 maxInputBytes 直接抛错
 *     （lib/index.js:193-195），而本机真实总结是 10.8-13.1 KB，照抄会 100% 失败。
 *
 * @module llm-title
 */

import { textBlocksToPlainText } from './title.js'

/** 辅助调用的默认策略。provider/model 为空表示"没配路由"，此时放弃调用。 */
export const LLM_TITLE_DEFAULTS = {
  provider: '',
  model: '',
  maxInputBytes: 4096,
  // 这是"跑飞输出"的天花板，不是目标长度。路由带推理时，模型关不掉的思考 token 也计入这里，
  // 所以 64 会让标题请求在拿到正文前就被 max-tokens 截断（表现为每次都静默回退本地派生）。
  maxOutputTokens: 4096,
  timeoutMs: 60000,
  targetWords: 5,
  targetCjkCharacters: 10,
}

/** 最多带几条最近用户消息：只够模型看清"现在在做什么"。 */
const RECENT_MESSAGES_MAX = 3
/** 单条最近消息的字节上限。 */
const RECENT_MESSAGE_MAX_BYTES = 400
/** 最近消息合计的字节上限（它们和总结一起抢 maxInputBytes）。 */
const RECENT_MAX_BYTES = 1200
/** 最近消息前的标签；system 里的语言规则和"当下焦点"规则据此生效。 */
const RECENT_LABEL = 'Recent user messages, oldest first (they show what the session is working on now):\n'

/** 一个码点的 UTF-8 字节数（不依赖 Buffer，且与 Buffer.byteLength 对同一字符串等价）。 */
function codePointBytes(codePoint) {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

/** 字符串的 UTF-8 字节数。 */
function utf8ByteLength(value) {
  if (typeof value !== 'string' || value === '') return 0
  let used = 0
  for (const character of value) used += codePointBytes(character.codePointAt(0))
  return used
}

/**
 * 按 UTF-8 字节截断。
 * 用 `for...of` 迭代码点而不是切字节数组，所以代理对（emoji 等）永远不会被切半，
 * 输出也永远不引入替换字符 U+FFFD。
 *
 * @param text - 原始文本。
 * @param maxBytes - 字节上限。
 * @returns 不超过 maxBytes 字节的前缀；入参非法或上限不足一个码点时返回空串。
 */
export function truncateUtf8(text, maxBytes) {
  if (typeof text !== 'string' || text === '') return ''
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return ''
  const limit = Math.floor(maxBytes)
  let used = 0
  let output = ''
  for (const character of text) {
    const size = codePointBytes(character.codePointAt(0))
    if (used + size > limit) break
    used += size
    output += character
  }
  return output
}

/** 前后成对引号（中英文都认）与反引号。模型对中文标题很爱加 “” 和 「」。 */
const WRAPPING_QUOTES = /^[`'"“”‘’「」『』]+|[`'"“”‘’「」『』]+$/g

/**
 * 清洗模型输出成一行标题。
 *
 * 模型经常自带装饰：Markdown 代码围栏、换行、"标题："前缀、包裹引号、句末句号。
 * 这些都要剥掉，否则会以"标题"的名义写进会话名里。
 *
 * **不做长度截断**：上限由调用方用 ./title.js 的 `truncateTitle` 按配置施加，
 * 免得这里写死一个长度、把调用方的 maxLength 配置吞掉。
 *
 * @param raw - 模型原始输出。
 * @returns 单行标题；没有任何可见字符时返回空串。
 */
export function cleanTitle(raw) {
  if (typeof raw !== 'string') return ''
  let value = raw.trim()
  if (value === '') return ''
  // 代码围栏可能整段包住标题，也可能只剩一个孤立的围栏行；一律换成换行再按行处理
  value = value.replace(/```[a-zA-Z0-9+#-]*/g, '\n')
  // 取第一条非空行：既跳过围栏留下的空行，也丢掉标题后面那句多余的解释。
  // 顺序很关键——先压空白的话换行会变成空格，第一行就再也切不出来了。
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
  if (firstLine === undefined) return ''
  value = firstLine.replace(/\s+/g, ' ')
  // 引号与反引号要先剥、再剥 Markdown 前缀，否则 '"## 标题"' 会先卡在引号上留下 '##'
  for (let round = 0; round < 4; round += 1) {
    const before = value
    value = value.replace(/^[#>\s]+/, '')
    value = value.replace(WRAPPING_QUOTES, '').trim()
    if (value === before) break
  }
  // "标题：xxx" / "Title: xxx" 这类前缀标签
  const labelled = /^(?:标题|会话标题|Title|Session title)\s*[：:]\s*(.+)$/i.exec(value)
  if (labelled !== null && labelled[1].trim() !== '') value = labelled[1].trim()
  // 句末句号（含中文句号）。问号/感叹号是语气的一部分，保留。
  value = value.replace(/[.。]+$/, '').trim()
  // 控制字符一律清掉
  value = value.replace(/[\x00-\x1f\x7f]/g, '').trim()
  return value
}

/** 语言感知的 system 指令，改写自 dsh-session-title-llm/lib/index.js:147-155。 */
function systemPrompt(config, hasUserMessages) {
  const target = 'Aim for about ' + config.targetWords + ' words in non-CJK languages or ' + config.targetCjkCharacters + ' CJK characters.'
  // 宿主的压缩总结被强制写成英文（dsh-compaction-basic 的总结指令），所以"跟随总结语言"
  // 会把中文会话的标题也变成英文。带用户消息时改为跟随用户消息的语言。
  const languageRule = hasUserMessages
    ? 'Write the title in the same natural language as the user messages supplied after the summary. The compaction summary is written in English by the compaction engine by design; the summary language must not decide the title language.'
    : 'Use the language of the summary. If the summary quotes the user verbatim, follow the language of those quotes.'
  // 总结覆盖整段会话，开头那节永远是"最初意图"；最近消息才是"现在"。
  const focusRule = hasUserMessages
    ? 'The summary spans the whole session, so its opening section describes the original intent. The recent user messages show the current focus: when the two disagree, title the current focus.'
    : null
  const lines = [
    'Create a concise title for an AI coding-assistant session from the supplied compaction summary of that session.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    languageRule,
    'Ignore structural section headings such as "Primary Request and Intent" or "Files and Code Sections"; describe what the session is actually about.',
  ]
  if (focusRule !== null) lines.push(focusRule)
  lines.push(target)
  return lines.join('\n')
}

/** options 覆盖默认值；只认已知键，且非空值才生效。 */
function resolveConfig(options) {
  const source = options !== null && typeof options === 'object' ? options : {}
  const config = { ...LLM_TITLE_DEFAULTS }
  for (const key of Object.keys(LLM_TITLE_DEFAULTS)) {
    const value = source[key]
    if (value === undefined || value === null || value === '') continue
    config[key] = value
  }
  return config
}

/** 极简收流：按 index 归并 text-delta，block-end 到达时以它为准（同发行版 BlockAssembler 的取舍）。 */
function createCollector() {
  const texts = new Map()
  const types = new Map()
  const order = []
  const closed = new Set()
  let sawToolCall = false
  let finish = null
  const slot = (index, type) => {
    if (types.has(index)) return
    types.set(index, type)
    texts.set(index, '')
    order.push(index)
  }
  return {
    push(chunk) {
      if (chunk === null || typeof chunk !== 'object') return
      const index = typeof chunk.index === 'number' ? chunk.index : 0
      switch (chunk.type) {
        case 'block-start':
          slot(index, chunk.blockType)
          return
        case 'text-delta':
          if (closed.has(index)) return
          slot(index, 'text')
          if (types.get(index) === 'text') texts.set(index, (texts.get(index) || '') + String(chunk.text === undefined ? '' : chunk.text))
          return
        case 'tool-call-delta':
          sawToolCall = true
          slot(index, 'tool-call')
          return
        case 'block-end': {
          const block = chunk.block
          closed.add(index)
          if (block === null || typeof block !== 'object') return
          if (!types.has(index)) order.push(index)
          types.set(index, block.type)
          if (block.type === 'text') texts.set(index, String(block.text === undefined ? '' : block.text))
          if (block.type === 'tool-call') sawToolCall = true
          return
        }
        case 'finish':
          finish = chunk.reason === undefined ? null : chunk.reason
          return
        default:
          return
      }
    },
    /** 文本块按出现顺序拼接；reasoning / tool-call 一律不计入标题。 */
    text() {
      const parts = []
      for (const index of order) {
        if (types.get(index) !== 'text') continue
        const value = texts.get(index)
        if (typeof value === 'string' && value !== '') parts.push(value)
      }
      return parts.join(' ')
    },
    /** 流未给出 finish 时按 stop 处理（同发行版 BlockAssembler.finish 的默认）。 */
    finished() {
      return finish === null ? { kind: 'stop' } : finish
    },
    sawToolCall() {
      return sawToolCall
    },
  }
}

/**
 * 总结正文 -> 一行标题。
 *
 * **任何失败都返回 null，绝不抛**：调用方拿 null 就回退到 ./title.js 的本地派生（A 方案），
 * 所以这里最坏的结果只是"这次没换成标题"，不会影响会话。
 *
 * @param llm - ctx.llm 服务；只用它的 stream(options)。
 * @param summaryBlocks - compaction/summary 的 ContentBlock[]。
 * @param [options] - 覆盖 LLM_TITLE_DEFAULTS；另认 options.signal（调用方取消）、options.sessionId
 *   与 options.recentUserMessages（最近几条真实用户消息：既定标题语言，也告诉模型"现在在做什么"）。
 * @returns 清洗后的非空标题；失败、无路由、输入为空、模型没给出可用文本时返回 null。
 */
export async function generateTitleWithLlm(llm, summaryBlocks, options) {
  try {
    if (llm === null || typeof llm !== 'object' || typeof llm.stream !== 'function') return null
    const config = resolveConfig(options)
    if (typeof config.provider !== 'string' || config.provider === '') return null
    if (typeof config.model !== 'string' || config.model === '') return null

    const source = options !== null && typeof options === 'object' ? options : {}
    // 最近用户消息：总结固定是英文，标题语言只能从用户原文判断；它们同时是"当下焦点"。
    const recentSource = Array.isArray(source.recentUserMessages) ? source.recentUserMessages : []
    const recent = []
    for (const item of recentSource) {
      if (typeof item !== 'string') continue
      const text = item.trim()
      if (text === '') continue
      recent.push(truncateUtf8(text, RECENT_MESSAGE_MAX_BYTES))
    }
    const recentText = recent.length === 0
      ? ''
      : truncateUtf8(recent.slice(-RECENT_MESSAGES_MAX).join('\n---\n'), RECENT_MAX_BYTES)
    const system = systemPrompt(config, recentText !== '')
    // system 与最近消息都占输入预算，先扣掉再截正文；扣完不够一个码点就直接放弃。
    const recentBytes = recentText === '' ? 0 : utf8ByteLength(RECENT_LABEL) + utf8ByteLength(recentText)
    const budget = Math.floor(config.maxInputBytes) - utf8ByteLength(system) - recentBytes
    if (budget <= 0) return null
    const body = truncateUtf8(textBlocksToPlainText(summaryBlocks), budget)
    if (body === '') return null
    const content = [{ type: 'text', text: body }]
    if (recentText !== '') content.push({ type: 'text', text: RECENT_LABEL + recentText })

    const request = {
      provider: config.provider,
      model: config.model,
      messages: [{ role: 'user', content }],
      system,
      maxTokens: config.maxOutputTokens,
      purpose: 'session-title',
    }
    if (typeof source.sessionId === 'string' && source.sessionId !== '') request.sessionId = source.sessionId

    const timeoutMs = Number.isFinite(config.timeoutMs) && config.timeoutMs > 0 ? Math.floor(config.timeoutMs) : 0
    const signals = []
    if (source.signal !== undefined && source.signal !== null) signals.push(source.signal)
    if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
    if (signals.length === 1) request.signal = signals[0]
    else if (signals.length > 1) request.signal = AbortSignal.any(signals)
    if (request.signal !== undefined && request.signal.aborted) return null

    const collector = createCollector()
    for await (const chunk of llm.stream(request)) {
      if (request.signal !== undefined && request.signal.aborted) return null
      collector.push(chunk)
    }
    if (request.signal !== undefined && request.signal.aborted) return null

    const finish = collector.finished()
    if (finish === null || typeof finish !== 'object' || finish.kind !== 'stop') return null
    if (collector.sawToolCall()) return null

    const title = cleanTitle(collector.text())
    return title === '' ? null : title
  } catch (error) {
    return null
  }
}
