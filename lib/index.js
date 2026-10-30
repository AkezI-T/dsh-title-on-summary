/**
 * dsh-title-on-summary —— 会话被总结时，顺手把它的名字更新成"现在在讲什么"。
 *
 * 触发点：`session/event` 里的 `compaction/summary`。它是"一次成功总结恰好一次"的唯一信号
 * （compaction/start → summary → 替换 user 消息 → end），且是 post-commit 的 fire-and-forget：
 * 监听器抛错只记 warning，不会影响会话本身。
 *
 * 标题来源两条路径，C 为主、A 兜底：
 * - **C（模型生成）**：把总结 + 最近几条用户消息喂给一次辅助 LLM 调用，标题像人写的，质量明显更好。
 * - **A（本地派生）**：从总结里找"描述当下"的那一节（Current Work 等）取第一句散文，
 *   没有这种小节才退回全文第一句；零调用、纯同步。
 * 之所以让 A 永远留在后面，是因为 C 多一次调用就多一份不确定性（没配 provider/model、超时、
 * 模型返回空）—— 任何失败都退化成"至少和以前一样"，而不是"这次总结干脆没改名"。
 *
 * 为什么用 rename 而不是 refresh：refresh 要花一次辅助 LLM 调用，而本机安装的标题 provider
 * 只把"会话第一条人类消息"喂给模型 —— 每次总结都 refresh 等于每次白烧一次调用、标题还几乎不变。
 * 总结文本本身就足够写一个好标题，所以这里直接用 rename 落盘。
 *
 * **标题语言跟随用户消息，不跟随总结**：宿主的压缩总结被 dsh-compaction-basic 强制写成英文，
 * 按"总结是什么语言就写什么语言"会把中文会话的标题变成英文。所以插件同时记下每个会话最近的
 * 三条真实用户消息，既作为语言依据，也告诉模型"现在在做什么"——总结覆盖整段会话，
 * 开头一节永远是"最初意图"，只看总结会得到与会话现状无关的标题。本地兜底在总结标题与
 * 用户语言不一致时也改用用户原文派生。压缩产生的 checkpoint 消息不是用户消息，必须排除。
 *
 * @module dsh-title-on-summary
 */
import { deriveTitle, truncateTitle } from './title.js'
import { LLM_TITLE_DEFAULTS, generateTitleWithLlm } from './llm-title.js'

/** 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-title-on-summary'
/** 没有必须在挂载前就位的服务：sessionTitle 与 llm 都用延迟注入拿，缺了也只是降级。 */
export const inject = []

/** 本地兜底默认值；LLM 那几项优先取 llm-title.js 的默认（默认值只该有一个出处）。 */
const DEFAULTS = Object.freeze({
  enabled: true,
  maxLength: 32,
  minLength: 4,
  titleSource: 'llm',
  llm: Object.freeze({
    provider: null,
    model: null,
    maxInputBytes: 4096,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
    targetWords: 5,
    targetCjkCharacters: 10,
  }),
})

const TITLE_SOURCES = ['llm', 'local']

/** 最多缓存多少个会话的最近用户消息；会话销毁时主动清理，这里只是兜底上限。 */
const MAX_ANCHOR_SESSIONS = 64
/** 每个会话最多记几条最近用户消息（llm-title.js 还会按字节再截一次）。 */
const MAX_RECENT_MESSAGES = 3
/** 单条消息最多保留多少字符。 */
const MAX_ANCHOR_CHARS = 500

/** 取一个有限数值；坏值一律回落默认，绝不把 NaN 传给模型调用。 */
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** 取一个非空字符串；空串/null/数字都算没配。 */
function stringOrNull(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/** 从 user/message 的 content 里取文本；只认 text 块，超长截断。 */
function userTextOf(content) {
  if (typeof content === 'string') return content.trim().slice(0, MAX_ANCHOR_CHARS)
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      text += (text === '' ? '' : '\n') + block.text
      if (text.length >= MAX_ANCHOR_CHARS) break
    }
  }
  return text.trim().slice(0, MAX_ANCHOR_CHARS)
}

/** 语言锚点只需要判断是不是 CJK，不追求精确分词。 */
function hasCjk(text) {
  return typeof text === 'string' && /[\u3400-\u9fff]/.test(text)
}

/**
 * 读配置。坏配置一律回落到默认值 —— 配置写错不该让插件挂载失败或悄悄改变行为。
 * @param config - cordis.patch.yml 里的 config。
 */
function readSettings(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const rawLlm = source.llm !== null && typeof source.llm === 'object' ? source.llm : {}
  const llmDefaults = LLM_TITLE_DEFAULTS !== null && typeof LLM_TITLE_DEFAULTS === 'object' ? LLM_TITLE_DEFAULTS : {}
  const llmNumber = (key) => finiteOr(rawLlm[key], finiteOr(llmDefaults[key], DEFAULTS.llm[key]))
  return {
    enabled: source.enabled !== false,
    maxLength: finiteOr(source.maxLength, DEFAULTS.maxLength),
    minLength: finiteOr(source.minLength, DEFAULTS.minLength),
    // 认不出来的取值按默认走：宁可多花一次调用，也不要因为一个错别字变成"永远本地"
    titleSource: TITLE_SOURCES.includes(source.titleSource) ? source.titleSource : DEFAULTS.titleSource,
    llm: {
      // provider/model 没配就是没配：llm-title.js 据此判断"能不能真的调"，缺了会返回 null（走 A）
      provider: stringOrNull(rawLlm.provider),
      model: stringOrNull(rawLlm.model),
      maxInputBytes: llmNumber('maxInputBytes'),
      maxOutputTokens: llmNumber('maxOutputTokens'),
      timeoutMs: llmNumber('timeoutMs'),
      targetWords: llmNumber('targetWords'),
      targetCjkCharacters: llmNumber('targetCjkCharacters'),
    },
  }
}

/**
 * 挂载插件。
 * @param ctx - 宿主插件上下文。
 * @param config.enabled - 关掉就完全不订阅（默认 true）。
 * @param config.maxLength - 标题长度上限（默认 32 字符）。
 * @param config.minLength - 可接受的最短散文行（默认 4 字符）。
 * @param config.titleSource - 'llm'（默认，模型生成，失败落本地）或 'local'（只本地派生）。
 * @param config.llm - C 路径的参数：provider/model/maxInputBytes/maxOutputTokens/timeoutMs/targetWords/targetCjkCharacters。
 */
export function apply(ctx, config = {}) {
  const settings = readSettings(config)
  if (settings.enabled === false) return

  // 延迟注入：服务还没就位时不阻塞插件挂载，缺了也只是降级（不报错、不影响会话）。
  let titleService = null
  let llmService = null
  if (typeof ctx.inject === 'function') {
    ctx.inject(['sessionTitle'], (scoped) => {
      titleService = scoped.sessionTitle
    })
    ctx.inject(['llm'], (scoped) => {
      llmService = scoped.llm ?? null
    })
  } else {
    titleService = ctx.sessionTitle ?? null
    llmService = ctx.llm ?? null
  }

  if (typeof ctx.on !== 'function') return

  // 会话 id -> 最近几条真实用户消息。它们既是标题语言的依据，也是"现在在做什么"的依据：
  // 总结覆盖整段会话、开头永远是"最初意图"，只有这几条消息能告诉模型当下焦点。
  // 压缩产生的 checkpoint 消息 source.kind 是 'compact-checkpoint'，必须排除，
  // 否则下一次总结会拿英文 checkpoint 当用户原文。
  const recentUserMessages = new Map()

  /** 记下一条真实用户消息；checkpoint / 工具通知一律跳过。 */
  const rememberUserMessage = (session, event) => {
    if (session === null || typeof session !== 'object' || typeof session.id !== 'string' || session.id === '') return
    const data = event.data !== null && typeof event.data === 'object' ? event.data : null
    if (data === null) return
    const source = data.source !== null && typeof data.source === 'object' ? data.source : null
    if (source === null || source.kind !== 'user') return
    const text = userTextOf(data.content)
    if (text === '') return
    const previous = recentUserMessages.get(session.id) ?? []
    if (previous.length === 0 && recentUserMessages.size >= MAX_ANCHOR_SESSIONS) {
      const oldest = recentUserMessages.keys().next()
      if (oldest.done !== true) recentUserMessages.delete(oldest.value)
    }
    recentUserMessages.set(session.id, previous.concat(text).slice(-MAX_RECENT_MESSAGES))
  }

  ctx.on('session/event', (session, event) => {
    if (event === null || typeof event !== 'object') return
    if (event.type === 'user/message') {
      rememberUserMessage(session, event)
      return
    }
    if (event.type !== 'compaction/summary') return
    // 在派发栈里就取最近消息：总结事件先于 checkpoint 替换消息发布，此刻拿到的仍是真实用户原文。
    const recent = typeof session.id === 'string' && session.id !== ''
      ? recentUserMessages.get(session.id) ?? null
      : null
    // 必须挪出派发栈：append 在发布观察者期间 entry.appending 为真，观察者里同步 append 会被判成重入
    // （"session append cannot reenter while another append is being published"）而静默失败 —— 表现为
    // 一次总结什么都没发生。微任务时该窗口已关闭，且 session 仍 live，rename 的存活校验照样通过。
    queueMicrotask(() => {
      void renameFromSummary(session, event, recent).catch(() => {})
    })
  })

  ctx.on('session/disposed', (session) => {
    if (session !== null && typeof session === 'object' && typeof session.id === 'string') recentUserMessages.delete(session.id)
  })

  /**
   * 决定这次用哪个标题：C 优先，拿不到就落回 A。
   * @param summary - compaction/summary 的 data.summary（ContentBlock[]）
   * @param session - 当前会话。
   * @param recent - 最近几条真实用户消息；没有就是 null。
   * @returns 标题；两条路径都产不出时返回 null（调用方放弃改名，宁可不改也不写坏标题）
   */
  async function resolveTitle(summary, session, recent) {
    const anchor = recent !== null && recent.length > 0 ? recent[recent.length - 1] : null
    if (settings.titleSource === 'llm' && llmService !== null) {
      try {
        // sessionId 让这次辅助调用能挂到会话上（llm-title.js 认这个可选键）；拿不到就不传。
        const llmOptions = { ...settings.llm }
        if (typeof session.id === 'string' && session.id !== '') llmOptions.sessionId = session.id
        // 总结固定是英文，且描述的是整段会话；语言和"当下焦点"都只能靠用户原文判断。
        if (recent !== null && recent.length > 0) llmOptions.recentUserMessages = recent.slice()
        const generated = await generateTitleWithLlm(llmService, summary, llmOptions)
        if (typeof generated === 'string' && generated.trim() !== '') {
          // 模型可能给出超长标题：两条路径共用同一个长度上限，截断规则也只该有一套。
          return truncateTitle(generated.trim(), settings.maxLength)
        }
      } catch (error) {
        // 接口约定 generateTitleWithLlm 内部不抛；这里只是最后一道兜底，任何失败都落回本地派生。
      }
    }
    const derived = deriveTitle(summary, settings)
    if (anchor === null) return derived
    // 总结是英文时本地派生也会跟着英文；此时优先用用户原文派生一个同语言的标题。
    if (derived !== null && hasCjk(derived) === hasCjk(anchor)) return derived
    const fromAnchor = deriveTitle([{ type: 'text', text: anchor }], settings)
    return fromAnchor !== null ? fromAnchor : derived
  }

  async function renameFromSummary(session, event, recent) {
    const service = titleService
    // 服务可能压根没注入成功（undefined/null），也可能不是我们期待的形状：一律安静退出。
    if (service === null || typeof service !== 'object' || typeof service.rename !== 'function') return
    if (session === null || typeof session !== 'object') return

    const summary = event.data !== null && typeof event.data === 'object' ? event.data.summary : null
    const title = await resolveTitle(summary, session, recent)
    if (title === null) return

    // 名字没变就别写：避免每次总结都多出一条无意义的标题事件。
    try {
      if (typeof service.get === 'function') {
        const current = service.get(session)
        if (current !== null && typeof current === 'object' && current.title === title) return
      }
    } catch (error) {
      // 读不到当前标题不影响改名
    }

    try {
      await service.rename(session, title)
    } catch (error) {
      // 改名失败绝不能影响会话：只留一条 warning。
      if (ctx.logger !== null && typeof ctx.logger === 'object' && typeof ctx.logger.warn === 'function') {
        ctx.logger.warn('[dsh-title-on-summary] rename failed: ' + String(error && error.message ? error.message : error))
      }
    }
  }
}
