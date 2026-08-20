import zlib
import struct
import os

# Pure Python PNG Writer (creates true transparent RGBA PNGs without Pillow/PIL)
def make_rgba_png(width, height, draw_func):
    # Header
    png = bytearray(b'\x89PNG\r\n\x1a\n')
    
    # IHDR chunk
    # Width: 4 bytes, Height: 4 bytes, Bit depth: 1, Color Type: 6 (RGBA), Compression: 0, Filter: 0, Interlace: 0
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png += struct.pack('>I', 13) + b'IHDR' + ihdr_data + struct.pack('>I', zlib.crc32(b'IHDR' + ihdr_data))
    
    # Pixel data (RGBA)
    # PNG scanlines start with a filter byte (0 for None)
    img_data = bytearray()
    for y in range(height):
        img_data.append(0) # Filter type 0
        for x in range(width):
            r, g, b, a = draw_func(x, y)
            img_data.extend(struct.pack('>BBBB', r, g, b, a))
            
    idat_data = zlib.compress(img_data)
    png += struct.pack('>I', len(idat_data)) + b'IDAT' + idat_data + struct.pack('>I', zlib.crc32(b'IDAT' + idat_data))
    
    # IEND chunk
    png += struct.pack('>I', 0) + b'IEND' + struct.pack('>I', zlib.crc32(b'IEND'))
    return png

# Colors
ACTIVE_RGB = (0, 113, 227) # Apple Blue
INACTIVE_RGB = (134, 134, 139) # Apple Gray

# Draw helper functions
def draw_rect(x, y, rx, ry, rw, rh, color, thickness=2):
    # Is on the border of the rect?
    on_horiz = (ry <= y < ry + thickness) or (ry + rh - thickness <= y < ry + rh)
    on_vert = (rx <= x < rx + thickness) or (rx + rw - thickness <= x < rx + rw)
    
    is_inside_x = rx <= x < rx + rw
    is_inside_y = ry <= y < ry + rh
    
    if (on_horiz and is_inside_x) or (on_vert and is_inside_y):
        return color if len(color) == 4 else color + (255,)
    return None

def draw_filled_rect(x, y, rx, ry, rw, rh, color):
    if rx <= x < rx + rw and ry <= y < ry + rh:
        return color if len(color) == 4 else color + (255,)
    return None

def draw_circle(x, y, cx, cy, radius, color, thickness=2):
    dist_sq = (x - cx) ** 2 + (y - cy) ** 2
    r_inner = radius - thickness
    if r_inner ** 2 <= dist_sq <= (radius + 0.5) ** 2:
        return color if len(color) == 4 else color + (255,)
    return None

def draw_line(x, y, x0, y0, x1, y1, color, thickness=1.5):
    # distance from point (x,y) to line segment (x0,y0)-(x1,y1)
    # standard projection
    dx = x1 - x0
    dy = y1 - y0
    len_sq = dx*dx + dy*dy
    if len_sq == 0:
        dist_sq = (x - x0)**2 + (y - y0)**2
    else:
        t = max(0, min(1, ((x - x0)*dx + (y - y0)*dy) / len_sq))
        proj_x = x0 + t * dx
        proj_y = y0 + t * dy
        dist_sq = (x - proj_x)**2 + (y - proj_y)**2
    
    if dist_sq <= thickness**2:
        # Anti-aliasing fallback: opacity based on closeness
        opacity = int(255 * (1.0 - (dist_sq ** 0.5) / thickness))
        opacity = max(0, min(255, opacity))
        if opacity > 100:
            if len(color) == 4:
                return (color[0], color[1], color[2], int(color[3] * (opacity / 255.0)))
            return color + (opacity,)
    return None

# Icon Draw Functions
def make_overview_drawer(color):
    def draw(x, y):
        # 3x3 layout or dashboard grid
        # Outer border
        v = draw_rect(x, y, 8, 8, 32, 32, color, thickness=2.5)
        if v: return v
        # Inner dividers to make it look like a dashboard layout
        v = draw_filled_rect(x, y, 8, 20, 32, 2.5, color)
        if v: return v
        v = draw_filled_rect(x, y, 22, 20, 2.5, 20, color)
        if v: return v
        return (0, 0, 0, 0)
    return draw

def make_portfolio_drawer(color):
    def draw(x, y):
        # Briefcase or folding card list
        # Main container
        v = draw_rect(x, y, 8, 12, 32, 26, color, thickness=2.5)
        if v: return v
        # Handle of briefcase
        v = draw_rect(x, y, 18, 6, 12, 6, color, thickness=2)
        if v: return v
        # Lock / Accent in center
        v = draw_filled_rect(x, y, 22, 22, 4, 4, color)
        if v: return v
        return (0, 0, 0, 0)
    return draw

def make_analysis_drawer(color):
    def draw(x, y):
        # Sparkline or rising chart
        # Axes
        v = draw_filled_rect(x, y, 8, 36, 32, 2.5, color) # X axis
        if v: return v
        v = draw_filled_rect(x, y, 8, 8, 2.5, 30, color) # Y axis
        if v: return v
        # Sparkline points: (12, 30) -> (20, 24) -> (28, 28) -> (36, 12)
        v = draw_line(x, y, 11, 31, 19, 23, color, thickness=1.8)
        if v: return v
        v = draw_line(x, y, 19, 23, 27, 27, color, thickness=1.8)
        if v: return v
        v = draw_line(x, y, 27, 27, 36, 13, color, thickness=1.8)
        if v: return v
        # Sparkle / Stars to indicate AI
        v = draw_filled_rect(x, y, 35, 12, 3, 3, color)
        if v: return v
        return (0, 0, 0, 0)
    return draw

def make_setting_drawer(color):
    def draw(x, y):
        # Sliders or Cog
        # Sliders is easier and cleaner in 48x48
        # Track 1
        v = draw_filled_rect(x, y, 8, 14, 32, 2, (color[0], color[1], color[2], 120))
        if v: return v
        v = draw_circle(x, y, 18, 15, 5, color, thickness=2.5)
        if v: return v
        v = draw_filled_rect(x, y, 16, 13, 4, 4, color)
        if v: return v
        
        # Track 2
        v = draw_filled_rect(x, y, 8, 24, 32, 2, (color[0], color[1], color[2], 120))
        if v: return v
        v = draw_circle(x, y, 30, 25, 5, color, thickness=2.5)
        if v: return v
        v = draw_filled_rect(x, y, 28, 23, 4, 4, color)
        if v: return v

        # Track 3
        v = draw_filled_rect(x, y, 8, 34, 32, 2, (color[0], color[1], color[2], 120))
        if v: return v
        v = draw_circle(x, y, 14, 35, 5, color, thickness=2.5)
        if v: return v
        v = draw_filled_rect(x, y, 12, 33, 4, 4, color)
        if v: return v

        return (0, 0, 0, 0)
    return draw

# Write all PNGs
os.makedirs('mp/images/tabs', exist_ok=True)

icons_configs = [
    ('overview.png', make_overview_drawer(INACTIVE_RGB)),
    ('overview_active.png', make_overview_drawer(ACTIVE_RGB)),
    ('portfolio.png', make_portfolio_drawer(INACTIVE_RGB)),
    ('portfolio_active.png', make_portfolio_drawer(ACTIVE_RGB)),
    ('analysis.png', make_analysis_drawer(INACTIVE_RGB)),
    ('analysis_active.png', make_analysis_drawer(ACTIVE_RGB)),
    ('setting.png', make_setting_drawer(INACTIVE_RGB)),
    ('setting_active.png', make_setting_drawer(ACTIVE_RGB)),
]

for filename, drawer in icons_configs:
    filepath = os.path.join('mp/images/tabs', filename)
    png_bytes = make_rgba_png(48, 48, drawer)
    with open(filepath, 'wb') as f:
        f.write(png_bytes)
    print(f"Generated beautifully crafted: {filepath}")
