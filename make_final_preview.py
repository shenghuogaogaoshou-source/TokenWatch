# -*- coding: utf-8 -*-
"""生成最终交付的图标预览图：H2 眼 在多尺寸 + 浅/暗底下的表现"""
import os
from PIL import Image, ImageDraw, ImageFont

from gen_icon_drafts4 import icon_H2

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon_drafts", "FINAL_shipped.png")

SIZES = [256, 128, 64, 48, 32, 24, 16]
SS = 6  # supersample

_FONT_CACHE = {}


def font(size, bold=False):
    """加载中文字体（微软雅黑），保证中文标注不出现方框"""
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    cands = [
        r"C:\Windows\Fonts\msyhbd.ttc" if bold else r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\Deng.ttf",
    ]
    f = None
    for c in cands:
        if os.path.exists(c):
            try:
                f = ImageFont.truetype(c, size)
                break
            except Exception:
                continue
    if f is None:
        f = ImageFont.load_default()
    _FONT_CACHE[key] = f
    return f

def render(size):
    im = icon_H2(size, scale=SS)
    return im.resize((size, size), Image.LANCZOS)

def main():
    pad = 26
    label_h = 40
    # 两行：浅底 / 暗底
    rows = 2
    col_w = [max(s, 88) for s in SIZES]
    total_w = sum(col_w) + pad * (len(SIZES) + 1)
    row_h = 256 + label_h
    W = max(total_w, 800)
    H = 58 + pad + row_h * rows + pad * 2

    f_title = font(19, bold=True)
    f_band = font(14)
    f_lab = font(13)

    canvas = Image.new("RGB", (W, H), "#F5F7FA")
    d = ImageDraw.Draw(canvas)

    # 标题
    d.text((pad, 18), "TokenWatch  ·  H2「眼」图标  ·  桌面 / 任务栏最终交付",
           fill="#0F172A", font=f_title)

    y0 = 58
    for r in range(rows):
        dark = (r == 1)
        top = y0 + r * (row_h + pad)
        band = "#0B1220" if dark else "#FFFFFF"
        d.rounded_rectangle([pad, top, W - pad, top + row_h], radius=16, fill=band)
        d.text((pad + 16, top + 12),
               "暗色背景（任务栏 / 暗色主题）" if dark else "浅色背景（桌面 / 浅色主题）",
               fill="#94A3B8" if dark else "#64748B", font=f_band)
        x = pad + 16
        for s in SIZES:
            im = render(s)
            # 每个尺寸居中放在固定宽度列里
            colw = max(s, 88)
            cx = x + (colw - s) // 2
            cy = top + label_h + (256 - s) // 2
            if im.mode == "RGBA":
                canvas.paste(im, (cx, cy), im)
            else:
                canvas.paste(im, (cx, cy))
            # 尺寸标注
            txt = f"{s}px"
            tw = d.textlength(txt, font=f_lab)
            d.text((x + (colw - tw) / 2, top + label_h + 256 + 8),
                   txt, fill="#CBD5E1" if dark else "#94A3B8", font=f_lab)
            x += colw + pad

    canvas.save(OUT)
    print("saved:", OUT, canvas.size)

if __name__ == "__main__":
    main()
