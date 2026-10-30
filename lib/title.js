/**
 * 从"总结"文本里派生一个会话标题候选。
 *
 * 纯函数，不依赖 DSH 运行时，**不调用任何模型**：总结本身已经是压缩过的正文，
 * 第一句像人话的散文通常就是这段会话在讲什么。
 *
 * 需要跳过的东西（否则会拿 "## 主要请求与意图" 这种小标题当标题）：
 * markdown 标题、表格行、代码围栏、引用、"xxx："这种纯标签行，以及 "<compacted-summary>" 这类整行的包装标签。
 * 首行带引文时优先取引文 —— 总结里第一条引文通常就是这段会话最原始的那句需求。
 *
 * @module title
 */

/** 取出 ContentBlock[] 里的文本；summary 是块数组而不是字符串。 */
export function textBlocksToPlainText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 去掉行内 markdown 装饰与列表符号，压掉多余空白。 */
export function cleanLine(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 这一行能不能当标题：必须是散文，不能是结构性的 markdown。
 * @returns boolean
 */
export function isProseLine(line) {
  if (typeof line !== 'string' || line === '') return false
  if (/^[#>|]/.test(line)) return false
  // "<compacted-summary>" 这类整行的包装标签是外壳，不是内容
  if (/^<[^>]*>$/.test(line)) return false
  if (/^\|?[\s:|-]*\|[\s:|-]*$/.test(line)) return false
  if (/^(?:[-=]{3,})$/.test(line)) return false
  // 官方总结对空小节写 "(none)"，那不是标题
  if (/^\((?:none|n\/a)\)$/i.test(line)) return false
  if (/^（(?:无|暂无|没有)）$/.test(line)) return false
  // "主要请求与意图：" 这类纯标签行没有信息量
  if (/[：:]$/.test(line)) return false
  // 至少得有一个字母或汉字，否则多半是符号/代码片段
  return /[A-Za-z\u3400-\u9FFF]/.test(line)
}

/** 成对引号：中英文都要认（总结正文里两种都常见）。 */
const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
]

/**
 * 取第一个引文内容。
 * 总结的第一条引文通常就是这段会话最原始的那句需求，比 "Original (plugin #1): …" 这类前缀有用得多。
 * @param value - 候选行
 * @param minLength - 引文短于这个长度就不算数
 * @returns 引文；没有够长的引文时返回空串
 */
export function firstQuotedSpan(value, minLength = 4) {
  if (typeof value !== 'string') return ''
  let at = -1
  let text = ''
  for (const [open, close] of QUOTE_PAIRS) {
    const start = value.indexOf(open)
    if (start < 0 || (at >= 0 && start > at)) continue
    const end = value.indexOf(close, start + 1)
    if (end < 0) continue
    const inner = value.slice(start + 1, end).trim()
    if (inner.length < minLength) continue
    at = start
    text = inner
  }
  return text
}

/** 去掉 "Original (plugin #1): " 这类前缀标签，只留真正的内容。 */
export function stripLabelPrefix(value) {
  if (typeof value !== 'string') return ''
  const match = /^([^：:。！？!?]{1,30})[：:]\s*(.+)$/.exec(value)
  return match === null ? value : match[2].trim()
}

const BREAK_CHARS = [' ', '\t', '，', '。', '、', '；', '：', ',', '.', ';', '!', '?', '！', '？']

/**
 * 按字符数截断（CJK 按 1 个字符算，标题用不着按 token 精算）。
 * 尽量在标点或空格处断句 —— "…skill 和 M…" 这种切在词中间很难看。
 */
export function truncateTitle(value, maxLength) {
  if (typeof value !== 'string') return ''
  if (value.length <= maxLength) return value
  const head = value.slice(0, maxLength)
  let boundary = -1
  for (const char of BREAK_CHARS) {
    const at = head.lastIndexOf(char)
    if (at > boundary) boundary = at
  }
  // 断点太靠前（不到一半）就宁可硬截，免得标题只剩几个字
  // 两个分支都要把 '…' 算进 maxLength：head 已经是 slice(0, maxLength)，再拼省略号就超一个字符。
  if (boundary >= Math.floor(maxLength / 2)) return head.slice(0, boundary).trimEnd() + '…'
  return head.slice(0, maxLength - 1).trimEnd() + '…'
}

/**
 * 官方压缩总结里"描述当下"的小节名，按优先级排列。
 *
 * 宿主（dsh-compaction-basic）固定按八节输出总结，开头永远是 Primary Request and Intent ——
 * 那一节写的是会话**最初**的意图，用来当标题会得到"会话开头在聊什么"，与会话现状无关。
 * 真正回答"现在在做什么"的是 Current Work，其次是 Next Step / Pending Jobs。
 */
const CURRENT_SECTION_PATTERNS = [
  /^current work$/i,
  /^next step$/i,
  /^pending jobs$/i,
  /^当前工作$/,
  /^当前进度$/,
  /^下一步$/,
  /^待办(?:任务)?$/,
  /^进行中$/,
]

/** 读一行 markdown 小标题；不是小标题返回 null。 */
function sectionHeading(raw) {
  if (typeof raw !== 'string') return null
  const match = /^#{1,6}\s+(.*\S)\s*$/.exec(raw)
  return match === null ? null : cleanLine(match[1])
}

/**
 * 派生标题。
 *
 * 选材顺序：先找"描述当下"的小节（见 CURRENT_SECTION_PATTERNS），取该节第一句散文；
 * 都没有时退回全文第一句散文 —— 那是给没有小节结构的总结留的旧行为。
 *
 * @param blocks - 总结的 ContentBlock[]
 * @param options.maxLength - 标题上限（默认 32 字符）
 * @param options.minLength - 低于这个长度不算标题（默认 4）
 * @returns 标题字符串；找不到合适的散文行时返回 null（调用方应放弃改名，别写坏标题）
 */
export function deriveTitle(blocks, options = {}) {
  const maxLength = Number.isFinite(options.maxLength) && options.maxLength > 0 ? Math.floor(options.maxLength) : 32
  const minLength = Number.isFinite(options.minLength) && options.minLength >= 0 ? Math.floor(options.minLength) : 4
  const text = textBlocksToPlainText(blocks)
  if (text === '') return null
  const candidates = []
  let section = null
  let inFence = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = sectionHeading(raw)
    if (heading !== null) {
      section = heading
      continue
    }
    const line = cleanLine(raw)
    if (line.length < minLength) continue
    if (!isProseLine(line)) continue
    const quoted = firstQuotedSpan(line, minLength)
    const candidate = quoted === '' ? stripLabelPrefix(line) : quoted
    if (candidate.length < minLength) continue
    candidates.push({ section, candidate })
  }
  if (candidates.length === 0) return null
  for (const pattern of CURRENT_SECTION_PATTERNS) {
    const hit = candidates.find((item) => item.section !== null && pattern.test(item.section))
    if (hit !== undefined) return truncateTitle(hit.candidate, maxLength)
  }
  return truncateTitle(candidates[0].candidate, maxLength)
}
