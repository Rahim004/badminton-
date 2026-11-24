"""Рендер PNG-иконок из tools/icon.svg (headless Chrome через Playwright).
  python3 tools/render-icons.py
Выход: icons/*.png и android/app/src/main/res/mipmap-*"""
import os, sys, base64
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
svg = open(os.path.join(ROOT, 'tools', 'icon.svg'), encoding='utf-8').read()

def page_html(size, rounded=0, scale=1.0, transparent=False):
    # scale<1 — рисунок (ракетка+волан) уменьшается к центру, фон остаётся на весь квадрат
    # (maskable-иконка и adaptive-foreground требуют запаса по краям).
    import re
    s = svg
    if transparent:  # только ракетка и волан, без фона и полос
        s = re.sub(r'<rect width="512" height="512" fill="url\(#bg\)"/>', '', s)
        s = re.sub(r'<!-- скоростные полосы.*?</g>', '', s, flags=re.S)
    s = s.replace('<g id="art">', f'<g id="art" transform="translate(256 256) scale({scale}) translate(-256 -256)">')
    s = s.replace('width="512" height="512">', 'width="100%" height="100%">', 1)
    inner = f'<div style="width:{size}px;height:{size}px;overflow:hidden;border-radius:{rounded}px">{s}</div>'
    return f'<!doctype html><body style="margin:0;background:transparent">{inner}</body>'

JOBS = [
    ('icons/icon-192.png', 192, 192 * 0.2, 1.0, False),
    ('icons/icon-512.png', 512, 512 * 0.2, 1.0, False),
    ('icons/icon-maskable-512.png', 512, 0, 0.9, False),   # полный фон, содержимое в безопасной зоне
    ('icons/apple-touch-icon.png', 180, 0, 0.94, False),    # iOS сам скругляет
    ('desktop/build/icon.png', 512, 0, 1.0, False),                 # Electron (скруглит система)
    ('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png', 432, 0, 0.8, True),
]
for dpi, px in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    JOBS.append((f'android/app/src/main/res/mipmap-{dpi}/ic_launcher.png', px, px * 0.22, 1.0, False))

with sync_playwright() as p:
    b = p.chromium.launch()
    for path, size, rounded, scale, transparent in JOBS:
        out = os.path.join(ROOT, path)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        pg = b.new_page(viewport={'width': size, 'height': size})
        pg.set_content(page_html(size, rounded, scale, transparent))
        pg.screenshot(path=out, omit_background=True, clip={'x': 0, 'y': 0, 'width': size, 'height': size})
        pg.close()
        print('ok', path)
    b.close()
