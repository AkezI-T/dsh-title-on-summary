/**
 * 插件集成测试：假 ctx + 假 sessionTitle，验证"总结事件 → 改名"这条链路与全部守卫。
 * 这些用例锁的是**不能出事**：监听器抛错会影响会话，改名失败绝不能外溢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apply, inject, name } from '../src/index.js'

const SUMMARY = [{ type: 'text', text: '## 主要请求与意图\n我想开发一个插件，能随时启停 skill 和 MCP，显示它们的信息。' }]
const EXPECTED = '我想开发一个插件，能随时启停 skill 和 MCP…'

function boot(options = {}) {
  const listeners = new Map()
  const warnings = []
  const injected = []
  const ctx = {
    inject(names, callback) {
      injected.push(names)
      callback({ sessionTitle: options.sessionTitle, llm: options.llm })
    },
    on(type, handler) {
      const list = listeners.get(type) ?? []
      list.push(handler)
      listeners.set(type, list)
    },
    logger: { warn(message) { warnings.push(message) } },
  }
  apply(ctx, options.config)
  const emit = (session, event) => {
    for (const handler of listeners.get('session/event') ?? []) handler(session, event)
  }
  const emitType = (type, session, event) => {
    for (const handler of listeners.get(type) ?? []) handler(session, event)
  }
  return { listeners, warnings, injected, emit, emitType }
}

/**
 * 假 llm：按 llm-title.js 认的 chunk 协议吐一次流。
 * 真实实现只有拿到非空 provider+model 才会调 stream，所以用它的用例都要带 LLM_CONFIG。
 */
function fakeLlm(text, { reason = { kind: 'stop' } } = {}) {
  const calls = []
  return {
    calls,
    stream(request) {
      calls.push(request)
      const chunks = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text },
        { type: 'block-end', index: 0, block: { type: 'text', text } },
        { type: 'finish', reason },
      ]
      return (async function* generate() {
        for (const chunk of chunks) yield chunk
      })()
    },
  }
}

const LLM_CONFIG = { llm: { provider: 'test-provider', model: 'test-model' } }

function fakeTitleService(initialTitle = '旧标题') {
  const calls = []
  return {
    calls,
    get() { return { title: initialTitle } },
    rename(session, title) { calls.push([session, title]); return { title } },
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('模块契约：name 与 package.json 一致，且不强制依赖任何服务', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(name, pkg.name)
  assert.deepEqual(inject, [], '服务用延迟注入，缺了也不能拦挂载')
})

test('总结事件 → 用总结里的散文改名', async () => {
  const sessionTitle = fakeTitleService()
  const session = { id: 's1' }
  const { emit, injected } = boot({ sessionTitle })
  assert.deepEqual(injected, [['sessionTitle'], ['llm']], '两个服务都走延迟注入，谁都不许拦挂载')
  emit(session, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.equal(sessionTitle.calls.length, 1)
  assert.equal(sessionTitle.calls[0][0], session)
  assert.equal(sessionTitle.calls[0][1], EXPECTED)
})

test('C 路径：llm 可用时用模型写的标题改名', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型写的标题')
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), ['模型写的标题'])
  // 路由与 sessionId 都要真的传下去，否则这次调用挂不到会话上
  assert.equal(llm.calls.length, 1)
  assert.equal(llm.calls[0].provider, 'test-provider')
  assert.equal(llm.calls[0].model, 'test-model')
  assert.equal(llm.calls[0].sessionId, 's1')
  // 推理路由的思考 token 也计入 maxTokens，64 会让标题请求被截断后静默回退
  assert.equal(llm.calls[0].maxTokens, 4096)
})

test('C 路径的标题同样受 maxLength 约束（两条路径共用一个上限）', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('这是一个非常长的模型标题，长到必须被截断')
  const { emit } = boot({ sessionTitle, llm, config: { ...LLM_CONFIG, maxLength: 8 } })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), ['这是一个非常长…'])
})

test('C 拿不到标题（finish 不是 stop）→ 落回 A 本地派生', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型写的标题', { reason: { kind: 'error' } })
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), [EXPECTED])
})

test('titleSource=local：完全不碰 llm', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型写的标题')
  const { emit } = boot({ sessionTitle, llm, config: { ...LLM_CONFIG, titleSource: 'local' } })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.equal(llm.calls.length, 0)
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), [EXPECTED])
})

test('llm 抛错也照样改名（落回 A），绝不把异常漏到会话上', async () => {
  const sessionTitle = fakeTitleService()
  const llm = {
    stream() {
      throw new Error('adapter exploded')
    },
  }
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  assert.doesNotThrow(() => emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } }))
  await tick()
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), [EXPECTED])
})

test('模型没配路由（provider/model 为空）时一次调用都不发，直接走 A', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型写的标题')
  const { emit } = boot({ sessionTitle, llm })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.equal(llm.calls.length, 0)
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), [EXPECTED])
})

test('同标题短路在 C 路径上同样生效（调了模型，但不写重复事件）', async () => {
  const sessionTitle = fakeTitleService('模型写的标题')
  const llm = fakeLlm('模型写的标题')
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.equal(llm.calls.length, 1)
  assert.equal(sessionTitle.calls.length, 0)
})

test('非总结事件一律忽略（含 compaction/start、end、summary-error 与无关事件）', async () => {
  const sessionTitle = fakeTitleService()
  const { emit } = boot({ sessionTitle })
  for (const type of ['compaction/start', 'compaction/end', 'compaction/summary-error', 'user/message', 'session/title']) {
    emit({ id: 's1' }, { type, data: { summary: SUMMARY } })
  }
  await tick()
  assert.equal(sessionTitle.calls.length, 0)
})

test('标题没变就不写：避免每次总结都多一条无意义事件', async () => {
  const sessionTitle = fakeTitleService(EXPECTED)
  const { emit } = boot({ sessionTitle })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.equal(sessionTitle.calls.length, 0)
})

test('派生不出标题时放弃改名（宁可不改，也不写坏标题）', async () => {
  const sessionTitle = fakeTitleService()
  const { emit } = boot({ sessionTitle })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '## 一\n嗯。' }] } })
  emit({ id: 's1' }, { type: 'compaction/summary', data: {} })
  emit({ id: 's1' }, { type: 'compaction/summary' })
  await tick()
  assert.equal(sessionTitle.calls.length, 0)
})

test('rename 抛错不影响会话，只记一条 warning', async () => {
  const sessionTitle = {
    get() { return { title: '旧' } },
    rename() { throw new Error('session is not live') },
  }
  const { emit, warnings } = boot({ sessionTitle })
  assert.doesNotThrow(() => emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } }))
  await tick()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /rename failed: session is not live/)
})

test('get() 抛错也不影响改名', async () => {
  const calls = []
  const sessionTitle = {
    get() { throw new Error('not live') },
    rename(session, title) { calls.push(title); return { title } },
  }
  const { emit } = boot({ sessionTitle })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.deepEqual(calls, [EXPECTED])
})

test('服务缺失或形状不对时安静退出，不抛错', async () => {
  for (const sessionTitle of [undefined, null, {}, { rename: 'not-a-function' }]) {
    const { emit } = boot({ sessionTitle })
    assert.doesNotThrow(() => emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } }))
    await tick()
  }
})

test('config.enabled=false：完全不订阅也不注入', () => {
  const { listeners, injected } = boot({ config: { enabled: false }, sessionTitle: fakeTitleService() })
  assert.equal(listeners.size, 0)
  assert.equal(injected.length, 0)
})

test('config.maxLength 生效', async () => {
  const sessionTitle = fakeTitleService()
  const { emit } = boot({ sessionTitle, config: { maxLength: 8 } })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  await tick()
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), ['我想开发一个插…'])
})

test('多个会话各自改名，互不影响', async () => {
  const sessionTitle = fakeTitleService()
  const { emit } = boot({ sessionTitle })
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY } })
  emit({ id: 's2' }, { type: 'compaction/summary', data: { summary: [{ type: 'text', text: '另一个会话在做别的事情' }] } })
  await tick()
  assert.equal(sessionTitle.calls.length, 2)
  assert.deepEqual(sessionTitle.calls.map((call) => call[0].id), ['s1', 's2'])
})

const SUMMARY_EN = [{ type: 'text', text: '## Primary Request and Intent\n- Build LanWeave as an autonomous network operations system with real evidence.' }]
const USER_ZH = '我想开发一个插件，能随时启停 skill 和 MCP。'

function userMessage(text, kind = 'user') {
  return { type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } }
}

test('语言锚点：总结前记下的用户原文会随 LLM 调用一起传下去', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型标题')
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, userMessage(USER_ZH))
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY_EN } })
  await tick()
  assert.equal(llm.calls.length, 1)
  // 锚点被转成请求里的第二个文本块（generateTitleWithLlm 不会把 options 原样塞进请求）
  assert.equal(llm.calls[0].messages[0].content.length, 2)
  assert.equal(llm.calls[0].messages[0].content[1].text.includes(USER_ZH), true)
  assert.deepEqual(sessionTitle.calls.map((call) => call[1]), ['模型标题'])
})

test('语言锚点：compact-checkpoint 消息不算用户原文', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型标题')
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, userMessage('This is an automatically generated checkpoint condensing an earlier span of the conversation.', 'compact-checkpoint'))
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY_EN } })
  await tick()
  assert.equal(llm.calls[0].messages[0].content.length, 1)
})

test('语言锚点：summary 是英文时本地兜底改用用户原文派生（中文）', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型标题', { reason: { kind: 'error' } })
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, userMessage(USER_ZH))
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY_EN } })
  await tick()
  const title = sessionTitle.calls[0][1]
  assert.match(title, /[\u3400-\u9fff]/)
  assert.equal(/Primary Request|LanWeave|autonomous/.test(title), false)
})

test('语言锚点：会话销毁后不再沿用旧锚点', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型标题')
  const { emit, emitType } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  emit({ id: 's1' }, userMessage(USER_ZH))
  emitType('session/disposed', { id: 's1' }, {})
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY_EN } })
  await tick()
  assert.equal(llm.calls[0].messages[0].content.length, 1)
})

test('最近用户消息：只带最后三条，且按时间顺序（最早一条被挤掉）', async () => {
  const sessionTitle = fakeTitleService()
  const llm = fakeLlm('模型标题')
  const { emit } = boot({ sessionTitle, llm, config: LLM_CONFIG })
  for (const text of ['第一条需求', '第二条需求', '第三条需求', '第四条需求']) emit({ id: 's1' }, userMessage(text))
  emit({ id: 's1' }, { type: 'compaction/summary', data: { summary: SUMMARY_EN } })
  await tick()
  const block = llm.calls[0].messages[0].content[1].text
  assert.equal(block.includes('第四条需求'), true)
  assert.equal(block.includes('第二条需求'), true)
  assert.equal(block.includes('第一条需求'), false)
  assert.ok(block.indexOf('第二条需求') < block.indexOf('第四条需求'), '按时间顺序排列')
})
