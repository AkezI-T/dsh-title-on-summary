# dsh-title-on-summary

DSH 插件：**会话每次被"总结"（上下文压缩）之后，把它的名称更新成"现在在讲什么"**。

## 它怎么工作

1. 订阅 `session/event`，只认 `compaction/summary`（一次成功总结恰好一次的信号）。
2. 决定标题，**两条路径，C 为主 A 兜底**：
   - **C（模型生成）**：把总结 + 该会话**最近三条真实用户消息**喂给一次辅助 LLM 调用，让模型写一行标题
     （跳过 "Primary Request and Intent" 这类结构性小标题）。需要配 `llm.provider` + `llm.model`
     才真的能调。最近消息同时承担两件事：**标题语言**跟随它们（总结固定是英文），以及告诉模型
     **当下焦点**——总结覆盖整段会话，开头一节永远是"最初意图"。
   - **A（本地派生）**：C 拿不到标题时（没配路由 / 超时 / 模型返回空 / 适配器报错）落回本地：
     先找总结里"描述当下"的那一节（`## Current Work` / `## Next Step` / `## Pending Jobs`，
     也认 `当前工作`/`下一步`/`待办` 等中文小节名）取第一句散文；没有这种小节才退回全文第一句。
     一路跳过 markdown 标题 / 表格 / 代码围栏 / "xxx："标签行 / `(none)` 占位行。
     总结是英文而用户消息是中文时，改用用户原文派生，避免标题变成英文。
   两条路径共用同一个 `maxLength`（默认 32 字符，在标点或空格处断句）。
3. 标题与当前相同则跳过；否则 `ctx.sessionTitle.rename(session, title)`。
4. 改名失败**只记一条 warning**，绝不影响会话。

**失败语义：标题停在旧值。** C 的任何失败都退化成 A，A 也产不出标题就干脆不改名 ——
三种情况都不会写坏标题、都不会影响会话本身。

### 标题语言

宿主的压缩总结由 `dsh-compaction-basic` 强制写成英文，所以插件不依赖总结的语言：每次总结前记下该会话
最近三条真实用户消息，交给模型当语言依据与当下焦点；本地兜底也会在语言不一致时改用用户原文。
压缩产生的 checkpoint 消息（正文固定英文）不会被当成用户消息。

### 为什么不用 `refresh()`

`refresh()` 每次要花一次辅助 LLM 调用，而**本机安装的标题 provider 只把"会话第一条人类消息"喂给模型**
（`dsh-session-title-first-prompt-llm`）—— 每次总结都 refresh 等于每次白烧一次调用、标题还几乎不变。
我们确实要模型参与（C），但**总结正文必须进模型**才值这一次调用，所以自己调 `ctx.llm.stream`、
拿到标题后用 `rename` 落盘。

> 注意：`rename` 会**钉住**标题，之后 DSH 不再为该会话自动生成标题。这正是"以总结为准"想要的效果；
> 想恢复自动生成，用命令/面板重新刷新标题即可。

## 安装

```bash
git clone https://github.com/AkezI-T/dsh-title-on-summary.git
cd dsh-title-on-summary
dsh plugin --profile desktop add .   # profile 名以 ~/.dsh/profiles 下的目录名为准（Web 端是 web）
```

仓库里带 `lib/`（构建产物），clone 下来即可加载，不需要先构建。装完需要重启一次 DSH（loader 树要重新组合）。

## 配置

```yaml
- id: dsh-title-on-summary
  name: dsh-title-on-summary
  config:
    enabled: true
    titleSource: llm        # llm（默认，模型生成失败落本地）| local（只本地派生）
    maxLength: 32
    minLength: 4
    llm:
      provider: deepseek-official   # 与 model 一起填才真正能调；留空 ⇒ 直接走本地派生
      model: deepseek-flash
      maxInputBytes: 4096
      maxOutputTokens: 4096       # 跑飞保护，不是目标长度：推理 token 也算在这里
      timeoutMs: 60000
      targetWords: 5
      targetCjkCharacters: 10
```

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不订阅、也不注入服务 |
| `titleSource` | `llm` | `llm`：先让模型写标题，失败落回本地；`local`：只本地派生，零调用 |
| `maxLength` | `32` | 标题字符上限（CJK 按 1 字符算），两条路径共用；服务端 `maxTitleBytes`(80 字节) 仍是硬上限 |
| `minLength` | `4` | 低于此长度的散文行不当标题 |
| `llm.provider` / `llm.model` | 空 | **两个都填**才真的调模型；任缺一个就静默走本地派生 |
| `llm.maxInputBytes` | `4096` | 送进模型前对总结文本的 UTF-8 字节上限（超了按码点边界截断） |
| `llm.maxOutputTokens` | `4096` | 模型输出上限（跑飞保护，不是目标长度；推理路由的思考 token 也计入，给太小会静默回退本地派生） |
| `llm.timeoutMs` | `60000` | 单次调用超时；超时按"拿不到标题"处理 |
| `llm.targetWords` / `llm.targetCjkCharacters` | `5` / `10` | 提示词里的目标长度 |

## 开发

```bash
bash scripts/build.sh   # src/ → lib/
node --test             # 全部用例
```

行为契约由 `test/` 下的用例固定。
