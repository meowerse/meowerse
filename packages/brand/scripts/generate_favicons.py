#!/usr/bin/env python3
"""Generate optimized multi-format favicon and icon assets from catuser.png."""

import os
import sys
from PIL import Image

def generate_icons(src_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    src = Image.open(src_path).convert("RGBA")
    
    # 1. Standard transparent favicons (LANCZOS antialiasing)
    # 32x32 WebP (lossless, ultra-small, modern browser tabs)
    im32 = src.resize((32, 32), Image.Resampling.LANCZOS)
    im32.save(os.path.join(out_dir, "favicon.webp"), format="WEBP", lossless=True, quality=100)
    im32.save(os.path.join(out_dir, "favicon.png"), format="PNG", optimize=True)
    im32.save(os.path.join(out_dir, "favicon-32x32.png"), format="PNG", optimize=True)
    
    # 16x16 PNG & WebP
    im16 = src.resize((16, 16), Image.Resampling.LANCZOS)
    im16.save(os.path.join(out_dir, "favicon-16x16.png"), format="PNG", optimize=True)
    im16.save(os.path.join(out_dir, "favicon-16x16.webp"), format="WEBP", lossless=True, quality=100)
    
    # 48x48 PNG & WebP
    im48 = src.resize((48, 48), Image.Resampling.LANCZOS)
    im48.save(os.path.join(out_dir, "favicon-48x48.png"), format="PNG", optimize=True)
    im48.save(os.path.join(out_dir, "favicon-48x48.webp"), format="WEBP", lossless=True, quality=100)
    
    # Multi-resolution ICO (16, 32, 48)
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_imgs = [src.resize(s, Image.Resampling.LANCZOS) for s in ico_sizes]
    ico_imgs[0].save(
        os.path.join(out_dir, "favicon.ico"),
        format="ICO",
        sizes=ico_sizes,
        append_images=ico_imgs[1:]
    )
    
    # 2. Plated App Icons (iOS apple-touch-icon, Android / PWA manifests)
    # Background surface: #0d0d0d
    SURFACE_COLOR = (13, 13, 13, 255)
    
    def make_plate(size, inner_pct):
        inner_size = round(size * inner_pct)
        resized_mark = src.resize((inner_size, inner_size), Image.Resampling.LANCZOS)
        plate = Image.new("RGBA", (size, size), SURFACE_COLOR)
        offset = ((size - inner_size) // 2, (size - inner_size) // 2)
        plate.alpha_composite(resized_mark, dest=offset)
        return plate
    
    # Apple Touch Icon (180x180, 76% scale)
    apple_plate = make_plate(180, 0.76)
    apple_plate.save(os.path.join(out_dir, "apple-touch-icon.png"), format="PNG", optimize=True)
    apple_plate.save(os.path.join(out_dir, "apple-touch-icon.webp"), format="WEBP", lossless=True)
    
    # PWA 192x192
    pwa192 = make_plate(192, 0.76)
    pwa192.save(os.path.join(out_dir, "icon-192.png"), format="PNG", optimize=True)
    pwa192.save(os.path.join(out_dir, "icon-192.webp"), format="WEBP", lossless=True)
    
    # PWA 512x512
    pwa512 = make_plate(512, 0.76)
    pwa512.save(os.path.join(out_dir, "icon-512.png"), format="PNG", optimize=True)
    pwa512.save(os.path.join(out_dir, "icon-512.webp"), format="WEBP", lossless=True)
    
    # Maskable 512x512 (60% scale inside safe zone)
    maskable512 = make_plate(512, 0.60)
    maskable512.save(os.path.join(out_dir, "icon-maskable-512.png"), format="PNG", optimize=True)
    maskable512.save(os.path.join(out_dir, "icon-maskable-512.webp"), format="WEBP", lossless=True)
    
    print(f"Generated all raster icons into {out_dir}")

if __name__ == "__main__":
    src = sys.argv[1] if len(sys.argv) > 1 else "/home/alxnko/Projects/code/meow/catuser.png"
    out = sys.argv[2] if len(sys.argv) > 2 else "/home/alxnko/Projects/code/meow/meowerse/packages/brand/icons"
    generate_icons(src, out)
