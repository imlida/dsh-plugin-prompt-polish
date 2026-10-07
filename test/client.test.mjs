/**
 * 浏览器半的单元测试：不启动浏览器，也不加载真实 UI 组件库。
 *
 * 做法是自己实现一个极小的 React hook 运行时（useState / useRef / useEffect / useCallback），
 * 把 `lib/client.js` 当成普通模块加载并调用 `apply()`，然后：
 * 1. 断言它向 `conversation.input.right` 注册了正确形状的入口；
 * 2. 把组件函数跑起来，从元素树里找到「润色」按钮，**真的触发 onClick**；
 * 3. 断言润色结果被写回草稿、失败与「草稿已变化」分别走了官方提示通道。
 *
 * 运行：`node --test test/*.test.mjs`
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));

// #region 微型 React 运行时

/** 一个 hook 运行时实例；每次「渲染」前调用 `begin()` 重置游标。 */
function createHookRuntime() {
  const slots = [];
  let cursor = 0;
  let rerender = () => {};

  return {
    begin() {
      cursor = 0;
    },
    /** 记录重渲染请求，由调用方决定何时真正重渲染。 */
    setRerender(fn) {
      rerender = fn;
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next;
          rerender();
        },
      ];
    },
    useEffect(fn) {
      const index = cursor++;
      // 依赖数组在本测试里恒为稳定输入，所以只在首次记录时执行一次。
      if (!(index in slots)) {
        slots[index] = true;
        fn();
      }
    },
    useCallback(fn) {
      cursor++;
      return fn;
    },
  };
}

const Fragment = Symbol('Fragment');

/**
 * 极简 jsx 工厂：产出 `{ type, props }`，供测试遍历元素树。
 * @param type - 元素类型。
 * @param props - 元素属性。
 * @param key - 可选的 key。
 * @returns 元素描述对象。
 */
function createElement(type, props, key) {
  return { type, props: props ?? {}, key };
}

/** `jsx` 与 `jsxs` 在本测试里行为一致：children 已在 props 里。 */
const jsx = createElement;
const jsxs = createElement;

/**
 * 深度遍历元素树，收集所有满足谓词的元素。
 * @param node - 当前节点。
 * @param predicate - 判定函数。
 * @param found - 收集数组。
 */
function walk(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return found;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, predicate, found);
    return found;
  }
  if (typeof node !== 'object') return found;
  if (predicate(node)) found.push(node);
  const children = node.props?.children;
  walk(children, predicate, found);
  return found;
}

/**
 * 从元素树里找出带指定 aria-label 的节点；遇到纯展示型组件（host tag 之外的函数）
 * 会先把它们展开一层，这样 Button/Tooltip 之类的外壳不会挡住查询。
 * @param node - 根节点。
 * @param label - aria-label 文本。
 * @returns 找到的元素。
 */
function findByLabel(node, label) {
  const found = walk(node, (element) => element.props?.['aria-label'] === label);
  assert.ok(found.length > 0, `元素树里没有找到 aria-label=${label} 的节点`);
  return found[0];
}

// #endregion

// #region 环境装配

/** 浏览器侧极简 document 桩：只满足 lib/client.js 注入样式所需。 */
const injectedStyles = [];
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (tag) => injectedStyles.push(tag) },
};

/** 捕获 `window.__ModuleLoader__.load` 的注册结果。 */
let registration;
globalThis.window = {
  __ModuleLoader__: {
    load(reg) {
      registration = reg;
    },
  },
};

const hookRuntime = createHookRuntime();

/** 被 require 的「平台种子模块」：react 与 UI 组件库的最小替身。 */
const fakeRequire = (specifier) => {
  if (specifier === 'react') {
    return {
      useState: hookRuntime.useState,
      useRef: hookRuntime.useRef,
      useEffect: hookRuntime.useEffect,
      useCallback: hookRuntime.useCallback,
    };
  }
  if (specifier === 'react/jsx-runtime') {
    return { jsx, jsxs, Fragment };
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    // 每个替身带上 displayName，测试才能断言「用的是哪个图标」。
    const passthrough = (name) => {
      const Primitive = (props) => createElement(name, props);
      Primitive.displayName = name;
      return Primitive;
    };
    return {
      Button: passthrough('button'),
      Tooltip: passthrough('tooltip'),
      Modal: passthrough('modal'),
      IconLoadingOutlineRegular: passthrough('svg-loading'),
      IconSparkleRegular: passthrough('svg-sparkle'),
      IconRefreshOutlineRegular: passthrough('svg-refresh'),
      IconSettingsOutlineRegular: passthrough('svg-settings'),
    };
  }
  throw new Error(`测试没有为模块 ${specifier} 提供替身`);
};

/** 中文文案表，与 lib/client.js 中的 zh 字典保持一致。 */
const zh = {
  polish: '润色提示词',
  undo: '撤销润色，恢复原文',
  settings: '设置润色提示词',
  empty: '输入框是空的，先写点什么再润色吧。',
  polishFailed: '润色失败：{message}',
  changed: '草稿在润色期间被修改过，已保留你最新的内容，没有覆盖。',
};
const t = (key, params) => {
  const template = zh[key] ?? key;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
};

before(async () => {
  await import('../lib/client.js');
});

// #endregion

/**
 * 造一个客户端插件上下文与注册记录。
 * @returns 装配结果。
 */
function createClientHarness() {
  const slots = [];
  const localeRegistrations = [];
  const notifications = [];

  const conversation = {
    input: {
      for: () => ({
        notify: (level, text) => notifications.push({ level, text }),
      }),
    },
  };

  const ctx = {
    effect(callback) {
      callback();
      return () => {};
    },
    locale: {
      register: (ns, dicts) => {
        localeRegistrations.push({ ns, dicts });
        return () => {};
      },
    },
    sessions: {
      scope: (sessionId) =>
        sessionId === 'session-1' ? { get: (key) => (key === 'conversation' ? conversation : undefined) } : undefined,
    },
    connection: {
      rpc: {
        call: async () => ({ ok: true, value: {} }),
      },
    },
    slots: {
      inject(key, callback) {
        callback();
        return () => {};
      },
      register(options, component) {
        slots.push({ options, component });
        return () => {};
      },
    },
  };

  return { ctx, slots, localeRegistrations, notifications };
}

/**
 * 用微型运行时渲染组件，并返回「重新渲染」入口。
 * @param component - 组件函数。
 * @param props - 组件属性。
 * @returns `{ tree, rerender }`。
 */
function render(component, props) {
  let tree;
  const draw = () => {
    hookRuntime.begin();
    tree = component(props);
  };
  hookRuntime.setRerender(draw);
  draw();
  return {
    get tree() {
      return tree;
    },
    rerender: draw,
  };
}

/** 让挂起的 Promise 链跑完。 */
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('客户端插件装配', () => {
  test('以包名注册客户端模块，并导出 apply/inject', () => {
    assert.ok(registration, 'window.__ModuleLoader__.load 没有被调用');
    assert.equal(registration.id, 'dsh-plugin-prompt-polish');

    const exports = registration.factory(fakeRequire);
    assert.equal(typeof exports.apply, 'function');
    assert.deepEqual(exports.inject, ['connection', 'slots', 'locale', 'sessions', 'conversation']);
    // 样式通过 data-plugin 归属，插件卸载时才能被回收。
    assert.equal(injectedStyles.length, 1);
    assert.equal(injectedStyles[0].dataset.plugin, 'dsh-plugin-prompt-polish');
  });

  test('注册 conversation.input.right 入口，并注入 client / notify', () => {
    const harness = createClientHarness();
    const exports = registration.factory(fakeRequire);
    exports.apply(harness.ctx);

    assert.equal(harness.localeRegistrations.length, 1);
    assert.equal(harness.localeRegistrations[0].ns, 'prompt-polish');

    assert.equal(harness.slots.length, 1);
    const [{ options, component }] = harness.slots;
    assert.equal(options.name, 'conversation.input.right');
    assert.equal(options.id, 'prompt-polish');
    assert.equal(typeof options.order, 'number');
    assert.equal(options.locale, 'prompt-polish');
    assert.equal(typeof component, 'function');

    const injected = options.inject('session-1');
    assert.equal(typeof injected.client.polish, 'function');
    injected.notify('error', '出错了');
    assert.deepEqual(harness.notifications, [{ level: 'error', text: '出错了' }]);
  });
});

describe('点击润色按钮', () => {
  test('成功时把润色结果写回草稿，并出现撤销按钮', async () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component } = harness.slots[0];
    const { options } = harness.slots[0];

    const inputState = { draft: '帮我写点东西', draftRev: 3, phase: 'plain' };
    const drafts = [];
    let polished = null;
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector(inputState),
      inputActions: {
        // 忠实模拟编辑器：写回草稿会同时推进 draftRev，编辑器再通知 UI 重渲染。
        setDraft: (text) => {
          drafts.push(text);
          inputState.draft = text;
          inputState.draftRev += 1;
        },
      },
      client: {
        polish: async (text) => {
          polished = text;
          return { ok: true, value: { text: '请帮我实现一个函数，要求如下：…' } };
        },
      },
      t,
    });

    findByLabel(view.tree, '润色提示词').props.onClick();
    await flush();
    view.rerender();

    assert.equal(polished, '帮我写点东西');
    assert.deepEqual(drafts, ['请帮我实现一个函数，要求如下：…']);
    assert.deepEqual(harness.notifications, []);
    // 成功后应出现「撤销」入口。
    findByLabel(view.tree, '撤销润色，恢复原文');
  });

  test('草稿为空时不调用模型，只给一条提示', async () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const inputState = { draft: '   ', draftRev: 1, phase: 'plain' };
    let calls = 0;
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector(inputState),
      inputActions: { setDraft: () => {} },
      client: {
        polish: async () => {
          calls += 1;
          return { ok: true, value: { text: '' } };
        },
      },
      t,
    });

    findByLabel(view.tree, '润色提示词').props.onClick();
    await flush();

    assert.equal(calls, 0);
    assert.deepEqual(harness.notifications, [{ level: 'info', text: zh.empty }]);
  });

  test('润色期间草稿被改动时只提示，不覆盖用户的新内容（draftRev CAS）', async () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const inputState = { draft: '原始草稿', draftRev: 5, phase: 'plain' };
    const drafts = [];
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector(inputState),
      inputActions: { setDraft: (text) => drafts.push(text) },
      client: {
        polish: async () => {
          // 模拟用户在等待期间继续打字：编辑器发布新状态并触发一次重渲染，
          // 组件因此通过 useInput 看到前进后的 draftRev。
          inputState.draft = '用户新写的内容';
          inputState.draftRev = 6;
          view.rerender();
          return { ok: true, value: { text: '润色结果' } };
        },
      },
      t,
    });

    findByLabel(view.tree, '润色提示词').props.onClick();
    await flush();
    view.rerender();

    assert.deepEqual(drafts, []);
    assert.deepEqual(harness.notifications, [{ level: 'info', text: zh.changed }]);
  });

  test('宿主返回失败时走 error 提示通道', async () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const inputState = { draft: '草稿', draftRev: 2, phase: 'plain' };
    const drafts = [];
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector(inputState),
      inputActions: { setDraft: (text) => drafts.push(text) },
      client: { polish: async () => ({ ok: false, error: { code: 'x', message: '额度不足' } }) },
      t,
    });

    findByLabel(view.tree, '润色提示词').props.onClick();
    await flush();
    view.rerender();

    assert.deepEqual(drafts, []);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].level, 'error');
    assert.equal(harness.notifications[0].text, t('polishFailed', { message: '额度不足' }));
  });

  test('撤销按钮把原文写回草稿', async () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const inputState = { draft: '原文', draftRev: 1, phase: 'plain' };
    const drafts = [];
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector(inputState),
      inputActions: {
        setDraft: (text) => {
          drafts.push(text);
          inputState.draft = text;
          inputState.draftRev += 1;
        },
      },
      client: { polish: async () => ({ ok: true, value: { text: '润色文' } }) },
      t,
    });

    findByLabel(view.tree, '润色提示词').props.onClick();
    await flush();
    view.rerender();
    findByLabel(view.tree, '撤销润色，恢复原文').props.onClick();
    view.rerender();

    assert.deepEqual(drafts, ['润色文', '原文']);
  });

  test('润色按钮使用「星形闪光」图标，而不是旧的 Enhance 图标', () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector({ draft: '草稿', draftRev: 1, phase: 'plain' }),
      inputActions: { setDraft: () => {} },
      client: { polish: async () => ({ ok: true, value: { text: '' } }) },
      t,
    });

    const icons = walk(view.tree, (element) => typeof element.type === 'function' && element.type.displayName?.startsWith('svg-'));
    const names = icons.map((element) => element.type.displayName);
    assert.ok(names.includes('svg-sparkle'), `润色按钮应为星形闪光图标，实际：${names.join(', ')}`);
    assert.ok(!names.includes('svg-enhance'), '旧的 Enhance 图标不应再出现');
    // 空闲态不应显示加载图标。
    assert.ok(!names.includes('svg-loading'), '空闲态不应出现加载图标');
  });

  test('提交中禁用润色按钮', () => {
    const harness = createClientHarness();
    registration.factory(fakeRequire).apply(harness.ctx);
    const { component, options } = harness.slots[0];
    const injected = options.inject('session-1');

    const view = render(component, {
      ...injected,
      useInput: (selector) => selector({ draft: '草稿', draftRev: 1, phase: 'submitting' }),
      inputActions: { setDraft: () => {} },
      client: { polish: async () => ({ ok: true, value: { text: '' } }) },
      t,
    });

    assert.equal(findByLabel(view.tree, '润色提示词').props.disabled, true);
  });
});
