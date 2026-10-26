# 03: 句子模式与超限提示

**What to build:** 选中一句话查询时,译文保留原有大小写与分段,浮窗只给译文、复制、发音和关闭,不请求词典、不显示收藏区;选中的文本超过 400 字符时,选区旁浮出一句短暂提示,而不是毫无反应。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 新增一条只整理空白的文本路径:折叠内部连续空白、去首尾空白、保留大小写与换行;它有单元测试,并与现有的归一化路径互不影响
- [x] 查询流程按「是否可作为词条」(不超过 40 字符且不超过 5 个词)分流:词条模式行为不变,句子模式走新路径
- [x] 句子模式的译文中保留大小写与换行,不再被转成小写或压成一行
- [x] 句子模式不请求词典、不计算原形、不显示「加入生词本」和「过长,仅可查看」
- [x] 超过 40 字符但不超过 400 字符的选区,浮窗显示译文、复制、发音、关闭四项
- [x] 词条模式也提供「复制译文」
- [x] 复制失败(例如站点拒绝剪贴板权限)时不报错、不影响其他操作
- [x] 选区超过 400 字符时,在选区旁显示一句「最多 400 字」,2 秒后自动消失,复用现有的放置逻辑
- [x] 打包产物冒烟测试覆盖:41 字符选区只出现译文相关控件且没有词典请求;超 400 字符选区出现提示
- [x] 现有词条模式的测试全部保持通过

## Comments

**实现**

- `src/core/normalize.js`:`normalizeSentence`。只动空白 —— 每行的连续空格折叠成一个、行首行尾的空白去掉、开头结尾的空行去掉,`\r\n` / `\r` 统一成 `\n`,大小写与标点原样。它与 `normalizeTerm` 各自独立,互不调用。
- `src/app/lookup-flow.js`:
  - `readSelection` 从「返回字符串」改成 `{ status, text }`。超长和空选区必须分开:`too-long` 值得一句提示,`empty` 只值得安静。
  - `lookup` 用 `canBecomeEntry(text)` 分流。词条模式仍走 `normalizeTerm`,行为不变;句子模式直接把 `normalizeSentence` 的结果送给翻译源,跳过词典、词形提示、`alreadySaved` 与词条对象,`canSave` 恒为 false。
  - 句子模式 `lookup` 返回 `[]`:句子不是词条,调用方不该以为拿到了可保存的东西。
- `src/ui/popup.js`:新增 `sentence` 形态 —— 只有译文 + 复制 + 发音 + 关闭;`.wrap.sentence .translation { white-space: pre-wrap }` 保留分段。复制按钮两种形态都有,复制失败(返回 false 或抛错)时标签不动。关闭按钮的显隐改为在 `render` 里写内联 `display`,不再依赖 `.wrap.touch .close` 这条 CSS:句子在桌面端也需要它。
- `src/app/clipboard.js`(新增):优先 `navigator.clipboard.writeText`,失败或被拒时退回 `textarea + execCommand('copy')`,用完立即移除。两条路都失败返回 `false`,永不抛。
- `src/ui/hint.js`(新增):复用 `placeNear`,2000ms 后自行消失;重复 `show` 会先清掉上一个计时器,不会叠加。
- `src/main.js`:双击路径接 `readSelection` 的三种状态;`too-long` 显示提示;`createPopup` 增加 `window` 与 `onCopy` 依赖。

**测试**:新增 `test/clipboard.test.mjs`(5)、`test/hint.test.mjs`(4)、`test/popup.dom.test.mjs`(6),`normalize` / `lookup-flow` 补充句子与空白路径的用例,冒烟测试增加 3 条(句子无词典请求与无收藏、词条复制、超 400 字符提示)。全量 188 条通过。

**一处已知缺口,留给 06**

触屏路径的 `selectionTerm` 仍然走 `normalizeTerm`(会转小写),所以触屏上 41–120 字符的选区虽然会被判成句子模式,送进翻译源的却是小写文本。06 会把触屏入口放宽到 400 字符并允许跨行,届时必须把它一并改成 `normalizeSentence`,并改写 `test/gesture.test.mjs` 里「多行选区不出气泡」那条断言。本轮没有动它,是为了让 03 的改动范围只落在桌面路径上。