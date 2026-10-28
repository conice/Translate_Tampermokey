# 01: 释义浮窗里的收藏按钮可再次点击,把词条移出生词本

**What to build:** 词条已经在生词本里时,浮窗里的主按钮不再置灰,而是显示「移出生词本」;再点一次就把这条从生词本删掉,页面上的注音随之撤掉,按钮回到「加入生词本」。此前要移出一个词只能打开面板的删除模式。

**Blocked by:** 无

**Status:** ready-for-agent

- [x] 已收藏时主按钮可点击,文案为「移出生词本」,图标为减号,配色改用警示色(`button.primary.saved`),不再使用收藏的主色
- [x] 同一个按钮在收藏与移除之间切换,不新增第二个按钮,`button.primary` 选择器对既有测试保持有效
- [x] 点击移除后,`book.remove(entryId)` 真正删掉词条,随后刷新注音层,页面上该词的注音消失
- [x] 移除后按钮立即回到「加入生词本」,可以再点一次收藏回来
- [x] 文案跟生词本的真实状态走:生词本没收下的收藏(`addEntry` 返回 `false`)不谎称已收藏;生词本里已不存在这条(移除返回 `false`)不谎称已移除
- [x] 超过词条上限的查询仍只有一个禁用的按钮,写「过长,仅可查看」,既不能收藏也不能移除
- [x] 切换词典等导致浮窗重渲染时,按钮保留当前所处的状态
- [x] 新增 `removeEntry(book, entry, onRemoved)` 与 `addEntry` 对称,找不到词条时返回 `false`
- [x] 新增测试:已收藏时按钮可点且文案为移除、收藏后再点变移除、生词本拒绝收藏时文案不变、移除落空时文案回到收藏、超长词不可移除;`removeEntry` 的删除与落空两种情况
- [x] 新增端到端冒烟测试:收藏 → 注音出现 → 浮窗里移除 → 注音消失、存储为空、按钮复位
- [x] 现有测试全部保持通过;`npm run build` 正常产出

## Comments

**实现**

- `src/ui/popup.js`:主按钮改为两态开关,状态由 `showSaved(saved)` 同时写入 DOM 与 `state.alreadySaved`;`onAdd` 返回 `false` 时不切到已收藏,`onRemove` 返回 `false` 时切回未收藏。
- `src/app/lookup-flow.js`:新增 `removeEntry`,先确认 `book.has(entryId)` 再删,删掉后才回调 `onRemoved`。
- `src/main.js`:`onRemove` 走 `removeEntry(book, entry, () => refreshGlosses({ force: true }))`,保证注音层按新词表重扫。
- 文档:`README.md` 使用表新增「移出生词本」一行、设计要点新增「收藏按钮是开关,不是一次性的」、验证段与真机手测清单各补一条;`GLOSSARY.md` 的「释义浮窗」定义补上移除操作。
