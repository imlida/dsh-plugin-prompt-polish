# 提示词润色 · dsh-plugin-prompt-polish

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的提示词输入框加一个**润色按钮**：写好草稿后点一下，模型把它改写成更清晰、更完整的提示词，直接替换回输入框。润色用的提示词（system prompt）**随时可以自己改**，不写死。

```
┌─ 输入框 ───────────────────────────────────────────────────┐
│ 帮我弄个插件 加个按钮 润色                                  │
│                                                            │
│                [ ✨润色 ] [ ↻撤销 ] [ ⚙设置 ]   [模型] [发送] │
└────────────────────────────────────────────────────────────┘
```

## 功能

| 操作 | 结果 |
| --- | --- |
| 点 **✨ 润色** | 把当前草稿交给模型改写，成功后整段替换回输入框 |
| 点 **↻ 撤销** | 把润色前的原文写回去（只在草稿没被你再改过时出现） |
| 点 **⚙ 设置** | 打开设置面板，修改「润色用的提示词」，可一键恢复默认 |
| 输入框为空 | 按钮置灰 |
| 正在提交 | 按钮置灰 |
| 润色中 | 图标转圈，按钮禁用 |

润色是**一次性补全**：借用你当前的默认模型，但不会写进任何会话历史，所以不污染上下文，也不影响 KV 缓存。

真实效果示例：

> 输入：`帮我弄个插件，在输入框那加个按钮，点了能润色我写的东西，还要能改润色用的提示词`
>
> 输出：
> ```
> 帮我实现一个插件，在输入框那里加一个按钮。
>
> **目标**
> 1. 在输入框区域添加一个按钮。
> 2. 点击该按钮后，对我在输入框里写的内容进行润色。
> 3. 润色所用的提示词要可以修改，我需要能自己改。
>
> **验收标准**
> - 输入框处能看到并点击这个按钮。
> - 点击后能对我输入的内容执行润色。
> - 能修改润色使用的提示词，并且改完之后生效。
> ```

## 安装

### 方式一：从插件界面安装（推荐）

1. 打开 **设置 → 插件 → 添加插件**
2. 填入仓库地址：`https://github.com/imlida/dsh-plugin-prompt-polish`
3. 安装 → 启用 → **重启 DSH**

### 方式二：命令行手动安装

```bash
# 1) 装进目标 profile（profile 名以你自己的为准，例如 desktop / web）
dsh plugin --profile desktop add https://github.com/imlida/dsh-plugin-prompt-polish

# 2) 让这个包的分层生效：把它加进 profile 的 dsh.profile.bundles
#    编辑 ~/.dsh/profiles/desktop/package.json → dsh.profile.bundles 追加：
#    "dsh-plugin-prompt-polish"
```

> `dsh plugin add` 只是 pnpm 的薄包装，**不会**替你改 `dsh.profile.bundles`，第 2 步必须手动做。

### 方式三：从本地目录安装（开发用）

在插件界面里直接填本机目录的绝对路径，或：

```bash
dsh plugin --profile desktop add link:/path/to/dsh-plugin-prompt-polish
```

> **装完必须重启一次 DSH。**
> 原因是 DSH 的插件加载器对已经导入过的模块会命中 Node 的 ESM 缓存：在运行中开关插件条目**不会**重新导入改动后的代码（实测如此）。重启后输入框右下角就会出现按钮。

卸载：在「设置 → 插件」里关掉或卸载，或删掉 profile `package.json` 里的依赖与 `dsh.profile.bundles` 条目。

## 修改润色提示词

点输入框右下角的 **⚙**，直接编辑保存；想还原就点「恢复默认」。

也可以直接改文件（改完立即生效，不需要重启）：

```
$DSH_HOME/plugin-data/prompt-polish/settings.json     # {"prompt": "……"}
$DSH_HOME/plugin-data/prompt-polish/status.json       # 加载自检 / 报错记录
```

`$DSH_HOME` 默认是 `~/.dsh`，也可以用环境变量 `DSH_HOME` 或 `DSH_PROMPT_POLISH_SETTINGS` 指定。
删掉 `settings.json` 就回到内置默认提示词。

内置默认提示词要求模型：只输出润色结果、不执行任务、保持原意与语言、逐字保留 `@文件引用`/代码/命令/路径/URL、补全结构但不臆造事实。

## 可选：换模型或调参数

默认跟随你的默认模型。想让润色更快，可以在 profile 补丁（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`）里覆盖：

```yaml
- id: prompt-polish
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: low     # 不填则用该模型默认档位
    temperature: 0.3         # 默认 0.3
    maxTokens: 2048          # 默认 2048
```

## 工作原理

```
浏览器半 lib/client.js                      Host 半 lib/host.mjs
┌──────────────────────────┐               ┌────────────────────────────────┐
│ conversation.input.right │  HTTP POST    │ /dsh-prompt-polish/<endpoint>  │
│  ✨ / ↻ / ⚙ 三个按钮       │ ───────────▶  │  connection.admit() 鉴权        │
│  useInput 读草稿          │               │  ctx.llm.stream() 调模型        │
│  setDraft 写回草稿        │ ◀─────────── │  设置读写 JSON 文件              │
└──────────────────────────┘  信封响应      └────────────────────────────────┘
```

- **Host 半**在本机 HTTP 服务上挂一条 `/dsh-prompt-polish` 前缀路由，端点：`polish` / `getSettings` / `saveSettings` / `resetSettings`。线路协议与 DSH 通用 RPC 完全一致（`client-request` / `server-response` 信封），因此浏览器半直接复用 `ctx.connection.rpc.call()`，**无需任何代码生成**。文件只依赖 Node 内置模块，从任意本地目录加载都不需要 node_modules。
- **浏览器半**注册到 `conversation.input.right` 槽位，只依赖 DSH 的**平台种子模块**（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`），所以是自包含的手写产物，不需要打包工具。草稿通过槽位自动注入的 `useInput` 读、`inputActions.setDraft` 写；写回前用 `draftRev` 做一次 CAS，避免覆盖你在等待期间的编辑。

### 两个实现要点（踩过的坑）

1. **`ctx.effect` 的回调必须返回 disposer 函数。** 返回 Promise 会被 Cordis 判为非法并回滚整个作用域，已经注册好的路由会静默消失。
2. **没有使用 `ctx.connection.rpc.handle()`。** 在 DSH 0.2.0-rc.2 上这条 API 实际不可用：它内部用 owner 作用域去取 `webServer`，会抛 `cannot get property "webServer" without inject`，而 `handle()` 本身不报错、路由也不会出现（全仓库没有任何官方调用者）。因此这里改用公开且可用的 `webServer.register()` 挂路由 + `connection.admit()` 做鉴权，行为与官方通道一致。

## 开发

```bash
git clone https://github.com/imlida/dsh-plugin-prompt-polish
cd dsh-plugin-prompt-polish
npm test
```

**28 项测试，不需要启动 DSH**（`node:test`，零依赖）：

- **Host 半**：装配契约（依赖注入、路由形状、disposer 契约）、HTTP 层（404 / 401 / 415 / 信封不匹配）、设置端点往返、润色端点（提示词拼装、代码块围栏清理、分片拼接、`finish=error`、抛错包装、空草稿短路）。
- **浏览器半**：用自制的微型 React hook 运行时把组件真跑起来，从元素树里找到按钮并**触发点击**，断言「结果写回草稿」「空草稿只提示不调用」「润色期间草稿被改过则不覆盖（draftRev CAS）」「失败走 error 提示通道」「撤销写回原文」「提交中禁用」「图标用的是星形闪光」。

```
dsh-plugin-prompt-polish/
├── package.json          # 双半声明：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 组合层：把 Host 半作为一个 entry 插入 profile
├── icon.svg              # 插件卡片图标
├── locale/{zh,en}.json   # 插件卡片标题 / 描述
├── lib/host.mjs          # Host 半：HTTP 通道 + 调模型 + 读写设置
├── lib/client.js         # 浏览器半：输入框按钮 + 设置面板
└── test/                 # 单元测试
```

## 已知限制

- 草稿里如果带 `@文件` 引用芯片，整段替换会丢失芯片（LLM 改写本来也会破坏引用语义）；如果担心，先复制一份原文。
- 润色质量取决于「润色提示词」和所用模型；`reasoningEffort` 默认跟随模型档位，想更快可在配置里指定 `low`。
- 一次润色 = 一次模型调用，会消耗你自己的用量。
- 插件安装后 DSH 暂不支持自动更新，升级请先卸载再装新版。

## License

[MIT](LICENSE)
