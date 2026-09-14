# -*- coding: utf-8 -*-
"""生成 TokenWatch 多尺寸 ICO 图标（方向 B：Token 硬币 + 环形进度）"""
from PIL import Image, ImageDraw, ImageFont
import math

SIZES = [16, 32, 48, 256]
OUT_ICO = "tokenwatch.ico"
OUT_PNG = "tokenwatch_icon_preview.png"

# 配色：深蓝-青渐变，避免 AI 烂大街紫
C_RING_DARK = (37, 99, 235)   # #2563EB
C_RING_LIGHT = (6, 182, 212)  # #06B6D4
C_DISC_DARK = (15, 23, 42)    # #0F172A
C_DISC_LIGHT = (30, 41, 59)   # #1E293B
C_HIGHLIGHT = (255, 255, 255)
C_ACCENT = (125, 211, 252)    # #7DD3FC


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def linear_gradient(size, c1, c2, angle=45):
    """生成线性渐变底层"""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    rad = math.radians(angle)
    dx, dy = math.cos(rad), math.sin(rad)
    for y in range(size):
        for x in range(size):
            # 把坐标投影到渐变轴
            t = ((x - size / 2) * dx + (y - size / 2) * dy) / (size / 2)
            t = (t + 1) / 2
            t = max(0, min(1, t))
            img.putpixel((x, y), lerp(c1, c2, t) + (255,))
    return img


def draw_ring_layer(draw, cx, cy, r_outer, r_inner, start, end, color, width=1):
    """画一段圆环（用于进度环）"""
    # 用粗圆弧近似：画扇形然后减去内圆
    # 在 256 画布上直接用 polygon 会锯齿，改用 draw.arc + 线宽
    draw.arc(
        [cx - r_outer, cy - r_outer, cx + r_outer, cy + r_outer],
        start=start, end=end, fill=color, width=width
    )


def make_icon(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    cx, cy = size / 2, size / 2

    # 尺寸比例
    pad = size * 0.06
    r_out = (size / 2) - pad
    r_ring = r_out * 0.82          # 进度环半径
    r_disc = r_out * 0.74          # 内圆盘半径
    r_dot = r_out * 0.14           # 中心点

    # 1) 深色外圈底色（硬币边缘）
    draw.ellipse([pad, pad, size - pad, size - pad], fill=C_DISC_DARK)

    # 2) 内圆盘渐变（模拟金属/玻璃光泽）
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ddisc = ImageDraw.Draw(disc)
    ddisc.ellipse(
        [cx - r_disc, cy - r_disc, cx + r_disc, cy + r_disc],
        fill=C_DISC_LIGHT
    )
    # 在上半部分叠加柔和高光
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dglow = ImageDraw.Draw(glow)
    for i in range(int(r_disc * 0.6), 0, -1):
        alpha = int(25 * (i / (r_disc * 0.6)))
        dglow.ellipse([cx - i, cy - r_disc + i * 0.35, cx + i, cy + r_disc - i * 0.35],
                        fill=(255, 255, 255, alpha))
    disc = Image.alpha_composite(disc, glow)
    img = Image.alpha_composite(img, disc)

    # 3) 进度环（从 -90° 开始，约 75% 进度）
    draw = ImageDraw.Draw(img)
    ring_width = max(2, int(size * 0.045))
    # 背景轨道
    draw.arc(
        [cx - r_ring, cy - r_ring, cx + r_ring, cy + r_ring],
        start=0, end=360,
        fill=(255, 255, 255, 22), width=ring_width
    )
    # 渐变进度：手动分段插值，从 -90 到 +160（约 250°）
    segments = max(8, size // 3)
    sweep = 250
    for i in range(segments):
        t0 = i / segments
        t1 = (i + 1) / segments
        c = lerp(C_RING_DARK, C_RING_LIGHT, t0)
        a0 = -90 + t0 * sweep
        a1 = -90 + t1 * sweep
        draw.arc(
            [cx - r_ring, cy - r_ring, cx + r_ring, cy + r_ring],
            start=a0, end=a1, fill=c, width=ring_width
        )

    # 4) 中心「T」字 / Token 标记
    draw.ellipse([cx - r_dot, cy - r_dot, cx + r_dot, cy + r_dot], fill=C_HIGHLIGHT)
    # 在中心点画一个小圆孔（Token 硬币的孔）
    hole_r = r_dot * 0.35
    draw.ellipse([cx - hole_r, cy - hole_r, cx + hole_r, cy + hole_r], fill=C_DISC_DARK)

    # 5) 硬币边缘高光（顶部 1px 细线）
    if size >= 32:
        hi_r = r_out * 0.92
        draw.arc(
            [cx - hi_r, cy - hi_r, cx + hi_r, cy + hi_r],
            start=200, end=340, fill=(255, 255, 255, 55), width=max(1, size // 64)
        )

    # 6) 对于大图标，底部加 subtle 投影不需要（透明背景由 Windows 处理）
    return img


def main():
    frames = []
    for s in SIZES:
        frames.append(make_icon(s))
    # 保存 ICO
    frames[0].save(OUT_ICO, format="ICO", sizes=[(f.width, f.height) for f in frames])
    # 保存一张 256 预览图
    frames[-1].save(OUT_PNG)
    print(f"已生成 {OUT_ICO}：sizes={[(f.width, f.height) for f in frames]}")


if __name__ == "__main__":
    main()
