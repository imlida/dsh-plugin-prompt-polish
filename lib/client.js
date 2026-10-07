/**
 * 提示词润色（Prompt Polish）— 浏览器半。
 *
 * 这个文件是 DSH 客户端模块格式的手写产物：外层是
 * `window.__ModuleLoader__.load({ id, factory })`，`factory` 里是普通 CJS 风格的
 * 模块体（`require` 只能取 DSH 的「平台种子模块」，例如 react、
 * react/jsx-runtime、@deepseek-ai/dsh-client-ui-primitives）。
 *
 * 做的事：
 * 1. 往 `conversation.input.right`（输入框右下角、模型选择器之前的紧凑控件区）
 *    注册一个「润色」按钮。
 * 2. 点一下就把当前草稿通过 Host 的通用 RPC 通道交给模型改写，再整体写回草稿；
 *    写回前用 `draftRev` 做一次 CAS，避免覆盖用户在等待期间的编辑。
 * 3. 旁边提供设置入口，可直接修改「润色用的提示词」，保存到 Host 本机文件。
 *
 * @module dsh-plugin-prompt-polish/client
 */
window.__ModuleLoader__.load({
	id: 'dsh-plugin-prompt-polish',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		const react = require('react');
		const { jsx, jsxs, Fragment } = require('react/jsx-runtime');
		const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

		/** 与 Host 半约定的 RPC 通道（见 lib/index.js 的 CHANNEL）。 */
		const CHANNEL = '/dsh-prompt-polish';
		/** i18n 命名空间，同时用于 slot 的 `locale` 字段。 */
		const NS = 'prompt-polish';
		/** 样式与 DOM 标记使用的插件标识，需与包名一致以便卸载时回收。 */
		const PLUGIN_ID = 'dsh-plugin-prompt-polish';

		// #region 样式（沿用官方插件的手写 CSS 注入方式：data-plugin 用于随插件卸载回收）
		const css = [
			`.dshPP_group{display:inline-flex;align-items:center;gap:2px;flex:none}`,
			`.dshPP_anchor{display:inline-flex;flex:none}`,
			`.dshPP_button{flex:none;width:28px;padding:0}`,
			`.dshPP_spin{animation:dshPP_spin .9s linear infinite}`,
			`@keyframes dshPP_spin{to{transform:rotate(360deg)}}`,
			`@media (prefers-reduced-motion:reduce){.dshPP_spin{animation:none}}`,
			`.dshPP_dialog{width:min(600px,100%)}`,
			`.dshPP_body{display:flex;flex-direction:column;gap:10px}`,
			`.dshPP_hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:19px}`,
			`.dshPP_meta{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`,
			`.dshPP_textarea{box-sizing:border-box;width:100%;min-height:220px;padding:10px 12px;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;outline:none;resize:vertical}`,
			`.dshPP_textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary)}`,
			`.dshPP_footer{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%}`,
			`.dshPP_footerActions{display:flex;align-items:center;gap:8px}`,
			`.dshPP_error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12.5px;line-height:19px}`,
		].join('');
		const cssTagId = `${PLUGIN_ID}/prompt-polish.css`;
		if (
			typeof document !== 'undefined' &&
			document.querySelector(`style[data-plugin-css=${JSON.stringify(cssTagId)}]`) === null
		) {
			const tag = document.createElement('style');
			tag.dataset.plugin = PLUGIN_ID;
			tag.dataset.pluginCss = cssTagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		// #endregion

		// #region 文案
		const zh = {
			polish: '润色提示词',
			polishing: '正在润色…',
			undo: '撤销润色，恢复原文',
			settings: '设置润色提示词',
			empty: '输入框是空的，先写点什么再润色吧。',
			busy: '正在提交，请稍后再润色。',
			changed: '草稿在润色期间被修改过，已保留你最新的内容，没有覆盖。',
			polishFailed: '润色失败：{message}',
			title: '润色提示词设置',
			close: '关闭',
			describe: '这段文字会作为系统提示词发给模型，用来指导它如何改写你的草稿。',
			model: '使用模型：{model}',
			modelUnknown: '使用模型：跟随当前默认模型',
			placeholder: '例如：你是一名提示词润色助手…',
			restore: '恢复默认',
			cancel: '取消',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			saveFailed: '保存失败：{message}',
			loadFailed: '无法读取当前设置：{message}',
		};
		const en = {
			polish: 'Polish prompt',
			polishing: 'Polishing…',
			undo: 'Undo polish and restore the original',
			settings: 'Configure polish instructions',
			empty: 'The input is empty — write something first.',
			busy: 'A submission is in progress; try again shortly.',
			changed: 'The draft changed while polishing, so your latest text was kept.',
			polishFailed: 'Polishing failed: {message}',
			title: 'Polish instructions',
			close: 'Close',
			describe: 'This text is sent as the system prompt that tells the model how to rewrite your draft.',
			model: 'Model: {model}',
			modelUnknown: 'Model: follows the current default',
			placeholder: 'For example: You are a prompt editor…',
			restore: 'Restore default',
			cancel: 'Cancel',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			saveFailed: 'Could not save: {message}',
			loadFailed: 'Could not read settings: {message}',
		};
		// #endregion

		/**
		 * 把 UI 异常转成可展示的一行文字。
		 * @param error - 捕获到的任意异常。
		 * @returns 错误描述。
		 */
		function describeError(error) {
			if (error instanceof Error && error.message !== '') return error.message;
			if (typeof error === 'string' && error !== '') return error;
			return String(error);
		}

		/**
		 * 设置对话框：读取 / 编辑 / 保存「润色用的提示词」。
		 * @param props.open - 是否打开。
		 * @param props.onClose - 关闭回调。
		 * @param props.client - 浏览器半与 Host 的桥接对象。
		 * @param props.t - 当前语言的翻译函数。
		 * @returns 对话框元素；关闭时为 null。
		 */
		function SettingsDialog({ open, onClose, client, t }) {
			const [value, setValue] = react.useState('');
			const [defaultPrompt, setDefaultPrompt] = react.useState('');
			const [model, setModel] = react.useState(null);
			const [loading, setLoading] = react.useState(false);
			const [saving, setSaving] = react.useState(false);
			const [error, setError] = react.useState(null);
			const [dirty, setDirty] = react.useState(false);

			react.useEffect(() => {
				if (!open) return undefined;
				let cancelled = false;
				setLoading(true);
				setError(null);
				setDirty(false);
				client
					.getSettings()
					.then((result) => {
						if (cancelled) return;
						if (!result.ok) {
							setError(t('loadFailed', { message: result.error.message }));
							return;
						}
						setValue(result.value.prompt);
						setDefaultPrompt(result.value.defaultPrompt);
						setModel(result.value.model);
					})
					.catch((cause) => {
						if (!cancelled) setError(t('loadFailed', { message: describeError(cause) }));
					})
					.finally(() => {
						if (!cancelled) setLoading(false);
					});
				return () => {
					cancelled = true;
				};
			}, [open, client, t]);

			const save = react.useCallback(() => {
				if (saving) return;
				setSaving(true);
				setError(null);
				client
					.saveSettings(value)
					.then((result) => {
						if (!result.ok) {
							setError(t('saveFailed', { message: result.error.message }));
							return;
						}
						setValue(result.value.prompt);
						setDirty(false);
						onClose();
					})
					.catch((cause) => setError(t('saveFailed', { message: describeError(cause) })))
					.finally(() => setSaving(false));
			}, [client, onClose, saving, t, value]);

			const restore = react.useCallback(() => {
				setValue(defaultPrompt);
				setDirty(true);
			}, [defaultPrompt]);

			if (!open) return null;

			return jsx(primitives.Modal, {
				open,
				onClose,
				title: t('title'),
				closeLabel: t('close'),
				description: t('describe'),
				className: 'dshPP_dialog',
				children: jsxs('div', {
					className: 'dshPP_body',
					children: [
						jsx('textarea', {
							className: 'dshPP_textarea',
							value,
							disabled: loading || saving,
							placeholder: t('placeholder'),
							'aria-label': t('title'),
							spellCheck: false,
							onChange: (event) => {
								setValue(event.target.value);
								setDirty(true);
							},
						}),
						jsx('p', {
							className: 'dshPP_meta',
							children: model === null || model === '' ? t('modelUnknown') : t('model', { model }),
						}),
						error === null ? null : jsx('p', { className: 'dshPP_error', role: 'alert', children: error }),
					],
				}),
				footer: jsxs('div', {
					className: 'dshPP_footer',
					children: [
						jsx(primitives.Button, {
							variant: 'ghost',
							disabled: loading || saving || value === defaultPrompt,
							onClick: restore,
							children: t('restore'),
						}),
						jsxs('div', {
							className: 'dshPP_footerActions',
							children: [
								jsx(primitives.Button, {
									variant: 'outline',
									disabled: saving,
									onClick: onClose,
									children: t('cancel'),
								}),
								jsx(primitives.Button, {
									variant: 'primary',
									disabled: loading || saving || !dirty || value.trim() === '',
									onClick: save,
									children: saving ? t('saving') : t('save'),
								}),
							],
						}),
					],
				}),
			});
		}

		/**
		 * 输入框右下角的润色入口。
		 *
		 * props 由 DSH 的 slot 渲染器合并给出：
		 * - 会话作用域标准件：`sessionId`、`useInput`、`inputActions` 等；
		 * - 本插件注册时 `inject` 提供的：`client`、`notify`。
		 *
		 * @param props - 合并后的属性。
		 * @returns 入口元素。
		 */
		function PromptPolishEntry(props) {
			const { useInput, inputActions, client, notify, t } = props;
			const input = useInput((state) => state);
			const draft = typeof input?.draft === 'string' ? input.draft : '';
			const phase = input?.phase;
			const busySubmission = phase === 'adjudicating' || phase === 'submitting';

			const [polishing, setPolishing] = react.useState(false);
			const [settingsOpen, setSettingsOpen] = react.useState(false);
			const [undo, setUndo] = react.useState(null);

			/** 最新的 draftRev：异步写回前用它与发起时的版本比对（CAS）。 */
			const revRef = react.useRef(input?.draftRev);
			revRef.current = input?.draftRev;
			/** 在飞行中的请求，卸载时取消。 */
			const inflightRef = react.useRef(null);
			react.useEffect(
				() => () => {
					inflightRef.current?.abort();
				},
				[],
			);

			const canPolish = draft.trim() !== '' && !polishing && !busySubmission;
			const canUndo = undo !== null && draft === undo.to && !polishing;

			const runPolish = react.useCallback(() => {
				if (!canPolish) {
					if (draft.trim() === '') notify('info', t('empty'));
					return;
				}
				const controller = new AbortController();
				inflightRef.current = controller;
				const startedAtRev = revRef.current;
				const original = draft;
				setPolishing(true);
				client
					.polish(original, controller.signal)
					.then((result) => {
						if (controller.signal.aborted) return;
						if (!result.ok) {
							notify('error', t('polishFailed', { message: result.error.message }));
							return;
						}
						if (revRef.current !== startedAtRev) {
							notify('info', t('changed'));
							return;
						}
						setUndo({ from: original, to: result.value.text });
						inputActions.setDraft(result.value.text);
					})
					.catch((cause) => {
						if (!controller.signal.aborted) {
							notify('error', t('polishFailed', { message: describeError(cause) }));
						}
					})
					.finally(() => {
						inflightRef.current = null;
						if (!controller.signal.aborted) setPolishing(false);
					});
			}, [canPolish, client, draft, inputActions, notify, t]);

			const runUndo = react.useCallback(() => {
				if (!canUndo) return;
				inputActions.setDraft(undo.from);
				setUndo(null);
			}, [canUndo, inputActions, undo]);

			return jsxs(Fragment, {
				children: [
					jsxs('span', {
						className: 'dshPP_group',
						children: [
							jsx(primitives.Tooltip, {
								side: 'top',
								portal: true,
								label: polishing ? t('polishing') : busySubmission ? t('busy') : t('polish'),
								children: jsx('span', {
									className: 'dshPP_anchor',
									children: jsx(primitives.Button, {
										className: 'dshPP_button',
										size: 'sm',
										disabled: !canPolish,
										'aria-label': t('polish'),
										onMouseDown: (event) => event.preventDefault(),
										onClick: runPolish,
										children: jsx(
											polishing ? primitives.IconLoadingOutlineRegular : primitives.IconSparkleRegular,
											{ size: 18, className: polishing ? 'dshPP_spin' : undefined },
										),
									}),
								}),
							}),
							canUndo
								? jsx(primitives.Tooltip, {
										side: 'top',
										portal: true,
										label: t('undo'),
										children: jsx('span', {
											className: 'dshPP_anchor',
											children: jsx(primitives.Button, {
												className: 'dshPP_button',
												size: 'sm',
												'aria-label': t('undo'),
												onMouseDown: (event) => event.preventDefault(),
												onClick: runUndo,
												children: jsx(primitives.IconRefreshOutlineRegular, { size: 18 }),
											}),
										}),
									})
								: null,
							jsx(primitives.Tooltip, {
								side: 'top',
								portal: true,
								label: t('settings'),
								children: jsx('span', {
									className: 'dshPP_anchor',
									children: jsx(primitives.Button, {
										className: 'dshPP_button',
										size: 'sm',
										'aria-label': t('settings'),
										onMouseDown: (event) => event.preventDefault(),
										onClick: () => setSettingsOpen(true),
										children: jsx(primitives.IconSettingsOutlineRegular, { size: 18 }),
									}),
								}),
							}),
						],
					}),
					jsx(SettingsDialog, {
						open: settingsOpen,
						onClose: () => setSettingsOpen(false),
						client,
						t,
					}),
				],
			});
		}

		// #region 插件装配
		/** 浏览器半用到的客户端服务：通用 RPC、槽位、语言、会话作用域、会话输入。 */
		const inject = ['connection', 'slots', 'locale', 'sessions', 'conversation'];

		/**
		 * 通过通用 RPC 通道把调用转发给 Host 半。
		 * @param ctx - 客户端插件上下文。
		 * @param endpoint - Host 端点名。
		 * @param payload - 载荷。
		 * @param signal - 取消信号。
		 * @returns Host 的 RPC 结果（`{ok, value}` 或 `{ok, error}`）。
		 */
		async function callHost(ctx, endpoint, payload, signal) {
			const response = await ctx.connection.rpc.call(CHANNEL, endpoint, payload, signal);
			if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') {
				throw new Error('Host 返回了无法识别的结果。');
			}
			return response;
		}

		/**
		 * 安装浏览器半。
		 * @param ctx - 客户端 Cordis 上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }));

			const client = {
				polish: (text, signal) => callHost(ctx, 'polish', { text }, signal),
				getSettings: () => callHost(ctx, 'getSettings', {}, undefined),
				saveSettings: (prompt) => callHost(ctx, 'saveSettings', { prompt }, undefined),
			};

			ctx.slots.inject('conversation.input.right', () =>
				ctx.slots.register(
					{
						name: 'conversation.input.right',
						id: 'prompt-polish',
						order: 20,
						locale: NS,
						inject: (sessionId) => {
							// 官方提示通道：error 会被输入框渲染成 Toast，info 是输入框上方的内联提示。
							const actx = ctx.sessions.scope(sessionId);
							const conversation = actx?.get('conversation');
							return {
								client,
								notify: (level, text) => {
									try {
										conversation?.input.for(actx).notify(level, text);
									} catch (error) {
										console.warn('[prompt-polish] notify failed:', error);
									}
								},
							};
						},
					},
					PromptPolishEntry,
				),
			);
		}
		// #endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
