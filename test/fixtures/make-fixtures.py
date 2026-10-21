# -*- coding: utf-8 -*-
"""Regenerate the committed animation fixtures.

The generated binaries are committed so `npm test` needs nothing but Node. This
script exists so a contributor can see exactly what each fixture contains and
rebuild it; run it with any Python 3 that has Pillow:

    python test/fixtures/make-fixtures.py

Every fixture is deterministic: same inputs, same bytes.
"""
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))

INK = (18, 18, 24)
MARK = (90, 200, 255)
BAR = (255, 120, 60)


def marker_frame(size, index, count, *, opaque=True):
    """One frame: a dot sweeping left to right, plus a bar encoding the index.

    The bar makes a decoded frame identifiable by pixel inspection, which is how
    the tests prove that returned frames are real, distinct frames and not the
    same picture repeated.
    """
    width, height = size
    background = INK if opaque else (0, 0, 0, 0)
    mode = "RGB" if opaque else "RGBA"
    if not opaque:
        background = (0, 0, 0, 0)
    image = Image.new(mode, size, background)
    draw = ImageDraw.Draw(image)

    span = width - 40 - 16
    x = 16 + (span * index // max(1, count - 1))
    draw.ellipse([x, height // 3, x + 40, height // 3 + 40], fill=MARK)

    bar_right = 10 + (width - 30) * (index + 1) // count
    draw.rectangle([10, height - 30, bar_right, height - 12], fill=BAR)
    return image


def write_gif(path, frames, *, duration, loop=0, transparency=None):
    kwargs = {}
    if transparency is not None:
        kwargs["transparency"] = transparency
    frames[0].save(
        path,
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=loop,
        optimize=False,
        **kwargs,
    )
    print(f"{os.path.basename(path):22s} {os.path.getsize(path):8d} B")


def force_zero_delays(path):
    """Rewrite every graphic-control extension's delay field to 0, in place.

    A GIF delay is a 16-bit little-endian centisecond count at a fixed offset
    inside the `21 F9 04` block. Setting it to zero is what produces the
    "instantaneous" timing that real-world GIFs are full of, and that a naive
    decoder turns into a zero-duration animation.
    """
    with open(path, "rb") as handle:
        data = bytearray(handle.read())

    patched = 0
    offset = 13
    if data[10] & 0x80:
        offset += 3 * (1 << ((data[10] & 0x07) + 1))
    while offset < len(data) - 1:
        marker = data[offset]
        if marker == 0x21 and data[offset + 1] == 0xF9:
            data[offset + 4] = 0
            data[offset + 5] = 0
            patched += 1
            offset += 8
        elif marker == 0x21:
            offset = _skip_sub_blocks(data, offset + 2)
        elif marker == 0x2C:
            offset = _skip_image_block(data, offset)
        else:
            break

    with open(path, "wb") as handle:
        handle.write(data)
    return patched


def _skip_sub_blocks(data, offset):
    cursor = offset
    while cursor < len(data):
        size = data[cursor]
        if size == 0:
            return cursor + 1
        cursor += size + 1
    return cursor


def _skip_image_block(data, offset):
    packed = data[offset + 9]
    cursor = offset + 10
    if packed & 0x80:
        cursor += 3 * (1 << ((packed & 0x07) + 1))
    cursor += 1  # LZW minimum code size
    return _skip_sub_blocks(data, cursor)


def main():
    # 1. The reference animation: 8 frames, even 80 ms timing, loops forever.
    frames = [marker_frame((240, 160), i, 8) for i in range(8)]
    write_gif(os.path.join(HERE, "moving-8f.gif"), frames, duration=80)

    # 2. Same picture, uneven timing: sampling by time must differ from sampling
    #    by index here, which is what the sampling tests rely on.
    frames = [marker_frame((160, 120), i, 4) for i in range(4)]
    frames[0].save(
        os.path.join(HERE, "uneven-delays.gif"),
        save_all=True,
        append_images=frames[1:],
        duration=[500, 50, 50, 400],
        loop=0,
        optimize=False,
    )
    print(f"{'uneven-delays.gif':22s} {os.path.getsize(os.path.join(HERE, 'uneven-delays.gif')):8d} B")

    # 3. A transparent background, so the flatten path has something to flatten.
    frames = [marker_frame((200, 120), i, 6, opaque=False) for i in range(6)]
    write_gif(os.path.join(HERE, "transparent.gif"), frames, duration=100, transparency=0)

    # 4. Big enough that sampling has to skip frames and frame count is non-trivial.
    frames = [marker_frame((600, 400), i, 60) for i in range(60)]
    write_gif(os.path.join(HERE, "big-60f.gif"), frames, duration=40)

    # 4b. A zero declared delay on every frame. Real GIFs do this, and taking it
    #     literally gives a zero-duration animation on which every sampling target
    #     clamps to frame 0. Pillow rewrites a requested 0 as 100, so the delay
    #     fields are patched in the encoded bytes instead — the fixture has to
    #     contain what a real 0-delay GIF contains.
    frames = [marker_frame((160, 120), i, 6) for i in range(6)]
    zero_delay = os.path.join(HERE, "zero-delay.gif")
    write_gif(zero_delay, frames, duration=10)
    patched = force_zero_delays(zero_delay)
    print(f"{'  -> zeroed delays':22s} {patched} graphic-control extensions patched")

    # 5. A GIF that is not animated: read_animation must say so, not silently
    #    return one frame as if it were the whole story.
    still = marker_frame((120, 90), 0, 1)
    still.save(os.path.join(HERE, "still.gif"))
    print(f"{'still.gif':22s} {os.path.getsize(os.path.join(HERE, 'still.gif')):8d} B")

    # 6. A static PNG: the wrong tool entirely.
    still.save(os.path.join(HERE, "still.png"))
    print(f"{'still.png':22s} {os.path.getsize(os.path.join(HERE, 'still.png')):8d} B")

    # 7. APNG — an animation the host image library cannot decode. Its presence in
    #    the fixture set is the point: without an explicit check it would be read
    #    as a still PNG and lose every frame after the first.
    frames = [marker_frame((200, 120), i, 6) for i in range(6)]
    frames[0].save(
        os.path.join(HERE, "anim.apng.png"),
        save_all=True,
        append_images=frames[1:],
        duration=100,
        loop=0,
    )
    print(f"{'anim.apng.png':22s} {os.path.getsize(os.path.join(HERE, 'anim.apng.png')):8d} B")

    # 8. Animated WebP: the second format this plugin supports.
    frames = [marker_frame((240, 160), i, 8) for i in range(8)]
    frames[0].save(
        os.path.join(HERE, "moving.webp"),
        save_all=True,
        append_images=frames[1:],
        duration=80,
        loop=0,
    )
    print(f"{'moving.webp':22s} {os.path.getsize(os.path.join(HERE, 'moving.webp')):8d} B")

    # 9. Not an image at all.
    with open(os.path.join(HERE, "not-an-image.txt"), "w", encoding="utf-8", newline="\n") as handle:
        handle.write("This is text, not an animation.\n")


if __name__ == "__main__":
    main()
