# 04: 注音可读性

**What to build:** 注音在深色正文、彩色小标题、白字黑底这类站点上都能读出来,因为它的颜色跟随所在文字的颜色,而不是固定灰;站点的全局样式也不会把注音的字号、颜色或排版改掉。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 注音颜色改为跟随宿主文字颜色并降低不透明度,在浅色与深色页面上都能读;浏览器不支持颜色混算时有回退方案
- [x] 括号、字号、左右边距、不换行、不可选中这些排版属性保持显式设定
- [x] 关键属性(字号、颜色、边距、不换行、不可选中、指针样式)全部带 `!important`,类名不变
- [x] 现有注音 DOM 测试全部保持通过(幂等、跳过代码块与可编辑区、嵌套容器不重复处理)
- [x] 新增测试:注入的样式规则对关键属性带 `!important`
- [x] 该样式仍然只注入一次,不随刷新重复添加

## Comments

**实现**

- `src/ui/gloss-layer.js` 的 `STYLE_TEXT`:
  - 颜色从固定 `#6b7280` 改成 `color: currentColor`。固定灰在深色正文上消失,在彩色小标题上也是错的颜色;跟随宿主文字则在哪里都和上下文一致。
  - 压暗用的是 `opacity: 0.62`,这是所有引擎都有的回退;再用 `@supports (color: color-mix(in srgb, currentColor 62%, transparent))` 升级成真正的半透明颜色,并把 `opacity` 还原为 1。两者视觉效果接近,但 `color-mix` 不会给整个元素建层叠上下文。
  - 62% 是算过的,不是拍的:黑字在白底上约 6.2:1,白字在 `#1c1c1e` 上约 7.2:1,0.78em 的小字也够看。
  - 字号、颜色、左右边距、`white-space`、`user-select`、`cursor` 全部加 `!important`。这份样式注入宿主 `<head>`,与站点 CSS 同源同权重,不加 `!important` 时一条 `article span` 就能把它盖掉。
  - 新增 `margin-right: 0.12em`,补上原实现只有左边距导致注音紧贴后续文字的问题。
  - 类名与 `::before` / `::after` 的括号不变。
- 顺手改了一处:`start()` 里的 `IntersectionObserver` / `MutationObserver` 改成读 `window.` 上的,与同文件里 `NodeFilter` 的写法一致,也让 jsdom 的桩能覆盖 `start()` 路径(注入一次这条测试要用到)。

**测试**(`test/gloss-layer.dom.test.mjs` 新增 3 条,共 16 条)

- 关键属性每一条都带 `!important`,且样式里仍然出现 `ANNOTATION_CLASS`。
- 基础规则是 `currentColor` + 不透明度,并有 `@supports` 的 `color-mix` 升级。
- `pass` / `refresh` / `start` 反复执行后 `#tm-gloss-style` 仍只有一个。

全量 191 条通过。

**范围说明**

本 ticket 只改样式。`refresh` 里仍然调用全页 `document.normalize()`,那是 05 的内容(它会合并整页文本节点,React/Vue 站点依赖节点身份)。