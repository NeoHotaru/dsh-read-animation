# dsh-read-animation

让 DeepSeek Harness 里的 agent **真的看懂动图**。

用 `read_image` 读一张 GIF，模型只拿到一帧——第一帧——而且完全不知道后面还有七帧。
这个插件把每一帧都解出来，按时序采样若干帧，连同「这是同一个动画的连续瞬间」这个
事实一起交给模型。

```sh
dsh plugin --profile web add dsh-read-animation
```

English | [English README](README.md)

---

## 问题出在哪

DeepSeek Harness 在做任何图片入库时，都会先归一化成「单帧 8 位 sRGB 位图」，
**动图也不例外**。`@deepseek-ai/dsh-attachment-local` 的直通判定里明确排除了
`image/gif`，重编码管线又从不设置 `animated` / `page`，于是 `sharp` 只返回第 0 页，
其余帧直接丢掉。

本机实测，一张 8 帧 GIF：

```
metadata:  {"format":"gif","width":240,"height":160,"pages":8,
            "delay":[80,80,80,80,80,80,80,80],"loop":0}
default -> 240x160  pages=1     ← read_image 交给模型的就是这个
animated -> 240x1280 pages=1    ← 主动要，才会有全部八帧
```

**这个问题在读取之上任何一层都修不了。** 等视觉插件、图片路由、LLM 适配器看到这张图时，
它早已是单帧了。所以 [dsh-multimodal](https://github.com/SCT192221/dsh-multimodal)、
[dsh-mmroute](https://github.com/jmxsxwyzjdwl/dsh-mmroute)、
[dsh-vision-mix](https://github.com/haiziyao/dsh-vision-mix)、
[dsh-tool-plus](https://github.com/xiaoso456/dsh-tool-plus) 这些插件都写着
「支持 PNG/JPEG/WebP/GIF」，却没有一个能让你看见「动」。动画仍然完好的地方只有一处：
文件本身。所以工具就放在那里。

APNG 得的是同一种病，而且更隐蔽：libvips 8.18.7 根本不认 `acTL` / `fcTL` / `fdAT`，
把 APNG 当成单页 PNG，第一帧之后的全部静默丢弃。本插件直接从 chunk 流里识别这种情况，
**点名拒绝**，而不是假装成功地返回第 0 帧。

## 两个入口，都修好了

**入口一 · 贴进聊天框。** 浏览器那段路本身是干净的——粘贴处理器把 `clipboardData` 里的原始
`File` 直接交出去，上传路径对 `image/gif` / `image/webp` 原样编码（`imageMediaType()` 明确
接受这两种并原样返回），没有 canvas、没有 `drawImage`、没有 `toBlob`。**字节完好地到达宿主。**
丢掉它的是宿主自己：`admitPromptContent` 把每张图都过一遍「单帧」归一化，源字节不保留。

`admitPromptContent` 是**原件还存在的最后一刻**，所以本插件在这里把它解码、把帧存下来——
然后**把原样的结果还回去**：

```
你贴 1 张动图
   ├─ 消息：完全不变，还是你发的那一张图，一个字都没多
   ├─ 界面：动图本身，用原件字节播
   └─ 模型：一张胶片条，每格标着帧号和时间
```

**你发什么就是什么。** 你的消息正文一个字都没多，也不会变成八张静态图。

**而且界面里它继续动。** Web UI 显示一张持久图片只有一条路：`session.readAttachment(id)` →
宿主 `ctx.attachments.readImage(ref)` → `URL.createObjectURL(new Blob([bytes], { type: attachment.mediaType }))`。
字节和 MIME **都来自那一次宿主调用**，浏览器拿到什么就播什么。所以本插件在**显示读取**那一层
返回动图原件——不需要客户端插件、不需要新路由、不需要第二套鉴权。库里那张单帧只是"装不下动"
的归一化产物；"读这张已存的图"更诚实的答案本来就是原件，同一层的另外两个调用方（ACP 图片块、
会话日志导出）拿到动图也只会更好。

每帧自己的身份写在附件显示名里（`x.gif#frame16@1960ms`），harness 会把每个图片块
渲染成 `Image "<附件名>" …`——时序已经贴在帧上了，只等下面那一步交付。

**显示那条路与模型那条路互不影响**：界面那份由 `readImage` 提供原件，
而模型那份由 `readImageRequest` 拼成胶片条。

> **帧是怎么交到模型手里的**：`readImageRequest(ref, target, signal)` 是每个适配器用来生成
> 自己那一份图片的方法（`dsh-llm-deepseek` 和 `dsh-llm-pi-ai` 都走它），所以它是通往模型的那
> 条缝。它每次只回一张图，所以帧被拼成一张带标注的胶片条：手机比例动画采 8 帧就是 4x2 网格，
> 每格都是原始分辨率，格下印着帧号、该帧时长和起始毫秒。每次请求都重新推导是不必要的——同一个
> 附件永远得到同一张胶片条——而且它只构建一次并缓存。
> 
> 那条看起来最顺理成章的路——在 `llm/stream` 监听器里改写请求——是**设计上封死的**：loop 构造的
> 请求「深冻结到达（改写会抛）：它的内容是会话日志的纯函数」，监听器只能读、不能改。本插件早先
> 正是这么做的，结果是静默失效——因为支撑它的探针用的是手搓请求，恰好是文档豁免的那一种。

**入口二 · 文件。** 工作区里的动图、用「附件」方式发进来的文件，原件都还在磁盘上，
交给下面的 `read_animation` 工具读。

## 它返回什么

`read_animation(path, …)` 返回一段文字信封，加上「每帧一条说明 + 一张图」：

```
<path>D:\work\dance.gif</path>
<type>animation</type>
<content>
image/gif animation, 480x270 px, 24 frames, 1200 ms total, ~20 fps, loops forever.
Attached below are 6 frames sampled evenly in time from this animation. They are
consecutive moments of the SAME animation, in time order, not separate images;
each is preceded by its frame index and start time.
Only frames 0, 4, 9, 13, 18, 23 of 24 were sampled, so any motion between two
attached frames is not visible. Re-read with explicit "frames" indices to inspect
a specific moment, or a higher "max_frames" to sample more densely.
</content>
```

然后每帧：

```
frame 9 of 24 (sample 3) · starts at 450 ms · displayed for 50 ms
[ 图片 ]
```

模型要推理「动」，需要的东西全在这段文字里：总时长、播放速度、是否循环、正在看的是哪几帧，
以及——最容易出错、所以直说——**帧与帧之间是有空档的**。

## 安装

```sh
dsh plugin --profile web add dsh-read-animation
```

`web` 换成你自己的 profile 名。**目前还没发到 npm** —— 在那之前从源码装：

```sh
cd dsh-read-animation
npm install                                     # 拉取 sharp
dsh plugin --profile web add link:$PWD
```

同一个 spec 在 Web 侧边栏的 Plugins 页也能用；设置里的插件列表是只读的。装完**重启正在跑的
实例**：插件行在下一个进程才生效，`link:` 的检出版本只在启动时加载一次。

## 用法

工具描述里写明了「读 .gif 用它而不是 read_image」，所以模型自己会改道。也可以直接要求：

> 这个 GIF 里发生了什么？—— `animations/loading-spinner.gif`

参数：

| 参数 | 含义 |
|---|---|
| `file_path` | 要读的动图（必填） |
| `frames` | 指定 0-based 帧号，按给定顺序返回，最多 16 个 |
| `at` | 指定毫秒时刻采样，代替均匀采样 |
| `max_frames` | 采样帧数（默认 8，上限 16） |
| `max_edge` | 每帧长边像素（默认 640） |

第一次看得不够细时的常用循环：

```
read_animation { file_path: "dance.gif" }              → 时间轴上均匀 8 帧
read_animation { file_path: "dance.gif",
                 frames: [11, 12, 13], max_edge: 1024 } → 就这三帧，原尺寸
```

## 配置

可选，写在 profile 的 `cordis.patch.yml` 里那一行：

```yaml
- id: read-animation
  name: 'dsh-read-animation'
  config:
    maxFrames: 8          # 每次调用的默认帧数，1..16
    maxEdge: 640          # 默认长边上限，64..2048
    background: white     # white = 透明压白底；keep = 保留 alpha
    maxInputBytes: 67108864   # 超过这个大小的动图直接拒绝
    expandPastedAnimations: true   # 贴进聊天框的动图：界面里继续播，模型拿到一张胶片条
```

## 它不做什么

- **视频**。MP4/WebM 要 ffmpeg，是另一条解码链路。用
  [`dsh-video-tools`](https://github.com/PiedPiper911/dsh-video-tools)。
- **APNG**。宿主图像库解不了，会带解释地拒绝（见上）。
- **静态图**。会明确说「用 read_image」。单帧 GIF / WebP 会正常返回，并注明它不是动图。
- **猜**。采样帧数少于你要求的，信封里会写清是哪几帧、为什么。

## 内部行为

每一帧都通过 `ctx.attachments.saveImages` 入库——和 harness 里其他所有图片走同一条路。
于是：内容是内容寻址的（同一张 GIF 里两帧完全相同只占一份存储；重复读同一个文件复用已有
附件）、跨会话回放可取回、受部署自身的图片限额约束。帧在入库前已按目标边长缩放并重编码为
PNG，所以 harness 的归一化管线对它无事可做。

读取走 `ctx.fs.readBytes` 并发出 `fs/observed`，因此沙箱与「先读后写」策略的作用方式和
`read_image` 完全一致。当解析出的模型路由未声明图片输入时，工具会拒绝执行——理由和
`read_image` 相同。

**贴进聊天框的动图**分三步，都不碰你的消息：**捕获**在准入层
（`ctx.attachments.admitPromptContent` 是原件还在的最后一刻），**显示**在
`ctx.attachments.readImage`（界面取图的那一次读，返回原件所以会动），**交付**在
`ctx.attachments.readImageRequest`（模型那份，拼成一张带标注的胶片条）。三步都是
**猴补核心服务的方法**，所以写得很保守——
方法不存在、赋值失败、解码抛错、原件读不回来、预算不足，任何一条不满足就什么都不做，调用方
拿到的永远是自己本来就该拿到的东西。捕获到的帧和原件记在
`$DSH_HOME/read-animation/v1/pasted.jsonl`，按消息里那个附件的 id 索引：会话跨进程恢复后，
旧消息里的动图仍然能显示、也仍然能给模型展开，而不只是内存里活着。交付那一步只换引用
（这一层图片还是 `{type:'image', attachment}`），从不碰字节。

### 给贡献者的两条设计说明

**抽帧用的是逐帧 `sharp(buf, { page: i })`，不是「整条解码成竖条再切」。** 两者在一张
600×400、60 帧的 GIF 上量过：竖条方案常驻 54.9 MiB，而且在这里**更慢**（512 px 目标下 8 帧
要 228 ms，因为它把全部 60 帧都缩放了），逐帧方案 182 ms、同一时刻只驻留一帧。这个结论依赖
的正确性——`{ page: i }` 与竖条中第 i 帧逐字节相同——由测试钉死。

**这个包在运行时完全不 import `@deepseek-ai/*`。** harness 自家工具都用 `defineTool` 构造定义
（编译 schema + 包装参数校验）。对**作为包安装**的插件这是对的：pnpm 会把它放进
`$DSH_HOME/profiles/<name>/node_modules/`，`@deepseek-ai/*` 顺着目录往上找就能命中 profile 的
提升树。但对**从工作副本 link 进来**的插件就不成立了：`link:` 的包按真实路径加载，它的 import
从检出目录往上找，那里根本没有 `@deepseek-ai/*`——这是实测的，把 `node_modules` 移开后导入
入口直接 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`。所以
`lib/tool.js` 把编译后的 JSON Schema 作为字面量和「作者态 spec」并排放着，集成测试会断言真正的
`defineTool` 从那份 spec 推导出的结果与字面量完全一致。改 spec，跑 `npm run derive-schema`，
把输出贴回去。

## 开发

```sh
npm install
npm test                 # 解码 / 采样 / 信封 / 参数校验
npm run test:integration # 真实 dsh-fs、dsh-attachments、dsh-tools，进程内跑
npm run fixtures         # 重新生成 test/fixtures（需要 Python 3 + Pillow）
```

`npm test` 只需要 Node 和装好的 `sharp`。

`npm run test:integration` 会在进程内挂载真正的 `dsh-fs-local`、`dsh-attachment-local`、
`dsh-system-prompt`、`dsh-tools`，注册工具并真实执行。它存在的唯一目的，是证明**没有单元测试
能够触及、而整个设计都压在它身上**的那件事：一个 tool result 里塞进**多张**图片，能活着穿过真
的注册表和真的附件服务。只桩掉了 `llm` 服务与 agent 对象——两者都需要活的模型会话。指向你的
harness 安装：

```sh
DSH_HARNESS_MODULES="$(npm root -g)/@deepseek-ai/dsh/node_modules" npm run test:integration
```

如果检出目录里找不到 `sharp`，可以用
`DSH_READ_ANIMATION_SHARP=<可加载的 sharp 路径>` 覆盖解析。

测试夹具是提交进仓库的，所以跑测试不需要 Python；`make-fixtures.py` 负责重新生成，并逐条说明
每个夹具是干什么用的。

## 许可

MIT。sharp 与 libvips 见 [THIRD_PARTY.md](THIRD_PARTY.md)。
