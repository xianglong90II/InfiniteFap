# InfiniteFap Web

浏览器本地运行的音乐游戏单轨铺面预览器。导入音乐和可选背景视频后，以 `beat-detection-tcn` ONNX 模型检测节拍，生成单轨 tap Note 并随音乐播放预览。无后端、无云端推理。

## 启动

```sh
npm install
npm run dev
```

校验：

```sh
npm test
npm run build
```

## 模型

- PyTorch checkpoint：`public/models/beat-detection-tcn.pt`，来自 [Hugging Face](https://huggingface.co/finnvoorhees/beat-detection-tcn)，MIT。
- 浏览器模型：`public/models/beat-detection-tcn.onnx`（约 1.1 MB），通过 `scripts/export_beat_tcn.py` 导出并验证。
- 前处理按模型配置执行：单声道重采样至 22050 Hz、81-bin HTK log-Mel（2048 FFT、220 hop、30–11000 Hz、power=2、log1p）。推理在 Web Worker 中使用 ONNX Runtime Web；WebGPU 不可用/不兼容时回退 WASM。
- 铺面难度可选简单/普通/困难：简单档保留普通档的节拍阈值并加大 Note 最小间隔，减少密集 Note，同时可连续命中累计 Combo；更换难度后点击“重新铺面”重新分析。

## 铺面预览

- 一条轨道，每个模型检测到的节拍对应一个 tap Note，默认显示心形；琴键使用镂空心形 Note 图标。
- Note 图库目前提供心形、星形和闪光 SVG，资源来自 Google Material Design Icons，Apache-2.0。
- 可导入多个 MP4/WebM/MOV 视频，选择一条作为铺面背景；视频静音并跟随音乐播放/暂停/跳转，较短视频循环播放。
- 左侧视频素材菜单分“导入/排片”两个标签；独立 Worker 每秒抽 2 帧并缩放到 320×180，GPU 优先提供逐像素帧差和 256-bin 灰度直方图两种模式，CPU 回退；场景片段保存平均 Motion Score，可选按运动强度优先排片。JSON 和缩略图缓存到 IndexedDB，分析模式也参与缓存键。
- 单轨波形上方显示视频分镜缩略轨道；视频片段与音频共用时间轴，滚轮缩放刻度、拖动平移，点击刻度尺或分镜块定位；波形区域拖动定位、单击不跳转。
- 排片默认无排片，按导入页影片顺序连续循环播放完整影片；自动模式只使用勾选的普通片段，可调整影片队列顺序、按影片分组随机或所有片段独立随机。片段可从中间、随机或自定义位置开始，并为转场预留尾帧；片段过短时从头播放。
- 自动排片底部提供交叉淡化、四向擦除、缩放淡出、模糊淡出、闪白切换共 8 种转场预设，可调转场时长；默认谱面难度为简单。可指定独立爆点片段并标记谱面爆点，提前 5 秒倒计时，到点替换排片并播放爆发特效。
- 主体菜单“视频显示”标签可选择 1080p/720p/竖屏/方形画布，以及填满裁切、完整显示或拉伸填充模式。
- 自动预览 Note 以 PERFECT 命中反馈展示并累计 Combo，漏过节拍时连击归零；命中时有扩散光圈、闪光、判定线脉冲及可关闭的轻量合成打击音。
- 铺面右上角可开关剩余时间显示；播放位置、节拍 Note、背景视频和完整歌曲波形同步，可点击时间轴跳转。
- 已命中的 Note 会从下落轨道移除；倒回时间轴时，后续 Note 会重新出现。
- 圆形衣服按钮打开主体菜单，分为“琴谱设置”“命中特效”“爆点特效”和“视频显示”四个标签。视频显示可设置画布尺寸及填充模式；命中特效保留原有闪白、缩放、晃动、负片和边缘红影选项；爆点特效可设置星爆、冲击波、棱镜或脉冲样式、边缘白影、焦散、强度和默认 3 秒时长。
- 琴键可点按并显示缩放/高亮；自动节拍命中时，Note 与琴键同步 hit-stop 55ms，随后 Note 从轨道移除。横轨 Note 从右向左驶向左侧判定键；铺面播放头按约 60fps 更新。
- 竖轨可调宽度百分比，横轨可调高度百分比，两个尺寸独立保留；轨道底色透明度也可调节。Note 颜色可选择薄荷绿、紫、蓝、粉、金、白。铺面难度可选简单/普通/困难，分别控制节拍置信阈值及最小 Note 间隔；参数调整后点击“重新铺面”应用。
- 自定义 GLSL 片元 Shader 可在菜单内预览代码、编辑、导入、导出，并保存至浏览器 localStorage。游戏 uniforms：`uIntensity`（命中强度）、`uSymbol`（Perfect=0/Good=1/Bad=2/Miss=3）、`uDuration`（秒）；同时提供 `uTexture`、`uResolution`、`uVideoAspect`、`uTime`、`uHasVideo`、`uEffects`、`uWhiteEdge`。
- 音乐文件仅在当前浏览器会话处理，刷新页面需重新导入。

M4A 等不受浏览器原生解码/播放支持的音乐格式会通过本地 FFmpeg WASM 转为 WAV，同时用于分析和播放器播放；首次使用需加载其 WASM 核心。
