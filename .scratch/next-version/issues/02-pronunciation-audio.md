# 02: 真人发音

**What to build:** 点释义浮窗的发音按钮,优先播放词典源提供的真人录音(美音优先,其次英音,再次任一可用录音);正在播放时再点一次停止;录音取不到、被页面策略挡住或播放失败时,静默回退到现有的系统 TTS,按钮仍然只有一个,不出现错误提示。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [x] 词典解析出的音频地址不再被丢弃,一路传到浮窗的渲染状态里
- [x] 选音是纯函数:在多个录音中按美音、英音、任一非空的顺序挑一个;没有录音时返回空;该函数有单元测试覆盖「只有美音」「只有英音」「只有其他口音」「一个都没有」四种情况
- [x] 音频请求走一个与现有文本请求并列的可注入依赖,使用用户脚本管理器的二进制响应模式;音频域名与词典接口同域,元数据的域名白名单不需要新增条目
- [x] 播放中的再次点击会停止当前播放,不会叠着播
- [x] 播放结束或出错时释放创建的临时对象地址,不泄漏
- [x] 没有录音、取录音失败、播放失败三种情况都回退到系统 TTS,且不弹任何错误
- [x] 音频地址不写进词条,不改动生词本的数据结构
- [x] 打包产物冒烟测试覆盖:词典响应带音频 → 发出音频请求并播放;词典响应不带音频 → 不发出音频请求,直接走 TTS
- [x] README 手测清单补一条:真机点发音按钮能出声

## Comments

**实现**

- `src/core/providers.js`:新增纯函数 `chooseAudio(phonetics)`。按**文件名**里的 `-us` / `-uk` 选口音,而不是按数组位置 —— 实测 `api.dictionaryapi.dev` 对 `run` 同时返回 `run-au.mp3` 和 `run-us.mp3`,且 au 排在前面,按位置会选错口音。协议相对地址(`//...`)补成 `https:`。
- `src/main.js`:原来的 `fetchText` 与新增的二进制取数合并为一个 `request(url, { binary })`,超时、状态码与错误映射只写一遍;音频走 `responseType: 'blob'`。音频域名与词典接口同为 `api.dictionaryapi.dev`,**没有新增 `@connect`**(已用 live 请求核实)。
- `src/app/pronunciation.js`(新增):`createPronouncer({ fetchBlob, createAudio, objectUrls, speakText })`。四个外部效果全部注入,因此可以在 Node 里测。取消用一个自增 token,而不是若干布尔量:第二次点击既要停掉正在播的录音,也要让仍在 `await` 的下载作废。`onended` / `onerror` 都带创建时的 token 值,用户已经停掉之后到达的过期错误不会再触发 TTS。
- `src/app/lookup-flow.js` / `src/ui/popup.js`:渲染状态新增 `audio`,发音按钮把它传给 `onSpeak`;词条对象不含 `audio` 字段。
- `test/pronunciation.test.mjs`(新增,10 条):录音优先、无录音走 TTS、下载失败、解码失败、`Audio` 构造失败、播放中再点、下载途中取消、`onended` 释放、停止后的过期 error 不再发声、停止前的 error 仍回退。
- `test/providers.test.mjs`:新增 `chooseAudio` 的四种情况 + 协议相对地址 + 「按文件名而非位置选口音」。
- `test/userscript.smoke.test.mjs`:新增 6 条冒烟测试;断言录音请求确实带了 `responseType: 'blob'`(记录在 `downloads`),下载失败时**没有**创建对象地址所以不释放,播放失败时对象地址被释放。

**留给用户决定的一点**

当前语义是「全局同时只播一个音」:录音在播时点任何词,都只是停掉当前录音,不会接着播新词。另一种做法是「按词播放」:点另一个词直接切到那个词的录音。倾向于哪一种需要产品决定,目前的实现与测试按前者。

**未验证**

只有 Node + jsdom(打桩的 `Audio` / `URL.createObjectURL` / `GM_xmlhttpRequest`)。真机出声、锁屏或切后台后的行为、以及 iOS 上 `Audio` 自动播放策略,仍需按 README 的手测清单确认。