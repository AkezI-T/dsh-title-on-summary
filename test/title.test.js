/**
 * 标题派生策略单测：纯函数，不依赖 DSH 运行时。
 * 重点在"宁可放弃改名，也不要写一个坏标题"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanLine,
  deriveTitle,
  firstQuotedSpan,
  isProseLine,
  stripLabelPrefix,
  textBlocksToPlainText,
  truncateTitle,
} from '../src/title.js'

test('textBlocksToPlainText：只取 text 块，忽略其它类型与坏数据', () => {
  assert.equal(textBlocksToPlainText([{ type: 'text', text: '甲' }, { type: 'image' }, null, 'x']), '甲')
  assert.equal(textBlocksToPlainText([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲\n乙')
  assert.equal(textBlocksToPlainText(null), '')
  assert.equal(textBlocksToPlainText('not-array'), '')
})

test('cleanLine：去掉列表符号与行内装饰、压掉空白', () => {
  assert.equal(cleanLine('- **插件**开关面板'), '插件开关面板')
  assert.equal(cleanLine('1.   多个   空格'), '多个 空格')
  assert.equal(cleanLine('  普通行  '), '普通行')
  assert.equal(cleanLine(null), '')
})

test('isProseLine：标题/表格/引用/分隔线/纯标签行都不算散文', () => {
  assert.equal(isProseLine('## 主要请求与意图'), false)
  assert.equal(isProseLine('| a | b |'), false)
  assert.equal(isProseLine('|---|---|'), false)
  assert.equal(isProseLine('> 引用'), false)
  assert.equal(isProseLine('-----'), false)
  assert.equal(isProseLine('主要请求与意图：'), false)
  assert.equal(isProseLine('12345'), false)
  assert.equal(isProseLine('这是一句人话'), true)
  assert.equal(isProseLine('a normal sentence'), true)
})

test('truncateTitle：优先在标点或空格处断句，不在词中间切', () => {
  assert.equal(truncateTitle('短标题', 24), '短标题')
  // 24 字符处正好落在 "和 M" 中间 → 退到 "和" 后的空格
  assert.equal(truncateTitle('我想开发一个插件，能随时启停 skill 和 MCP，显示信息', 24), '我想开发一个插件，能随时启停 skill 和…')
  // 断点太靠前（不到一半）就硬截；省略号也算在 maxLength 内，结果不得超过 8 个字符
  assert.equal(truncateTitle('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯', 8), '一二三四五六七…')
  assert.equal(truncateTitle('一二三四五六七八九十甲乙丙丁戊己庚辛壬癸子丑寅卯', 8).length, 8)
})

test('deriveTitle：没有当下小节时跳过标题行，取第一句散文', () => {
  const blocks = [{ type: 'text', text: '## 主要请求与意图\n我想开发一个插件，能随时启停 skill 和 MCP，显示它们的信息。' }]
  assert.equal(deriveTitle(blocks), '我想开发一个插件，能随时启停 skill 和 MCP…')
})

test('deriveTitle：跳过"xxx："这种纯标签行', () => {
  const blocks = [{ type: 'text', text: '主要请求与意图：\n用户要求把技能开关做成面板。' }]
  assert.equal(deriveTitle(blocks), '用户要求把技能开关做成面板。')
})

test('deriveTitle：清理列表符号与强调标记', () => {
  assert.equal(deriveTitle([{ type: 'text', text: '- **插件**开关面板\n- 第二条' }]), '插件开关面板')
})

test('deriveTitle：代码围栏内的内容不当标题', () => {
  const text = '| a | b |\n|---|---|\n\`\`\`js\nconst x = 1\n\`\`\`\n真正的标题在这里'
  assert.equal(deriveTitle([{ type: 'text', text }]), '真正的标题在这里')
})

test('deriveTitle：多个文本块按顺序拼起来找', () => {
  assert.equal(deriveTitle([{ type: 'text', text: '## A' }, { type: 'text', text: '第二块的散文内容' }]), '第二块的散文内容')
})

test('deriveTitle：找不到合适散文时返回 null（调用方应放弃改名，别写坏标题）', () => {
  assert.equal(deriveTitle([{ type: 'text', text: '## 标题\n嗯。' }]), null)
  assert.equal(deriveTitle([{ type: 'text', text: '# 一\n## 二' }]), null)
  assert.equal(deriveTitle(null), null)
  assert.equal(deriveTitle([]), null)
  assert.equal(deriveTitle([{ type: 'image', data: 'x' }]), null)
})

test('deriveTitle：maxLength / minLength 可配，坏配置回落到默认', () => {
  const blocks = [{ type: 'text', text: '用户要求把技能开关做成面板' }]
  assert.equal(deriveTitle(blocks, { maxLength: 8 }), '用户要求把技能…')
  assert.equal(deriveTitle(blocks, { minLength: 999 }), null)
  assert.ok(deriveTitle(blocks, { maxLength: 0, minLength: -1 }).length > 0, '坏配置回落默认而不是崩')
})

test('deriveTitle：跳过 <compacted-summary> 这类整行包装标签', () => {
  const blocks = [{ type: 'text', text: '<compacted-summary>\n## 主要请求与意图\n用户要求把技能开关做成面板。' }]
  assert.equal(deriveTitle(blocks), '用户要求把技能开关做成面板。')
})

test('deriveTitle：优先取第一条引文（真实总结的首行是 "Original: " 那句原始需求）', () => {
  const text = '## Primary Request and Intent\n- Original: "我想开发一个插件，能随时启停skill和mcp，显示skill和mcp的信息，先规划" — build a DSH plugin.'
  assert.equal(deriveTitle([{ type: 'text', text }]), '我想开发一个插件，能随时启停skill和mcp…')
})

test('deriveTitle：没有引文时去掉 "Original (plugin #1): " 这类前缀标签', () => {
  assert.equal(deriveTitle([{ type: 'text', text: 'Original (plugin #1): 把总结触发的改名做出来' }]), '把总结触发的改名做出来')
})

test('deriveTitle：优先取 Current Work 小节，而不是开头的 Primary Request and Intent', () => {
  const text = [
    '## Primary Request and Intent',
    '- Build LanWeave as an autonomous network operations system with real evidence.',
    '## Key Technical Concepts',
    '- Cordis plugin tree.',
    '## Current Work',
    '- Wiring the daycycle plugin into the session title service.',
    '## Next Step',
    '- Write the README.',
  ].join('\n')
  // 32 字符上限：切在 "into" 后的空格
  assert.equal(deriveTitle([{ type: 'text', text }]), 'Wiring the daycycle plugin into…')
})

test('deriveTitle：没有 Current Work 时退到 Next Step，再没有才退回全文第一句', () => {
  const nextOnly = '## Primary Request and Intent\n- 最初的需求\n## Next Step\n- 补 README 并跑构建'
  assert.equal(deriveTitle([{ type: 'text', text: nextOnly }]), '补 README 并跑构建')
  const plain = '## Primary Request and Intent\n- 最初的需求\n## Critical Context\n- 某条决策'
  assert.equal(deriveTitle([{ type: 'text', text: plain }]), '最初的需求')
})

test('deriveTitle：中文小节名（当前工作）同样优先', () => {
  const text = '## 主要请求与意图\n- 最早的需求\n## 当前工作\n- 正在把标题服务接进插件'
  assert.equal(deriveTitle([{ type: 'text', text }]), '正在把标题服务接进插件')
})

test('deriveTitle：Current Work 是 (none) 时不拿占位符当标题', () => {
  const text = '## Primary Request and Intent\n- 把总结触发的改名做出来\n## Current Work\n- (none)'
  assert.equal(deriveTitle([{ type: 'text', text }]), '把总结触发的改名做出来')
  assert.equal(isProseLine('(none)'), false)
  assert.equal(isProseLine('（无）'), false)
})

test('firstQuotedSpan / stripLabelPrefix：边界', () => {
  assert.equal(firstQuotedSpan('没有引文', 4), '')
  assert.equal(firstQuotedSpan('"短"', 4), '')
  assert.equal(firstQuotedSpan('“中文引号也要认”', 4), '中文引号也要认')
  assert.equal(firstQuotedSpan(null, 4), '')
  assert.equal(stripLabelPrefix('没有冒号'), '没有冒号')
})
