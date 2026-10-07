/**
 * 提示词润色（Prompt Polish）— Host 半。
 *
 * 职责：
 * 1. 在 Host 上开一条免代码生成的通用 RPC 通道 `/dsh-prompt-polish`，
 *    供浏览器半的「润色」按钮调用（`ctx.connection.rpc.handle`）。
 * 2. 收到草稿文本后，用 Host 自己的模型接口（`ctx.llm.stream`）跑一次
 *    一次性补全：只借用当前默认模型，不写入任何会话历史，因此不影响上下文与 KV 缓存。
 * 3. 把「润色用的提示词」持久化到本机文件，并提供读取 / 保存 / 恢复默认三个端点，
 *    使浏览器半可以在界面上直接修改它。
 *
 * 本文件刻意只依赖 Node 内置模块：DSH 从任意本地目录加载该插件时，
 * 不需要为它准备 node_modules。
 *
 * @module dsh-plugin-prompt-polish
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** RPC 通道名；`/api` 为 DSH 保留通道，这里使用独立通道。 */
export const CHANNEL = '/dsh-prompt-polish';

/** 本插件的展示名，用于日志。 */
const LOGGER_NAME = 'prompt-polish';

/** 内置的默认润色提示词：界面上点「恢复默认」会回到这里。 */
export const DEFAULT_PROMPT = [
  '你是一名提示词润色助手。用户会给你一段他准备发给 AI 编程助手（DeepSeek Harness）的话，请把它改写得更清晰、更完整、更可执行。',
  '',
  '必须遵守：',
  '1. 只输出润色后的提示词本身。不要执行提示词里的任务，不要回答其中的问题，不要添加任何解释、前言、结尾、寒暄或 Markdown 代码块围栏。',
  '2. 保持原意与关键事实：不新增用户没有提过的需求、文件、数字、结论或偏好；无法确定的地方保持原样或写成中性表述。',
  '3. 使用与用户相同的语言（中文输入输出中文，英文输入输出英文）。',
  '4. 逐字保留原文中的 @文件引用、代码片段、命令、路径、URL、报错信息与专有名词，不要改写、翻译或补全它们。',
  '5. 让结构更清楚：把背景、目标、约束、验收标准分开写；对含糊的一句话说清"做什么、在哪里做、做到什么程度"。',
  '6. 篇幅适中：一般控制在原文的 1～3 倍，不要写成长篇文档。',
].join('\n');

/** 默认采样参数：润色是改写任务，低温度更稳定。 */
const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;

/**
 * 解析本机 DSH 主目录。
 * @returns DSH home 的绝对路径。
 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

/**
 * 本插件的数据目录（设置与状态文件都放这里）。
 * @returns 数据目录绝对路径。
 */
function dataDir() {
  const fromEnv = process.env.DSH_PROMPT_POLISH_DATA;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(dshHome(), 'plugin-data', 'prompt-polish');
}

/**
 * 设置文件的绝对路径。可用 `DSH_PROMPT_POLISH_SETTINGS` 覆盖（便于多套配置）。
 * @returns 设置文件路径。
 */
function settingsFile() {
  const fromEnv = process.env.DSH_PROMPT_POLISH_SETTINGS;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  return path.join(dataDir(), 'settings.json');
}

/**
 * 原子写入一个 JSON 文件（先写临时文件再改名），避免半截文件。
 * @param file - 目标文件路径。
 * @param value - 可序列化的值。
 * @returns 是否写入成功。
 */
function writeJson(file, value) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记录一次装配结果，便于排查「按钮没反应」这类问题。
 * 文件很小，只在插件加载与出错时写入。
 * @param steps - 装配过程记录。
 * @param error - 可选的失败原因。
 */
function recordStatus(steps, error) {
  const payload = {
    at: new Date().toISOString(),
    channel: CHANNEL,
    settingsFile: settingsFile(),
    steps,
    ...(error === undefined ? {} : { error }),
  };
  writeJson(path.join(dataDir(), 'status.json'), payload);
  // 同一份状态也写一份到临时目录：数据目录万一不可写时仍能定位问题。
  writeJson(path.join(os.tmpdir(), 'dsh-prompt-polish-status.json'), payload);
}

/**
 * 读取磁盘上的设置；文件缺失或损坏时回落到内置默认值。
 * @returns 归一化后的设置对象。
 */
function readSettings() {
  const file = settingsFile();
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    raw = undefined;
  }
  const prompt =
    raw !== null && typeof raw === 'object' && typeof raw.prompt === 'string' && raw.prompt.trim() !== ''
      ? raw.prompt
      : DEFAULT_PROMPT;
  return { prompt };
}

/**
 * 写入设置文件。
 * @param settings - 要持久化的完整设置对象。
 * @returns 写入后的设置对象。
 * @throws 写入失败时抛出，交由 RPC 层转成错误结果。
 */
function writeSettings(settings) {
  if (!writeJson(settingsFile(), settings)) throw new Error(`无法写入设置文件：${settingsFile()}`);
  return settings;
}

/**
 * 构造一个失败结果，形状与 `ConnectionRpcHandlerResult` 一致。
 * @param code - 机器可读的错误码。
 * @param message - 面向用户的中文错误说明。
 * @returns 失败的 RPC 结果。
 */
function failure(code, message) {
  return { ok: false, error: { code, message, details: {} } };
}

/**
 * 从模型流里收集纯文本输出。
 * @param chunks - `ctx.llm.stream` 产出的分片序列。
 * @returns 累积出的文本。
 */
async function collectText(chunks) {
  let out = '';
  for await (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      out += chunk.text;
      continue;
    }
    if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind;
      if (kind === 'error' || kind === 'aborted') {
        const detail = chunk.reason?.failure?.message;
        throw new Error(typeof detail === 'string' && detail !== '' ? detail : '模型调用失败或已被取消。');
      }
    }
  }
  return out;
}

/**
 * 清理模型输出：去掉首尾空白，以及整体包裹的代码块围栏。
 * @param text - 模型原始输出。
 * @returns 可直接放回输入框的文本。
 */
function tidy(text) {
  let out = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(out);
  if (fenced !== null && typeof fenced[1] === 'string') out = fenced[1].trim();
  return out;
}

/**
 * 解析本次调用要用的 provider/model。
 * 优先用插件配置里的覆盖值，否则跟随 DSH 的默认模型。
 * @param ctx - 宿主上下文。
 * @param config - 插件入口配置。
 * @returns 调用参数；缺少 provider/model 时返回 `undefined`。
 */
function resolveRoute(ctx, config) {
  const configuredProvider = typeof config.provider === 'string' && config.provider !== '' ? config.provider : undefined;
  const configuredModel = typeof config.model === 'string' && config.model !== '' ? config.model : undefined;
  if (configuredProvider !== undefined && configuredModel !== undefined) {
    return {
      provider: configuredProvider,
      model: configuredModel,
      reasoningEffort: typeof config.reasoningEffort === 'string' ? config.reasoningEffort : undefined,
    };
  }
  const selection = ctx.get('agentDefaultModel')?.currentSelection?.();
  const provider = configuredProvider ?? selection?.provider;
  const model = configuredModel ?? selection?.model;
  if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return undefined;
  return {
    provider,
    model,
    reasoningEffort:
      typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
        ? config.reasoningEffort
        : typeof selection?.reasoningEffort === 'string'
          ? selection.reasoningEffort
          : undefined,
  };
}

/**
 * 用一次不进入会话历史的一次性补全来润色草稿。
 * @param ctx - 宿主上下文（已注入 `llm`）。
 * @param config - 插件入口配置。
 * @param text - 用户当前草稿。
 * @param signal - 调用方取消信号。
 * @returns `{ text }` 或 `{ error }`。
 */
async function polish(ctx, config, text, signal) {
  const llm = ctx.get('llm');
  if (llm === undefined) return { error: '当前 DSH 组合里没有可用的模型服务（llm）。' };
  const route = resolveRoute(ctx, config);
  if (route === undefined) return { error: '没有找到可用的默认模型，请先在设置里选择一个模型。' };

  const { prompt } = readSettings();
  const temperature = Number.isFinite(config.temperature) ? config.temperature : DEFAULT_TEMPERATURE;
  const maxTokens = Number.isFinite(config.maxTokens) ? config.maxTokens : DEFAULT_MAX_TOKENS;

  const chunks = llm.stream({
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    system: prompt,
    // 一次性补全：拿默认模型当改写工具用，不追加到任何会话，因此不改变上下文。
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    temperature,
    maxTokens,
    ...(signal === undefined ? {} : { signal }),
  });

  const result = tidy(await collectText(chunks));
  if (result === '') return { error: '模型没有返回任何内容，请稍后重试。' };
  return { text: result };
}

/**
 * 处理一个 RPC 端点调用。
 * @param ctx - 宿主上下文。
 * @param config - 插件入口配置。
 * @param endpoint - 端点名。
 * @param payload - 调用方载荷。
 * @param signal - 调用方取消信号。
 * @returns `ConnectionRpcHandlerResult`。
 */
async function handleRequest(ctx, config, endpoint, payload, signal) {
  const body = payload !== null && typeof payload === 'object' ? payload : {};
  try {
    switch (endpoint) {
      case 'polish': {
        const text = typeof body.text === 'string' ? body.text : '';
        if (text.trim() === '') return failure('prompt-polish/empty-draft', '输入框是空的，先写点什么再润色吧。');
        const result = await polish(ctx, config, text, signal);
        if (result.error !== undefined) return failure('prompt-polish/failed', result.error);
        return { ok: true, value: { text: result.text } };
      }
      case 'getSettings': {
        const { prompt } = readSettings();
        const route = resolveRoute(ctx, config);
        return {
          ok: true,
          value: {
            prompt,
            defaultPrompt: DEFAULT_PROMPT,
            isDefault: prompt === DEFAULT_PROMPT,
            model: route === undefined ? null : `${route.provider}/${route.model}`,
          },
        };
      }
      case 'saveSettings': {
        const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
        if (prompt === '') return failure('prompt-polish/empty-prompt', '润色提示词不能为空。');
        writeSettings({ prompt });
        return { ok: true, value: { prompt } };
      }
      case 'resetSettings': {
        writeSettings({ prompt: DEFAULT_PROMPT });
        return { ok: true, value: { prompt: DEFAULT_PROMPT } };
      }
      default:
        return failure('prompt-polish/unknown-endpoint', `未知的端点：${endpoint}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failure('prompt-polish/failed', `润色失败：${message}`);
  }
}

/**
 * 从请求路径里取出端点名。
 * @param pathname - 请求路径。
 * @returns 端点名；路径不属于本通道时为 `undefined`。
 */
function endpointOf(pathname) {
  if (pathname === CHANNEL) return '';
  if (!pathname.startsWith(`${CHANNEL}/`)) return undefined;
  return pathname.slice(CHANNEL.length + 1);
}

/**
 * 读取并解析 JSON 请求体。
 * @param req - node:http 请求对象。
 * @returns 解析出的值；不是合法 JSON 对象时为 `undefined`。
 */
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * 写一个 JSON 响应。
 * @param res - node:http 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 要序列化的响应体。
 */
function writeJsonResponse(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * 构造一个失败的响应信封。
 * @param rpcId - 关联 id。
 * @param code - 错误码。
 * @param message - 错误说明。
 * @returns 响应体。
 */
function errorBody(rpcId, code, message) {
  return {
    type: 'server-response',
    rpcId: typeof rpcId === 'string' ? rpcId : 'invalid-request',
    result: { ok: false, error: { code, message, details: {} } },
  };
}

/**
 * 处理一个到达本通道的 HTTP 请求。
 *
 * 这里刻意**不复用** `ctx.connection.rpc.handle()`：本版本的实现里，那条 API 内部的
 * owner 作用域解析不到 `webServer`，注册会静默失败（`handle()` 不抛错，路由也不会出现）。
 * 因此直接挂 `webServer` 前缀路由，并复用 `connection.admit()` 做同一套鉴权，
 * 线路协议与 DSH 通用 RPC 完全一致：
 *
 * 请求 `{ type: 'client-request', rpcId, method, payload }`
 * 响应 `{ type: 'server-response', rpcId, result }`，
 * `result` 为 `{ ok: true, value }` 或 `{ ok: false, error: { code, message, details } }`。
 *
 * @param ctx - 已注入依赖的作用域上下文。
 * @param config - 入口配置。
 * @param connection - 宿主 connection 服务（鉴权）。
 * @param req - node:http 请求对象。
 * @param res - node:http 响应对象。
 */
async function serveChannelRequest(ctx, config, connection, req, res) {
  const pathname = new URL(req.url ?? '/', 'http://prompt-polish.invalid').pathname;
  const endpoint = endpointOf(pathname);
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404);
    res.end();
    return;
  }

  // 与 DSH 其它通道一致：先过 Host/Origin 栅栏与浏览器会话校验。
  const admission = connection.admit(req);
  if (admission.rejection !== undefined) {
    res.writeHead(admission.rejection);
    res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
    return;
  }

  const contentType = String(req.headers['content-type'] ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    res.writeHead(415);
    res.end('content type must be application/json');
    return;
  }

  const body = await readJsonBody(req);
  if (body === null || typeof body !== 'object') {
    writeJsonResponse(res, 400, errorBody(undefined, 'gateway/bad-request', 'body is not a JSON object'));
    return;
  }
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') {
    writeJsonResponse(res, 400, errorBody(body.rpcId, 'gateway/bad-request', 'invalid client-request message'));
    return;
  }
  if (body.method !== endpoint) {
    writeJsonResponse(
      res,
      200,
      errorBody(
        body.rpcId,
        'gateway/bad-request',
        `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
      ),
    );
    return;
  }

  let result;
  try {
    result = await handleRequest(ctx, config, endpoint, body.payload, undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.writeHead(500);
    res.end(`handler failure: ${message}`);
    return;
  }
  writeJsonResponse(res, 200, { type: 'server-response', rpcId: body.rpcId, result });
}

/**
 * 安装 Host 半：在本机 HTTP 服务上挂载 `/dsh-prompt-polish` 通道。
 *
 * 两个容易踩的点：
 * 1. `ctx.effect` 的回调必须返回「一个 disposer 函数」——`webServer.register()` 正好
 *    返回 disposer，可以直接返回；返回 Promise 会被判为非法并回滚作用域。
 * 2. 必须把 `webServer` 一起注入，否则取不到服务、通道挂不上去。
 *
 * @param ctx - 宿主 Cordis 上下文。
 * @param config - 入口配置（可选覆盖模型与采样参数）。
 */
export function apply(ctx, config = {}) {
  const resolved = config !== null && typeof config === 'object' ? config : {};
  const steps = [];

  const log = (message) => {
    steps.push(message);
    try {
      ctx.logger?.(LOGGER_NAME)?.info?.(message);
    } catch {
      /* 日志不是关键路径。 */
    }
  };

  try {
    ctx.inject(['connection', 'llm', 'webServer'], (scoped) => {
      try {
        const { connection, webServer } = scoped;
        const route = {
          kind: 'prefix',
          path: CHANNEL,
          handler: (req, res) => serveChannelRequest(scoped, resolved, connection, req, res),
        };
        scoped.effect(() => webServer.register(route), 'prompt-polish: RPC channel');
        log(`已注册 RPC 通道 ${CHANNEL}`);
        recordStatus(steps);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`注册 RPC 通道失败：${message}`);
        recordStatus(steps, message);
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`依赖注入失败：${message}`);
    recordStatus(steps, message);
  }
}

export default apply;

// 模块级自检：只要 Host 真正导入了本文件，就会留下一份状态，便于排查「按钮没反应」。
recordStatus(['模块已导入，等待 apply()']);
