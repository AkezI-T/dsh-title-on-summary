/**
 * C 方案单测：全程用假 llm，不联网、不真调模型。
 * 重点在"任何失败都退化成 null（回退本地派生），绝不抛、绝不写坏标题"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LLM_TITLE_DEFAULTS,
  cleanTitle,
  generateTitleWithLlm,
  truncateUtf8,
} from '../src/llm-title.js'

/** 造一个假 llm：记录传进来的 options，并按给定的 chunk 序列吐流。 */
function fakeLlm(chunks) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* () {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const textDelta = (text, index = 0) => ({ type: 'text-delta', index, text })
const stop = { type: 'finish', reason: { kind: 'stop' } }
const summary = [{ type: 'text', text: '会话把插件 dsh-title-on-summary 的触发链修好了，并新增了辅助模型生成标题。' }]
const SUMMARY_EN = [{ type: 'text', text: '## Primary Request and Intent\n- Build LanWeave as an autonomous network operations system with real evidence.' }]
const route = { provider: 'deepseek-official', model: 'deepseek-flash' }

test('LLM_TITLE_DEFAULTS：接口冻结的默认值', () => {
  assert.deepEqual(LLM_TITLE_DEFAULTS, {
    provider: '',
    model: '',
    maxInputBytes: 4096,
    maxOutputTokens: 4096,
    timeoutMs: 60000,
    targetWords: 5,
    targetCjkCharacters: 10,
  })
})

test('truncateUtf8：CJK/ASCII 边界按字节切，不切半个码点', () => {
  // 汉字 3 字节：7 个字 21 字节，第 8 个装不下
  assert.equal(truncateUtf8('汉字汉字汉字汉字', 21), '汉字汉字汉字汉')
  // 20 字节只够 6 个字（18），第 7 个字会到 21 字节
  assert.equal(truncateUtf8('汉字汉字汉字汉字', 20), '汉字汉字汉字')
  assert.equal(truncateUtf8('汉字', 100), '汉字')
  // ASCII 1 字节
  assert.equal(truncateUtf8('abcdef', 4), 'abcd')
  // 混排：'a' + 汉字 + 'b' = 1+3+1 = 5 字节
  assert.equal(truncateUtf8('a汉b', 5), 'a汉b')
  assert.equal(truncateUtf8('a汉b', 4), 'a汉')
})

test('truncateUtf8：emoji（代理对/4 字节码点）不会被切半', () => {
  const emoji = '😀' // U+1F600，4 字节，String.length === 2
  assert.equal(truncateUtf8(emoji, 4), emoji)
  assert.equal(truncateUtf8(emoji, 3), '')
  assert.equal(truncateUtf8('a' + emoji, 5), 'a' + emoji)
  assert.equal(truncateUtf8('a' + emoji, 4), 'a')
  // 绝不产生替换字符
  for (const max of [1, 2, 3, 4, 5, 6, 7]) {
    assert.equal(truncateUtf8('a' + emoji + '汉字', max).includes('\uFFFD'), false)
  }
  // 与 Node 的字节口径一致
  for (const max of [1, 3, 4, 6, 10]) {
    assert.equal(Buffer.byteLength(truncateUtf8('a😀汉字xyz', max), 'utf8') <= max, true)
  }
})

test('truncateUtf8：maxBytes 不足一个码点或非法时返回空串', () => {
  assert.equal(truncateUtf8('汉字', 2), '')
  assert.equal(truncateUtf8('汉字', 0), '')
  assert.equal(truncateUtf8('汉字', -5), '')
  assert.equal(truncateUtf8('汉字', Number.NaN), '')
  // 非有限数当"没有有效上限"处理：宁可放弃调用（null -> 回退 A），也不要放一个无界输入出去
  assert.equal(truncateUtf8('汉字', Number.POSITIVE_INFINITY), '')
  assert.equal(truncateUtf8(null, 100), '')
  assert.equal(truncateUtf8('', 100), '')
})

test('cleanTitle：代码围栏/换行/引号/标题前缀/句末句号/超长', () => {
  assert.equal(cleanTitle('```\n插件启停面板\n```'), '插件启停面板')
  assert.equal(cleanTitle('  "会话标题生成"  '), '会话标题生成')
  assert.equal(cleanTitle('“会话标题生成”'), '会话标题生成')
  assert.equal(cleanTitle('「会话标题生成」'), '会话标题生成')
  assert.equal(cleanTitle('标题：会话标题生成'), '会话标题生成')
  assert.equal(cleanTitle('Title: Session title generation'), 'Session title generation')
  assert.equal(cleanTitle('会话标题生成。'), '会话标题生成')
  assert.equal(cleanTitle('会话标题生成.'), '会话标题生成')
  assert.equal(cleanTitle('第一行标题\n第二行是多余的解释'), '第一行标题')
  assert.equal(cleanTitle('  多个   空格   压成一格  '), '多个 空格 压成一格')
  // 引号 + Markdown 前缀叠加时要两个都剥掉
  assert.equal(cleanTitle('"## 会话标题生成"'), '会话标题生成')
  assert.equal(cleanTitle('# 会话标题生成'), '会话标题生成')
  // 超长不在这里截断（长度上限交给 title.js 的 truncateTitle）
  const long = '很长的标题'.repeat(30)
  assert.equal(cleanTitle(long), long)
  // 空/坏输入
  assert.equal(cleanTitle('   '), '')
  assert.equal(cleanTitle('"```"'), '')
  assert.equal(cleanTitle(null), '')
})

test('正常流：分片文本拼成标题，且 options 形状正确', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    textDelta('插件', 0),
    textDelta('启停面板', 0),
    { type: 'block-end', index: 0, block: { type: 'text', text: '插件启停面板' } },
    stop,
  ])
  const title = await generateTitleWithLlm(llm, summary, { ...route, sessionId: 'session-1' })
  assert.equal(title, '插件启停面板')
  assert.equal(llm.calls.length, 1)

  const options = llm.calls[0]
  assert.equal(options.provider, 'deepseek-official')
  assert.equal(options.model, 'deepseek-flash')
  assert.equal(options.maxTokens, LLM_TITLE_DEFAULTS.maxOutputTokens)
  assert.equal(options.purpose, 'session-title')
  assert.equal(options.sessionId, 'session-1')
  assert.equal(typeof options.system, 'string')
  assert.equal(options.system.length > 0, true)
  assert.ok(options.signal instanceof AbortSignal)
  // 消息形状：单条 user 消息，content 是 text 块
  assert.equal(Array.isArray(options.messages), true)
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  assert.equal(Array.isArray(options.messages[0].content), true)
  assert.deepEqual(Object.keys(options.messages[0].content[0]).sort(), ['text', 'type'])
  assert.equal(options.messages[0].content[0].type, 'text')

  // system + 正文的字节数必须落在 maxInputBytes 之内
  const total = Buffer.byteLength(options.system, 'utf8') + Buffer.byteLength(options.messages[0].content[0].text, 'utf8')
  assert.equal(total <= LLM_TITLE_DEFAULTS.maxInputBytes, true)
})

test('正常流：没有 block-end 时用 text-delta 拼；reasoning 不计入标题', async () => {
  const llm = fakeLlm([
    { type: 'reasoning-delta', index: 0, text: '这是思考过程，不能当标题' },
    textDelta('插件启停面板', 1),
    stop,
  ])
  assert.equal(await generateTitleWithLlm(llm, summary, route), '插件启停面板')
})

test('超长总结：正文被截断，system+正文仍不超 maxInputBytes', async () => {
  const huge = [{ type: 'text', text: '## Primary Request and Intent\n' + '很长的正文内容。'.repeat(1200) }]
  assert.equal(Buffer.byteLength(huge[0].text, 'utf8') > 13000, true)
  const llm = fakeLlm([textDelta('截断后的标题'), stop])
  assert.equal(await generateTitleWithLlm(llm, huge, route), '截断后的标题')
  const options = llm.calls[0]
  const total = Buffer.byteLength(options.system, 'utf8') + Buffer.byteLength(options.messages[0].content[0].text, 'utf8')
  assert.equal(total <= LLM_TITLE_DEFAULTS.maxInputBytes, true)
})

test('options 覆盖默认值；缺字段回落默认', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  // 预算要留得下 system 指令，否则会（正确地）直接放弃调用
  const probe = fakeLlm([stop])
  await generateTitleWithLlm(probe, summary, route)
  const systemBytes = Buffer.byteLength(probe.calls[0].system, 'utf8')
  const maxInputBytes = systemBytes + 120
  await generateTitleWithLlm(llm, summary, { ...route, maxOutputTokens: 12, maxInputBytes, timeoutMs: 5000 })
  const options = llm.calls[0]
  assert.equal(options.maxTokens, 12)
  assert.equal(options.maxInputBytes, undefined) // 不是 llm 的字段，不该泄漏进去
  assert.equal(options.purpose, 'session-title')
  assert.equal(Buffer.byteLength(options.system, 'utf8') + Buffer.byteLength(options.messages[0].content[0].text, 'utf8') <= maxInputBytes, true)
})

test('失败面：一律 null', async () => {
  // 终端 error finish chunk（宿主把适配器失败规范化成的形态）
  const errored = fakeLlm([
    textDelta('半截'),
    { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT' } } },
  ])
  assert.equal(await generateTitleWithLlm(errored, summary, route), null)

  // aborted
  const aborted = fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'gone', code: 'ABORTED' } } }])
  assert.equal(await generateTitleWithLlm(aborted, summary, route), null)

  // max-tokens（截断的输出不可信）
  const maxTokens = fakeLlm([textDelta('被截断的标'), { type: 'finish', reason: { kind: 'max-tokens' } }])
  assert.equal(await generateTitleWithLlm(maxTokens, summary, route), null)

  // tool-calls finish
  const toolCalls = fakeLlm([{ type: 'finish', reason: { kind: 'tool-calls' } }])
  assert.equal(await generateTitleWithLlm(toolCalls, summary, route), null)

  // stream 本身直接 throw（同步 throw）
  const syncThrow = {
    stream() {
      throw new Error('no adapter')
    },
  }
  assert.equal(await generateTitleWithLlm(syncThrow, summary, route), null)

  // 迭代中途 throw
  const midThrow = {
    stream() {
      return (async function* () {
        yield textDelta('前缀')
        throw new Error('stream broke')
      })()
    },
  }
  assert.equal(await generateTitleWithLlm(midThrow, summary, route), null)

  // 返回空文本
  const emptyText = fakeLlm([textDelta('   '), stop])
  assert.equal(await generateTitleWithLlm(emptyText, summary, route), null)
  const noText = fakeLlm([stop])
  assert.equal(await generateTitleWithLlm(noText, summary, route), null)
  // 只有代码围栏，清洗后为空
  const fenceOnly = fakeLlm([textDelta('```\n```'), stop])
  assert.equal(await generateTitleWithLlm(fenceOnly, summary, route), null)

  // 模型跑去调工具了
  const toolBlock = fakeLlm([
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 't1', name: 'x', arguments: '{}' } },
    stop,
  ])
  assert.equal(await generateTitleWithLlm(toolBlock, summary, route), null)
})

test('失败面：入参与前置条件不满足时 null，且不碰 llm', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  // 没配路由
  assert.equal(await generateTitleWithLlm(llm, summary), null)
  assert.equal(await generateTitleWithLlm(llm, summary, { provider: 'x', model: '' }), null)
  // 没有可用的 llm 服务
  assert.equal(await generateTitleWithLlm(null, summary, route), null)
  assert.equal(await generateTitleWithLlm({}, summary, route), null)
  // 总结里没有文本
  assert.equal(await generateTitleWithLlm(llm, [], route), null)
  assert.equal(await generateTitleWithLlm(llm, [{ type: 'image' }], route), null)
  // maxInputBytes 小到装不下 system
  assert.equal(await generateTitleWithLlm(llm, summary, { ...route, maxInputBytes: 10 }), null)
  assert.equal(llm.calls.length, 0)
})

test('取消与超时：调用方的 signal 已 aborted，或流太慢触发 timeoutMs，都返回 null', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  const controller = new AbortController()
  controller.abort()
  assert.equal(await generateTitleWithLlm(llm, summary, { ...route, signal: controller.signal }), null)
  assert.equal(llm.calls.length, 0)

  const slow = {
    calls: [],
    stream(options) {
      this.calls.push(options)
      return (async function* () {
        await new Promise((resolve) => setTimeout(resolve, 150))
        yield textDelta('慢到的标题')
        yield stop
      })()
    },
  }
  assert.equal(await generateTitleWithLlm(slow, summary, { ...route, timeoutMs: 20 }), null)
})

test('sessionId：给了就带上，没给不带这个字段', async () => {
  const withId = fakeLlm([textDelta('标题'), stop])
  await generateTitleWithLlm(withId, summary, { ...route, sessionId: 's-9' })
  assert.equal(withId.calls[0].sessionId, 's-9')

  const without = fakeLlm([textDelta('标题'), stop])
  await generateTitleWithLlm(without, summary, route)
  assert.equal('sessionId' in without.calls[0], false)
})

test('最近用户消息：summary 后追加一块，system 改按用户消息语言并强调当下焦点', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  const title = await generateTitleWithLlm(llm, SUMMARY_EN, { ...route, recentUserMessages: ['我想开发一个插件，能随时启停 skill 和 MCP'] })
  assert.equal(title, '标题')
  const options = llm.calls[0]
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].content.length, 2)
  assert.deepEqual(options.messages[0].content.map((block) => block.type), ['text', 'text'])
  assert.equal(options.messages[0].content[1].text.includes('我想开发一个插件'), true)
  assert.equal(/same natural language as the user messages/.test(options.system), true)
  assert.equal(/Use the language of the summary\./.test(options.system), false)
  assert.equal(/title the current focus/.test(options.system), true)
})

test('最近用户消息：没有时保持旧行为（单块 + 跟随总结语言 + 不提焦点）', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  await generateTitleWithLlm(llm, SUMMARY_EN, route)
  const options = llm.calls[0]
  assert.equal(options.messages[0].content.length, 1)
  assert.equal(/Use the language of the summary/.test(options.system), true)
  assert.equal(/current focus/.test(options.system), false)
})

test('最近用户消息：最多带 3 条且按时间顺序，超长被截断', async () => {
  const llm = fakeLlm([textDelta('标题'), stop])
  await generateTitleWithLlm(llm, SUMMARY_EN, {
    ...route,
    recentUserMessages: ['第一条', '第二条', '第三条', '第四条'],
  })
  const block = llm.calls[0].messages[0].content[1].text
  // 只保留最近三条：最新的一条必须在，最早的一条必须被挤掉
  assert.equal(block.includes('第四条'), true)
  assert.equal(block.includes('第三条'), true)
  assert.equal(block.includes('第二条'), true)
  assert.equal(block.includes('第一条'), false)

  const huge = '这是用户原话。'.repeat(400)
  const second = fakeLlm([textDelta('标题'), stop])
  await generateTitleWithLlm(second, SUMMARY_EN, { ...route, recentUserMessages: [huge] })
  const content = second.calls[0].messages[0].content
  const total = Buffer.byteLength(second.calls[0].system, 'utf8')
    + content.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)
  assert.equal(total <= LLM_TITLE_DEFAULTS.maxInputBytes, true)
  assert.equal(content[1].text.length < huge.length, true)
})

test('最近用户消息：空串与非字符串被忽略，不会白占一块', async () => {
  const blank = fakeLlm([stop])
  await generateTitleWithLlm(blank, SUMMARY_EN, { ...route, recentUserMessages: ['   ', 42, null] })
  assert.equal(blank.calls[0].messages[0].content.length, 1)
})
