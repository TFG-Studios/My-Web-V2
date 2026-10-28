#!/usr/bin/env python3
"""Slice The Textures Resource's classic UNO PC atlas into individual card PNGs.

Download the selected 2048x2048 atlas yourself from:
https://textures.spriters-resource.com/pc_computer/uno/asset/374167/
Save it as public/assets/uno-classic-sheet.png, then run:
    python tools/slice_uno_texture.py

The reference page is a game-asset archive, not a redistribution licence. This
script does not download or bundle the extracted texture sheet. Check the rights
before publishing generated crops in a public repository or deployed release.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "public" / "assets" / "uno-classic-sheet.png"
DEFAULT_OUTPUT = ROOT / "public" / "cards"

# Coordinates measured against the 1000x1000 preview of the 2048x2048 atlas.
# The sprite sheet uses 12 columns x 6 rows, with empty cells after row 5/column 3.
# Values are (column, row); output names match public/client.js cardFile().
CELL_MAP: dict[str, tuple[int, int]] = {"BACK": (0, 0), "WC": (1, 0), "W4": (6, 0)}

# Yellow faces
for n in range(1, 10):
    CELL_MAP[f"Y{n}"] = (n - 1, 1)
CELL_MAP.update({"Y0": (9, 1), "YA2": (10, 1), "YS": (11, 1), "YR": (0, 2)})
# Red faces
for n in range(1, 10):
    CELL_MAP[f"R{n}"] = (n, 2)
CELL_MAP.update({"R0": (10, 2), "RA2": (11, 2), "RS": (0, 3), "RR": (1, 3)})
# Blue faces
for n in range(1, 10):
    CELL_MAP[f"B{n}"] = (n + 1, 3)
CELL_MAP.update({"B0": (11, 3), "BA2": (0, 4), "BS": (1, 4), "BR": (2, 4)})
# Green faces
for n in range(1, 10):
    CELL_MAP[f"G{n}"] = (n + 2, 4)
CELL_MAP.update({"G0": (0, 5), "GA2": (1, 5), "GS": (2, 5), "GR": (3, 5)})


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT, help="Path to the source atlas PNG")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT, help="Directory for individual card PNGs")
    parser.add_argument("--preview-width", type=int, default=1000, help="Width used by coordinate reference (default: 1000)")
    parser.add_argument("--x-start", type=float, default=1.0, help="First cell left edge in preview coordinates")
    parser.add_argument("--y-start", type=float, default=1.0, help="First cell top edge in preview coordinates")
    parser.add_argument("--x-step", type=float, default=82.2, help="Horizontal cell step in preview coordinates")
    parser.add_argument("--y-step", type=float, default=126.0, help="Vertical cell step in preview coordinates")
    parser.add_argument("--cell-width", type=float, default=78.5, help="Crop width in preview coordinates")
    parser.add_argument("--cell-height", type=float, default=121.0, help="Crop height in preview coordinates")
    args = parser.parse_args()

    if not args.input.is_file():
        print("Source texture sheet not found:\n  " + str(args.input), file=sys.stderr)
        print("Download the selected classic PC texture sheet from:", file=sys.stderr)
        print("  https://textures.spriters-resource.com/pc_computer/uno/asset/374167/", file=sys.stderr)
        print("Save it to public/assets/uno-classic-sheet.png, then rerun this script.", file=sys.stderr)
        return 2

    with Image.open(args.input) as source:
        source = source.convert("RGBA")
        scale_x = source.width / args.preview_width
        scale_y = source.height / args.preview_width
        args.output.mkdir(parents=True, exist_ok=True)
        for filename, (column, row) in CELL_MAP.items():
            left = round((args.x_start + column * args.x_step) * scale_x)
            top = round((args.y_start + row * args.y_step) * scale_y)
            right = round((args.x_start + column * args.x_step + args.cell_width) * scale_x)
            bottom = round((args.y_start + row * args.y_step + args.cell_height) * scale_y)
            if right > source.width or bottom > source.height:
                print(f"Crop outside atlas for {filename}: {(left, top, right, bottom)}", file=sys.stderr)
                return 3
            crop = source.crop((left, top, right, bottom))
            crop.save(args.output / f"{filename}.png", optimize=True)
    print(f"Wrote {len(CELL_MAP)} individual card images to {args.output}")
    print("Spot-check the generated images before committing them; the source atlas coordinates are approximate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
