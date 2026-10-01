#!/usr/bin/env python3
import os
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DIR = os.path.join(ROOT, 'site')

def create_svg():
    svg_content = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none">
  <defs>
    <linearGradient id="badge-bg" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#141418"/>
      <stop offset="100%" stop-color="#060608"/>
    </linearGradient>
    <linearGradient id="link-grad" x1="154" y1="358" x2="358" y2="154" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.20"/>
    </linearGradient>
  </defs>

  <!-- High-def squircle container with subtle rim -->
  <rect width="512" height="512" rx="112" fill="url(#badge-bg)"/>
  <rect x="2" y="2" width="508" height="508" rx="110" fill="none" stroke="#ffffff" stroke-width="4" stroke-opacity="0.12"/>

  <!-- Connecting cache line -->
  <line x1="154" y1="358" x2="358" y2="154" stroke="url(#link-grad)" stroke-width="26" stroke-linecap="round"/>

  <!-- Node 2 halo ring -->
  <circle cx="256" cy="256" r="68" fill="none" stroke="#ffffff" stroke-width="6" stroke-opacity="0.32"/>

  <!-- Node 1 (Input prompt: 100% white) -->
  <circle cx="154" cy="358" r="50" fill="#ffffff"/>

  <!-- Node 2 (Knowledge core: 88% white) -->
  <circle cx="256" cy="256" r="50" fill="#ffffff" fill-opacity="0.88"/>

  <!-- Node 3 (Distilled note: 65% white) -->
  <circle cx="358" cy="154" r="50" fill="#ffffff" fill-opacity="0.65"/>
</svg>
'''
    with open(os.path.join(SITE_DIR, 'favicon.svg'), 'w', encoding='utf-8') as f:
        f.write(svg_content.strip() + '\n')
    print('Generated site/favicon.svg')

def create_icon_image(size):
    scale = 4
    s = size * scale
    img = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    rx = int(s * 0.22)

    # Subtle dark background gradient
    for y in range(s):
        t = y / float(s)
        r = int(20 * (1 - t) + 6 * t)
        g = int(20 * (1 - t) + 6 * t)
        b = int(24 * (1 - t) + 8 * t)
        draw.line([(0, y), (s, y)], fill=(r, g, b, 255))

    mask = Image.new('L', (s, s), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, s, s], radius=rx, fill=255)

    badge = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    badge.paste(img, (0, 0), mask)
    draw = ImageDraw.Draw(badge)

    # Outer border rim
    border_w = max(1, int(1.5 * scale))
    draw.rounded_rectangle(
        [scale, scale, s - scale, s - scale],
        radius=rx,
        outline=(255, 255, 255, 32),
        width=border_w
    )

    cx, cy = s / 2.0, s / 2.0
    offset = s * 0.20
    p1 = (cx - offset, cy + offset)
    p2 = (cx, cy)
    p3 = (cx + offset, cy - offset)

    # Connecting link line
    link_w = max(2, int(s * 0.052))
    draw.line([p1, p3], fill=(255, 255, 255, 70), width=link_w)

    r_node = s * 0.098

    # Node 2 accent ring
    ring_r = s * 0.133
    ring_w = max(1, int(s * 0.014))
    draw.ellipse(
        [p2[0] - ring_r, p2[1] - ring_r, p2[0] + ring_r, p2[1] + ring_r],
        outline=(255, 255, 255, 85),
        width=ring_w
    )

    # 3 nodes
    draw.ellipse([p1[0] - r_node, p1[1] - r_node, p1[0] + r_node, p1[1] + r_node], fill=(255, 255, 255, 255))
    draw.ellipse([p2[0] - r_node, p2[1] - r_node, p2[0] + r_node, p2[1] + r_node], fill=(255, 255, 255, 225))
    draw.ellipse([p3[0] - r_node, p3[1] - r_node, p3[0] + r_node, p3[1] + r_node], fill=(255, 255, 255, 165))

    return badge.resize((size, size), Image.Resampling.LANCZOS)

def create_all_icons():
    sizes = {
        'favicon-16x16.png': 16,
        'favicon-32x32.png': 32,
        'favicon-48x48.png': 48,
        'apple-touch-icon.png': 180,
        'icon-192.png': 192,
        'icon-512.png': 512,
    }

    images = {}
    for filename, sz in sizes.items():
        img = create_icon_image(sz)
        images[sz] = img
        out_path = os.path.join(SITE_DIR, filename)
        img.save(out_path, 'PNG')
        print(f'Generated site/{filename} ({sz}x{sz})')

    # Also generate multi-resolution favicon.ico
    ico_path = os.path.join(SITE_DIR, 'favicon.ico')
    images[32].save(
        ico_path,
        format='ICO',
        sizes=[(16, 16), (32, 32), (48, 48)],
        append_images=[images[16], images[48]]
    )
    print('Generated site/favicon.ico')

def create_manifest():
    manifest_content = '''{
  "name": "thinker",
  "short_name": "thinker",
  "description": "A knowledge cache for your coding agents.",
  "icons": [
    {
      "src": "/favicon-32x32.png",
      "sizes": "32x32",
      "type": "image/png"
    },
    {
      "src": "/icon-192.png",
      "sizes": "192x192",
      "type": "image/png"
    },
    {
      "src": "/icon-512.png",
      "sizes": "512x512",
      "type": "image/png"
    },
    {
      "src": "/apple-touch-icon.png",
      "sizes": "180x180",
      "type": "image/png"
    }
  ],
  "theme_color": "#09090b",
  "background_color": "#ffffff",
  "display": "standalone"
}
'''
    with open(os.path.join(SITE_DIR, 'site.webmanifest'), 'w', encoding='utf-8') as f:
        f.write(manifest_content.strip() + '\n')
    print('Generated site/site.webmanifest')

def create_og_image():
    W, H = 1200, 630
    og = Image.new('RGBA', (W, H), (9, 9, 11, 255))
    draw = ImageDraw.Draw(og)

    # Subtle radial gradient spotlight in the center
    cx, cy = W // 2, 240
    max_r = 500
    for r in range(max_r, 0, -4):
        t = 1.0 - (r / float(max_r))
        # subtle glow
        alpha = int(22 * (t ** 1.8))
        draw.ellipse([cx - r, cy - int(r * 0.7), cx + r, cy + int(r * 0.7)], fill=(25, 27, 34, alpha))

    # Outer border on card
    draw.rectangle([0, 0, W - 1, H - 1], outline=(255, 255, 255, 20), width=1)

    # Paste high-def icon (140x140) with drop shadow
    icon_sz = 140
    icon_img = create_icon_image(icon_sz)
    icon_x = (W - icon_sz) // 2
    icon_y = 110

    # Icon drop shadow
    shadow_img = Image.new('RGBA', (icon_sz + 40, icon_sz + 40), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow_img)
    sdraw.rounded_rectangle([15, 20, icon_sz + 25, icon_sz + 30], radius=int(icon_sz * 0.22), fill=(0, 0, 0, 140))
    shadow_blur = shadow_img.filter(ImageFilter.GaussianBlur(14))
    og.paste(shadow_blur, (icon_x - 20, icon_y - 10), shadow_blur)

    og.paste(icon_img, (icon_x, icon_y), icon_img)

    # Fonts
    font_bold = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 64, index=1)
    font_sub = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 28, index=0)
    font_pill = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 17, index=1)
    font_foot = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 18, index=0)

    # Title "thinker"
    title = "thinker"
    t_bbox = draw.textbbox((0, 0), title, font=font_bold)
    tw = t_bbox[2] - t_bbox[0]
    draw.text(((W - tw) // 2, 280), title, font=font_bold, fill=(255, 255, 255, 255))

    # Subtitle
    subtitle = "A knowledge cache for your coding agents"
    s_bbox = draw.textbbox((0, 0), subtitle, font=font_sub)
    sw = s_bbox[2] - s_bbox[0]
    draw.text(((W - sw) // 2, 365), subtitle, font=font_sub, fill=(161, 161, 170, 255))

    # Pill tags
    pills = [
        "41% less exploration",
        "Dependency-keyed invalidation",
        "Multi-agent learning loop"
    ]
    pill_h = 36
    pill_padding = 18
    pill_gap = 14

    pill_widths = []
    for p in pills:
        bbox = draw.textbbox((0, 0), p, font=font_pill)
        pill_widths.append(bbox[2] - bbox[0] + pill_padding * 2)

    total_pills_w = sum(pill_widths) + pill_gap * (len(pills) - 1)
    start_x = (W - total_pills_w) // 2
    cur_x = start_x
    pill_y = 435

    for i, p in enumerate(pills):
        pw = pill_widths[i]
        # Draw pill container
        draw.rounded_rectangle(
            [cur_x, pill_y, cur_x + pw, pill_y + pill_h],
            radius=pill_h // 2,
            fill=(24, 24, 28, 220),
            outline=(255, 255, 255, 26),
            width=1
        )
        p_bbox = draw.textbbox((0, 0), p, font=font_pill)
        ptw = p_bbox[2] - p_bbox[0]
        pth = p_bbox[3] - p_bbox[1]
        text_x = cur_x + (pw - ptw) // 2
        text_y = pill_y + (pill_h - pth) // 2 - 2
        draw.text((text_x, text_y), p, font=font_pill, fill=(212, 212, 216, 255))
        cur_x += pw + pill_gap

    # Footer domain
    footer_text = "zerotime.dev"
    f_bbox = draw.textbbox((0, 0), footer_text, font=font_foot)
    fw = f_bbox[2] - f_bbox[0]
    draw.text(((W - fw) // 2, 545), footer_text, font=font_foot, fill=(113, 113, 122, 255))

    og_path = os.path.join(SITE_DIR, 'og-image.png')
    og.save(og_path, 'PNG')
    print('Generated site/og-image.png (1200x630)')

if __name__ == '__main__':
    create_svg()
    create_all_icons()
    create_manifest()
    create_og_image()
