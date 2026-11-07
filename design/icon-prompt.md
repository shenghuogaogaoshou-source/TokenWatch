# TokenWatch 图标 · 提示词包

目标：**保留现有蓝色单片眼镜骨架，只做气质层面的优化**。不加镜腿、不加反光弧，保持抽象。

---

## 一、设计规格（这是评审基准，AI 出图后拿它对照）

| 项 | 值 | 说明 |
|---|---|---|
| 画布 | 1024 × 1024 | 正方形 |
| 底 | 圆角方形，圆角半径 230px（≈22.5%） | Windows / macOS 图标规范区间 |
| 底色 | `#171E30` → `#090C14` 垂直渐变 | 深靛蓝转近黑 |
| 外环外径 | 614px（画布 60%） | 环最外沿到最外沿 |
| 外环线宽 | 62px（≈外径的 10%） | 细一点会软，粗一点会闷 |
| 外环颜色 | 左上 `#2ED3E8`（青）→ 右下 `#5B7CFA`（蓝）对角渐变 | 不是径向、不是水平 |
| 缺口 | 正上方 12 点，跨度 28°，**平口** | 平口，绝不能是圆头 |
| 内环直径 | 750px（画布 73%），线宽 11px | 淡紫蓝 `#7896FF`，不透明度 38% |
| 中心点直径 | 106px（画布 10.4%） | 白 → 青渐变 |
| 刻度 | **无** | 已确认删除 |
| 安全边距 | 四周留 12% | 不贴边 |

---

## 二、通用英文提示词（Nano Banana / DALL·E / GPT-image / Flux）

> Flat vector app icon, 1024x1024, square canvas with a rounded-square background tile. Background: vertical gradient from deep navy-blue #171E30 at the top to near-black #090C14 at the bottom, corner radius about 22.5 percent of the canvas. Centered in the tile: a single thick circular ring, its outer diameter exactly 60 percent of the canvas width, stroke weight about one tenth of that diameter. The ring is open at the 12 o'clock position with a clean 28 degree gap, and both cut ends are FLAT, not rounded. The ring is filled with a diagonal gradient from bright teal-cyan #2ED3E8 at the upper-left to cold azure blue #5B7CFA at the lower-right. Concentric with it, a very thin inner hairline circle at 73 percent of the canvas width, 1 percent stroke, color pale periwinkle #7896FF at 38 percent opacity, suggesting the thickness of a lens. At the exact center, one small solid circle, diameter about 10 percent of the canvas, filled with a subtle gradient from white to pale cyan. Nothing else: no tick marks, no scale, no numbers, no text, no letters, no emblem, no border. Strictly flat 2D vector, hard clean edges, uniform geometry, precise concentric alignment. No glow, no blur, no drop shadow, no bevel, no 3D, no glass reflection, no noise, no texture, no gradient mesh.

**Negative prompt（一起填进去）**

> text, letters, numbers, watermark, signature, tick marks, dial scale, clock hands, arrow, glow, bloom, neon, drop shadow, bevel, emboss, 3D render, glossy plastic, glass reflection, specular highlight, noise, grain, texture, gradient mesh, vignette, mockup, device frame, hand, background scenery, person, eye, eyeball, iris photo

---

## 三、Midjourney 版（更吃风格词，几何会略差，出图后需要对位）

> flat vector app icon, deep navy to near-black rounded square tile, one bold circular ring centered, ~60 percent of canvas, ring open with a clean flat-ended gap at twelve o'clock, diagonal gradient from bright teal-cyan to azure blue on the ring, one hairline concentric circle inside suggesting lens thickness, one small pale cyan dot at the exact center, minimal, geometric, Swiss precision, technical drawing clarity, strictly two dimensional, hard edges, no text, no ornaments --ar 1:1 --style raw --q 2 --no text, ticks, glow, shadow, 3d, gradient mesh, texture

出图后如果环不是正圆、缺口位置偏了，把图发我，我按规格重画几何。

---

## 四、中文提示词（即梦 / 通义万相 / 文心一格 / 可灵）

> 扁平矢量应用图标，1024×1024 正方形，圆角方形底板，圆角约为边长的 22.5%。底板是垂直渐变，从顶部的深靛蓝 #171E30 过渡到底部的近黑 #090C14。画面正中一个粗圆环，外径占画布宽度的 60%，线宽约为外径的十分之一。圆环在正上方 12 点位置开口，缺口跨度 28 度，两个断口是**平口**，不是圆头。圆环本身是斜向渐变，左上为亮青绿 #2ED3E8，右下为冷天蓝 #5B7CFA。环内再套一个极细的同心圆，直径占画布 73%，线宽很细，颜色淡紫蓝 #7896FF、不透明度 38%，用来暗示镜片的厚度。正中心一个实心小圆点，直径约占画布 10%，填充从白色到淡青色的渐变。除此之外什么都没有：没有刻度、没有表盘数字、没有文字、没有字母、没有边框。严格二维扁平，边缘干净，几何精确，同心对齐。不要发光、不要模糊、不要投影、不要立体、不要玻璃反光、不要噪点、不要纹理。

**反向词（一起填）**

> 文字、字母、数字、水印、刻度、表盘、指针、箭头、发光、霓虹、投影、浮雕、立体、塑料质感、玻璃反光、高光、噪点、纹理、网格渐变、暗角、样机、设备外框、手、眼睛、眼球

---

## 五、如果想让它「更好看一点」而不是「更准」，加这几句

按顺序试，一次只加一句，否则分不清是哪句起了作用：

1. `the ring has a slight luminous quality, as if lit from within, but completely flat`（要光感但不要发光）
2. `the gradient follows the circumference of the ring, not a straight diagonal`（环的渐变沿圆周走，更像有厚度的镜片）
3. `the inner hairline circle is offset by one pixel from true concentricity`（极轻微的偏心，让画面不死板）
4. `slightly desaturated, like printed ink rather than a screen render`（降饱和，去掉屏幕感）

---

## 六、常见失败与修法

| 现象 | 原因 | 修法 |
|---|---|---|
| 环变成了齿轮 / 有刻度 | 模型把「ring」联想到表盘 | 负向词里加 `dial, gauge, scale, gear, cog` |
| 缺口两端口变圆 | 模型默认圆头笔画 | 加 `butt caps, square cut, flat ends, machined cut` |
| 背景出现光晕 | 模型自动加「图标阴影」 | 加 `no ambient occlusion, no inner shadow, no lighting` |
| 环不圆 / 偏心 | 几何能力不足 | 换 Flux 或直接让代码画 |
| 出现玻璃反光 | 「lens」触发了玻璃联想 | 删掉 `lens`，改说 `thin concentric hairline circle` |
| 整体变成 3D 图标 | 训练集里 app icon 多是拟物 | 强压 `strictly flat 2d, vector only, no rendering` |

---

## 七、拿到图之后

把 PNG 发我，我做三件事：

1. **对位校正**：量出环的实际外径、环宽、缺口角度，按规格表格重新生成几何，保证七档缩放不变形
2. **七档 ICO**：16 / 24 / 32 / 48 / 64 / 128 / 256 分别出图，小尺寸自动减细节（24 以下闭合环、48 以下删内环），手写 ICO 容器避免重采样发虚
3. **替换**：`tokenwatch.ico`、`static/favicon.svg`、`TokenWatchLauncher.spec` 三处一起换，重打包验证
