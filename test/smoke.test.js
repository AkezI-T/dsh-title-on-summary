// 骨架冒烟：只验证"挂载声明"这一层——package.json 的 patch 引用、cordis.patch.yml 里 insert 的 id/name。
// 行为实现（lib/index.js 对应的 src/index.js）不在这一层断言，本文件不替它做假设。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 取 YAML 里某个键的值（只认 `key: value` 这一种写法，够本文件用，不引 YAML 依赖）。 */
function fieldValues(text, key) {
  const out = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (line.startsWith('- ')) line = line.slice(2).trim()
    if (line.startsWith(key + ':')) out.push(line.slice(key.length + 1).trim())
  }
  return out
}

test('骨架：dsh.bundle.patch 指向存在的文件，且 insert 的 id/name 与包名一致', async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))

  const patchRef = pkg.dsh && pkg.dsh.bundle ? pkg.dsh.bundle.patch : undefined
  assert.equal(typeof patchRef, 'string', 'package.json 必须声明 dsh.bundle.patch')
  assert.ok(patchRef.startsWith('./'), 'patch 路径要相对包根书写，实际是：' + patchRef)

  // 文件不存在时 readFile 会直接抛错——这就是"指向存在的文件"这条断言。
  const patch = await readFile(path.join(ROOT, patchRef), 'utf8')

  assert.ok(
    patch.split('\n').some((line) => line.trim().startsWith('- insert:')),
    'cordis.patch.yml 里要有 insert 段',
  )
  assert.deepEqual(fieldValues(patch, 'id'), [pkg.name], 'insert 的 id 必须与包名一致')
  assert.deepEqual(fieldValues(patch, 'name'), [pkg.name], 'insert 的 name 必须与包名一致')
})
