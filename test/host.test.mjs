/**
 * Host 半的单元测试：不启动 DSH，也不调用真实模型。
 *
 * 这里走的是**真实路径**：测试自己造一个 node:http 风格的 req/res，
 * 直接调用插件挂在 webServer 上的路由处理器，因此同时覆盖了
 * 装配契约、鉴权分支、线路信封协议与业务逻辑。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const { DEFAULT_PROMPT, apply } = await import('../lib/host.mjs');

/** 本次测试的设置文件；与真实 DSH 数据目录完全隔离。 */
const workspace = mkdtempSync(path.join(os.tmpdir(), 'prompt-polish-test-'));
const settingsFile = path.join(workspace, 'settings.json');
process.env.DSH_PROMPT_POLISH_SETTINGS = settingsFile;

/**
 * 造一个 node:http 风格的请求对象。
 * @param endpoint - 端点名。
 * @param payload - 请求载荷。
 * @param options - 覆盖 method / content-type。
 * @returns 可被 `for await` 迭代的假请求。
 */
function createRequest(
  endpoint,
  payload,
  { method = 'POST', contentType = 'application/json', envelopeMethod = endpoint, rpcId = 'rpc-1' } = {},
) {
  const body = Buffer.from(JSON.stringify({ type: 'client-request', rpcId, method: envelopeMethod, payload }));
  return {
    method,
    url: `/dsh-prompt-polish/${endpoint}`,
    headers: { 'content-type': contentType },
    async *[Symbol.asyncIterator]() {
      yield body;
    },
  };
}

/** 造一个记录状态的假响应对象。 */
function createResponse() {
  const captured = { status: undefined, headers: undefined, body: '' };
  return {
    captured,
    writeHead(status, headers) {
      captured.status = status;
      captured.headers = headers;
    },
    end(text) {
      if (text !== undefined) captured.body = String(text);
    },
  };
}

/**
 * 造一个最小的 Cordis 风格上下文。
 * @param options.llm - 可选的假 llm 服务。
 * @param options.selection - 默认模型选择。
 * @param options.admitted - `connection.admit()` 是否放行。
 * @returns 装配结果与请求入口。
 */
function createContext({ llm, selection = { provider: 'test-provider', model: 'test-model' }, admitted = true } = {}) {
  /** 每次 `ctx.effect` 回调的返回值，用来断言 disposer 契约。 */
  const effectReturns = [];
  /** inject 声明过的依赖，用来断言 webServer 确实被注入。 */
  const injectedDeps = [];
  /** 挂在 webServer 上的路由。 */
  let route;

  const services = {
    connection: {
      admit: () => (admitted ? { peer: { kind: 'operator' } } : { rejection: 401 }),
    },
    webServer: {
      register(candidate) {
        route = candidate;
        return () => {
          route = undefined;
        };
      },
    },
    ...(llm === undefined ? {} : { llm }),
    agentDefaultModel: { currentSelection: () => selection },
  };

  const scoped = {
    get: (key) => services[key],
    effect(callback) {
      effectReturns.push(callback());
      return () => {};
    },
    get connection() {
      return services.connection;
    },
    get webServer() {
      return services.webServer;
    },
    get llm() {
      return services.llm;
    },
  };

  const ctx = {
    effect(callback) {
      effectReturns.push(callback());
      return () => {};
    },
    get: (key) => services[key],
    inject(deps, callback) {
      injectedDeps.push(...deps);
      callback(scoped);
      return { dispose: () => {} };
    },
    logger: () => ({ info: () => {} }),
  };

  return {
    ctx,
    effectReturns,
    injectedDeps,
    get route() {
      return route;
    },
    /**
     * 走一次完整的 HTTP 请求，返回解析后的 RPC 结果信封。
     * @param endpoint - 端点名。
     * @param payload - 载荷。
     * @param options - 覆盖 method / content-type。
     * @returns `{ status, envelope }`。
     */
    async request(endpoint, payload, options) {
      assert.ok(route, '路由尚未注册');
      const res = createResponse();
      await route.handler(createRequest(endpoint, payload, options), res);
      let envelope = null;
      try {
        envelope = JSON.parse(res.captured.body);
      } catch {
        envelope = null;
      }
      return { status: res.captured.status, envelope, res };
    },
    /**
     * 便捷入口：只关心业务结果时使用。
     * @param endpoint - 端点名。
     * @param payload - 载荷。
     * @returns `{ ok, value }` 或 `{ ok, error }`。
     */
    async call(endpoint, payload) {
      const { envelope } = await this.request(endpoint, payload);
      assert.ok(envelope, '响应不是 JSON 信封');
      return envelope.result;
    },
  };
}

/**
 * 造一个顺序产出给定分片的假模型流。
 * @param chunks - 要产出的分片。
 * @param options.fail - 若提供，则在迭代时抛出该错误。
 * @returns 假 llm 服务；调用参数记录在 `llm.calls`。
 */
function fakeLlm(chunks, { fail } = {}) {
  const calls = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* generate() {
        if (fail !== undefined) throw fail;
        await Promise.resolve();
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

before(() => {
  writeFileSync(settingsFile, '{"prompt":"自定义提示词"}\n', 'utf8');
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('装配契约', () => {
  test('注入 connection / llm / webServer，并挂载 /dsh-prompt-polish 前缀路由', () => {
    const harness = createContext({ llm: fakeLlm([]) });
    apply(harness.ctx, {});

    assert.deepEqual(harness.injectedDeps, ['connection', 'llm', 'webServer']);
    assert.ok(harness.route, '路由没有注册');
    assert.equal(harness.route.kind, 'prefix');
    assert.equal(harness.route.path, '/dsh-prompt-polish');
    assert.equal(typeof harness.route.handler, 'function');
    // 关键回归点：effect 回调必须返回 disposer 函数，不能是 Promise。
    for (const value of harness.effectReturns) assert.equal(typeof value, 'function');
  });

  test('缺少 llm 服务时仍然挂载通道，只是调用时报错', async () => {
    const harness = createContext();
    apply(harness.ctx, {});

    const result = await harness.call('polish', { text: '你好' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /模型服务/);
  });

  test('没有实例信息时也能装配（不抛异常）', () => {
    const harness = createContext({ llm: fakeLlm([]) });
    assert.doesNotThrow(() => apply(harness.ctx));
  });
});

describe('HTTP 层', () => {
  test('GET 与未知路径返回 404', async () => {
    const harness = createContext({ llm: fakeLlm([]) });
    apply(harness.ctx, {});

    const get = await harness.request('getSettings', {}, { method: 'GET' });
    assert.equal(get.status, 404);
  });

  test('鉴权不通过时返回 401，且不进入业务逻辑', async () => {
    const harness = createContext({ llm: fakeLlm([]), admitted: false });
    apply(harness.ctx, {});

    const denied = await harness.request('getSettings', {});
    assert.equal(denied.status, 401);
    assert.equal(denied.envelope, null);
  });

  test('content-type 不是 JSON 时返回 415', async () => {
    const harness = createContext({ llm: fakeLlm([]) });
    apply(harness.ctx, {});

    const bad = await harness.request('getSettings', {}, { contentType: 'text/plain' });
    assert.equal(bad.status, 415);
  });

  test('method 与路径不一致时在信封里报错', async () => {
    const harness = createContext({ llm: fakeLlm([]) });
    apply(harness.ctx, {});

    // 信封里的 method 与 URL 端点故意写成不一致，模拟畸形请求。
    const mismatch = await harness.request('getSettings', {}, { envelopeMethod: 'polish' });
    assert.equal(mismatch.status, 200);
    assert.equal(mismatch.envelope.result.ok, false);
    assert.equal(mismatch.envelope.result.error.code, 'gateway/bad-request');
    // rpcId 必须原样回传，客户端要靠它配对响应。
    assert.equal(mismatch.envelope.rpcId, 'rpc-1');

    // 正常请求则确实走到业务逻辑。
    const ok = await harness.request('getSettings', {});
    assert.equal(ok.envelope.result.ok, true);
  });
});

describe('设置端点', () => {
  test('getSettings 返回当前提示词与默认值', async () => {
    const harness = createContext();
    apply(harness.ctx, {});

    const result = await harness.call('getSettings', {});
    assert.equal(result.ok, true);
    assert.equal(result.value.prompt, '自定义提示词');
    assert.equal(result.value.defaultPrompt, DEFAULT_PROMPT);
    assert.equal(result.value.isDefault, false);
    assert.equal(result.value.model, 'test-provider/test-model');
  });

  test('saveSettings 落盘并可被重新读取', async () => {
    const harness = createContext();
    apply(harness.ctx, {});

    const saved = await harness.call('saveSettings', { prompt: '  新提示词  ' });
    assert.equal(saved.ok, true);
    assert.equal(saved.value.prompt, '新提示词');
    assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).prompt, '新提示词');

    const reread = await harness.call('getSettings', {});
    assert.equal(reread.value.prompt, '新提示词');
  });

  test('saveSettings 拒绝空提示词', async () => {
    const harness = createContext();
    apply(harness.ctx, {});
    const result = await harness.call('saveSettings', { prompt: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'prompt-polish/empty-prompt');
  });

  test('resetSettings 回到内置默认值', async () => {
    const harness = createContext();
    apply(harness.ctx, {});
    await harness.call('resetSettings', {});
    assert.equal(JSON.parse(readFileSync(settingsFile, 'utf8')).prompt, DEFAULT_PROMPT);
  });
});

describe('润色端点', () => {
  test('把草稿作为 user 消息、把配置的提示词作为 system 发出，并拼接输出', async () => {
    // 每个用例自己准备设置文件，避免依赖执行顺序。
    writeFileSync(settingsFile, '{"prompt":"自定义提示词"}\n', 'utf8');
    const llm = fakeLlm([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '润色后的' },
      { type: 'text-delta', index: 0, text: '提示词' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const harness = createContext({ llm });
    apply(harness.ctx, {});

    const result = await harness.call('polish', { text: '帮我写个函数' });
    assert.equal(result.ok, true);
    assert.equal(result.value.text, '润色后的提示词');

    const [options] = llm.calls;
    assert.equal(options.system, '自定义提示词');
    assert.equal(options.provider, 'test-provider');
    assert.equal(options.model, 'test-model');
    assert.deepEqual(options.messages, [{ role: 'user', content: [{ type: 'text', text: '帮我写个函数' }] }]);
    assert.equal(options.temperature, 0.3);
    // 一次性补全不应带 purpose（那是 compaction/session-title 专用的闭集）。
    assert.equal(options.purpose, undefined);
  });

  test('去掉整体包裹的代码块围栏', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', index: 0, text: '```text\n真正的提示词\n```' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]);
    const harness = createContext({ llm });
    apply(harness.ctx, {});
    const result = await harness.call('polish', { text: 'x' });
    assert.equal(result.value.text, '真正的提示词');
  });

  test('入口 config 可覆盖模型与采样参数', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
    const harness = createContext({ llm });
    apply(harness.ctx, { provider: 'p2', model: 'm2', reasoningEffort: 'low', temperature: 0.1, maxTokens: 512 });

    await harness.call('polish', { text: 'x' });
    const [options] = llm.calls;
    assert.equal(options.provider, 'p2');
    assert.equal(options.model, 'm2');
    assert.equal(options.reasoningEffort, 'low');
    assert.equal(options.temperature, 0.1);
    assert.equal(options.maxTokens, 512);
  });

  test('空草稿直接被拒绝，不调用模型', async () => {
    const llm = fakeLlm([]);
    const harness = createContext({ llm });
    apply(harness.ctx, {});

    const result = await harness.call('polish', { text: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'prompt-polish/empty-draft');
    assert.equal(llm.calls.length, 0);
  });

  test('模型没有输出正文时给出可读错误', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
    const harness = createContext({ llm });
    apply(harness.ctx, {});
    const result = await harness.call('polish', { text: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /没有返回任何内容/);
  });

  test('finish=error 的分片被转成失败结果', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', index: 0, text: '半截' },
      { type: 'finish', reason: { kind: 'error', failure: { message: '额度不足', code: 'quota' } } },
    ]);
    const harness = createContext({ llm });
    apply(harness.ctx, {});
    const result = await harness.call('polish', { text: 'x' });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /额度不足/);
  });

  test('模型调用抛错时被包成失败结果', async () => {
    const llm = fakeLlm([], { fail: new Error('网络断了') });
    const harness = createContext({ llm });
    apply(harness.ctx, {});
    const result = await harness.call('polish', { text: 'x' });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'prompt-polish/failed');
    assert.match(result.error.message, /网络断了/);
  });

  test('未知端点返回错误而不是抛异常', async () => {
    const harness = createContext({ llm: fakeLlm([]) });
    apply(harness.ctx, {});
    const result = await harness.call('nope', {});
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'prompt-polish/unknown-endpoint');
  });
});
