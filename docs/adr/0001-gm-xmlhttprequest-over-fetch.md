# 通过 GM_xmlhttpRequest 请求第三方服务

脚本运行在任意站点上,页面的 CSP 与 CORS 会阻止 `fetch` 直接请求翻译服务,即使这些服务本身返回 `Access-Control-Allow-Origin: *`(例如 `freedictionaryapi.com` 不返回该头)。因此所有外部请求都经 `GM_xmlhttpRequest`,并在元数据 `@connect` 中逐个声明域名。代价是域名清单必须随翻译源变更同步维护,漏声明会在运行时静默失败。