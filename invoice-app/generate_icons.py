#!/usr/bin/env python3
"""Generate PWA icons for Summa app."""

import os

from PIL import Image, ImageDraw, ImageFont

# Icon sizes needed for PWA
SIZES = [72, 96, 128, 144, 152, 192, 384, 512]
MASKABLE_SIZES = [192, 512]

# Colors matching the app theme
GRADIENT_START = (59, 130, 246)  # #3b82f6
GRADIENT_END = (139, 92, 246)  # #8b5cf6

OUTPUT_DIR = "static/icons"


def create_gradient(size: int) -> Image.Image:
    """Create a diagonal gradient background."""
    img = Image.new("RGB", (size, size))
    for y in range(size):
        for x in range(size):
            # Diagonal gradient
            ratio = (x + y) / (2 * size)
            r = int(GRADIENT_START[0] + (GRADIENT_END[0] - GRADIENT_START[0]) * ratio)
            g = int(GRADIENT_START[1] + (GRADIENT_END[1] - GRADIENT_START[1]) * ratio)
            b = int(GRADIENT_START[2] + (GRADIENT_END[2] - GRADIENT_START[2]) * ratio)
            img.putpixel((x, y), (r, g, b))
    return img


def add_rounded_corners(img: Image.Image, radius: int) -> Image.Image:
    """Add rounded corners to an image."""
    mask = Image.new("L", img.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([(0, 0), img.size], radius=radius, fill=255)

    result = Image.new("RGBA", img.size, (0, 0, 0, 0))
    result.paste(img, mask=mask)
    return result


def draw_sigma_polygon(draw: ImageDraw.ImageDraw, size: int, maskable: bool) -> None:
    """Draw a Sigma symbol as a polygon when no font is available."""
    # Scale factor based on icon size
    scale = size / 100.0
    # Smaller for maskable icons (safe zone)
    if maskable:
        scale *= 0.65
        offset = size * 0.175
    else:
        scale *= 0.55
        offset = size * 0.225

    # Sigma shape points (designed for 100x100, scaled)
    points = [
        (70, 20),  # Top right
        (30, 20),  # Top left
        (50, 50),  # Middle point
        (30, 80),  # Bottom left
        (70, 80),  # Bottom right
        (70, 72),  # Bottom right inner
        (42, 72),  # Bottom left inner
        (58, 50),  # Middle inner
        (42, 28),  # Top left inner
        (70, 28),  # Top right inner
    ]

    # Scale and offset points
    scaled_points = [(x * scale + offset, y * scale + offset) for x, y in points]
    draw.polygon(scaled_points, fill="white")


def create_icon(size: int, maskable: bool = False) -> Image.Image:
    """Create an icon of the specified size."""
    img = create_gradient(size)
    draw = ImageDraw.Draw(img)

    # Calculate font size (roughly 60% of icon size for regular, 40% for maskable)
    font_size = int(size * (0.4 if maskable else 0.6))

    # Try to use a good font, fall back to drawing manually
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont | None = None
    font_paths = [
        # Fedora/RHEL
        "/usr/share/fonts/liberation-serif-fonts/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/liberation-sans-fonts/LiberationSans-Bold.ttf",
        "/usr/share/fonts/google-noto-vf/NotoSerif[wght].ttf",
        # Debian/Ubuntu
        "/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSerif.ttf",
        # Arch
        "/usr/share/fonts/TTF/LiberationSerif-Bold.ttf",
        "/usr/share/fonts/TTF/DejaVuSerif-Bold.ttf",
    ]

    for font_path in font_paths:
        if os.path.exists(font_path):
            try:
                font = ImageFont.truetype(font_path, font_size)
                break
            except OSError:
                continue

    # Draw the Sigma symbol
    if font is not None:
        text = "Σ"
        bbox = draw.textbbox((0, 0), text, font=font)
        text_width = bbox[2] - bbox[0]
        text_height = bbox[3] - bbox[1]
        x = (size - text_width) // 2 - bbox[0]
        y = (size - text_height) // 2 - bbox[1] - int(size * 0.02)
        draw.text((x, y), text, fill="white", font=font)
    else:
        # Fallback: Draw Sigma as polygon
        draw_sigma_polygon(draw, size, maskable)

    # Add rounded corners for regular icons (not maskable)
    if not maskable:
        radius = int(size * 0.15)  # 15% corner radius
        img = add_rounded_corners(img, radius)
    else:
        # Convert to RGBA for consistency
        img = img.convert("RGBA")

    return img


def main() -> None:
    """Generate all PWA icons."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    # Generate regular icons
    for size in SIZES:
        icon = create_icon(size, maskable=False)
        filepath = os.path.join(OUTPUT_DIR, f"icon-{size}.png")
        icon.save(filepath, "PNG")
        print(f"Created {filepath}")

    # Generate maskable icons (with safe zone padding)
    for size in MASKABLE_SIZES:
        icon = create_icon(size, maskable=True)
        filepath = os.path.join(OUTPUT_DIR, f"icon-maskable-{size}.png")
        icon.save(filepath, "PNG")
        print(f"Created {filepath}")

    # Generate Apple Touch Icon (180x180)
    apple_icon = create_icon(180, maskable=False)
    apple_path = os.path.join(OUTPUT_DIR, "apple-touch-icon.png")
    apple_icon.save(apple_path, "PNG")
    print(f"Created {apple_path}")

    print(f"\nAll icons generated in {OUTPUT_DIR}/")


if __name__ == "__main__":
    main()
