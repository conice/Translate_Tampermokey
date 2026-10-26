# Translate Tampermokey

Tampermonkey 用户脚本:双击网页上的词 → 浮窗显示翻译 → 一键收藏进生词本 → 生词本里的词在该站点的页面上以「原文(译文)」形式常驻。

## 安装

```bash
npm install          # 只为测试,运行时不依赖任何包
npm run build        # 生成 dist/translate-tampermokey.user.js
```

把 `dist/translate-tampermokey.user.js` 拖进浏览器,或打开 Tampermonkey 面板 → 添加新脚本 → 粘贴内容。

## 使用

| 操作 | 位置 |
| --- | --- |
| 双击取词 | 任意网页,默认开启 |
| 加入生词本 | 浮窗里的按钮(超过 5 个词或 40 字符时不可收藏) |
| 发音 | 浮窗里的 🔊,优先用系统 TTS |
| 打开生词本 / 设置 | Tampermonkey 菜单 →「打开生词本 / 设置」 |
| 本站注音开关 | Tampermonkey 菜单 →「开启/关闭本站注音」,或面板「设置」页 |
| 本站目标语言 | 面板「设置」页,留空则按页面语言自动判断 |
| 导入 / 导出 | 面板「设置」页,JSON 格式 |

## 设计要点

- **目标语言**:页面主语言非中文 → 译成中文;是中文 → 译成英文(见 `GLOSSARY.md`)。
- **注音默认关闭、按站点开启**:它要改写宿主页面的文本节点,是最容易把页面弄坏的部分(`docs/adr/0003`)。
- **注音只匹配生词本里的词**:不做整页双语对照(`docs/adr/0004`)。
- **翻译源为有序失败转移**:`clients5 → mymemory → lingva`,全部免费、全部**不保证稳定**(`docs/adr/0002`)。
- **所有请求走 `GM_xmlhttpRequest`**:绕过页面 CSP 与 CORS(`docs/adr/0001`)。
- **缓存 key 不含 provider**:换源不会让已看过的译文失效(`docs/adr/0005`)。

## 验证

```bash
npm test
```

覆盖三层:

1. **纯逻辑**(`core/`):归一化、语言判定、缓存 TTL/LRU、provider 解析、词形、匹配器。
2. **DOM**(jsdom):注音层的幂等、跳过 code/contenteditable、嵌套容器不重复处理、`refresh` 能还原原文。
3. **打包产物冒烟**(jsdom + 打桩的 `GM_xmlhttpRequest`):启动、双击查询、收藏、失败转移、全挂时的错误态、菜单开关、缓存去重。

这些测试都跑在 Node 里,**没有在真实浏览器里跑过**。装好后请手动确认一次:双击一个英文词出浮窗、收藏、菜单里开启本站注音后该词右侧出现译文。

## 已知限制

- 免费翻译源随时可能失效或封 IP,`clients5` 是 Google 未公开的内部接口。
- `lingva.ml` 的公共实例在 2026-10-26 的实测中只回显原文而不翻译;它排在 MyMemory 之后,主要作为自建实例的接口。
- 词典信息(音标、释义)只支持英文单词;中文词条只有译文。
- 宿主站点重渲染可能抹掉注音,MutationObserver 会重放,但不保证覆盖所有框架的写法。
- 无云同步;换设备靠面板里的 JSON 导入/导出。

## 目录

```
src/core/   纯逻辑,无 DOM
src/app/    查询流程与 GM 存储适配
src/ui/     浮窗、面板、注音层
build.mjs   零依赖打包器(把 ESM 子集内联成一个 userscript)
```

本仓库的挂载点不支持符号链接,npm 无法安装 esbuild 之类的打包器,所以 `build.mjs` 自己做了拓扑内联。它只支持本仓库用到的语法子集(具名相对导入 + `export` 声明),遇到之外写法会直接报错而不是产出坏包。