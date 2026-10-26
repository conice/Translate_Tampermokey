# 翻译源采用有序失败转移,首选 clients5

2026-10-26 实测:Google 的 `translate_a/single?client=gtx` 端点对当前网络返回 429「automated queries」,不可用;`clients5.google.com/translate_a/t?client=dict-chrome-ex` 免 key、支持 `q` 多值批量、`sl=auto` 时直接返回检测出的语言,可用;`lingva.ml` 与 `api.mymemory.translated.net` 亦可作为备选。

据此决定:翻译源为有序链 `clients5 → lingva.ml → mymemory`,全部可配置。

拒绝单源方案,因为任一免费源都随时可能失效;拒绝仅用 MyMemory,其匿名额度不足以支撑整页注音所需的批量查询。

需要长期记住的前提:`clients5` 是 Google 未公开的内部接口,不面向第三方,无任何可用性承诺,可能随时失效或封禁来源 IP。免费源在本文档中的含义是「免费但不保证」,不是「稳定服务」。