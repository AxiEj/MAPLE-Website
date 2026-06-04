#!/usr/bin/env python3
"""Render a single-frame XYZ cluster as a documentation PNG.

The renderer is intentionally lightweight: orthographic projection, CPK-like
colours, covalent-radius bond guessing, and optional first-N solute highlighting.
It is meant for static documentation figures when VMD is unavailable/headless.
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

CPK = {
    "H": (248, 250, 252),
    "C": (51, 65, 85),
    "N": (37, 99, 235),
    "O": (220, 38, 38),
    "F": (34, 197, 94),
    "P": (249, 115, 22),
    "S": (234, 179, 8),
    "CL": (22, 163, 74),
    "BR": (146, 64, 14),
    "I": (126, 34, 206),
}

COVALENT = {
    "H": 0.31, "C": 0.76, "N": 0.71, "O": 0.66, "F": 0.57,
    "P": 1.07, "S": 1.05, "CL": 1.02, "BR": 1.20, "I": 1.39,
}

VDW = {
    "H": 1.20, "C": 1.70, "N": 1.55, "O": 1.52, "F": 1.47,
    "P": 1.80, "S": 1.80, "CL": 1.75, "BR": 1.85, "I": 1.98,
}


def _norm_symbol(raw: str) -> str:
    s = "".join(ch for ch in raw if ch.isalpha())
    if not s:
        return raw.upper()
    return s[0].upper() + s[1:].lower()


def _key(sym: str) -> str:
    return sym.upper()


def read_xyz(path: Path) -> tuple[list[str], np.ndarray, str]:
    lines = path.read_text().splitlines()
    if not lines:
        raise ValueError(f"empty XYZ file: {path}")
    n = int(lines[0].strip())
    comment = lines[1].strip() if len(lines) > 1 else ""
    symbols: list[str] = []
    coords: list[list[float]] = []
    for line in lines[2:2 + n]:
        parts = line.split()
        if len(parts) < 4:
            raise ValueError(f"bad XYZ atom line in {path}: {line!r}")
        symbols.append(_norm_symbol(parts[0]))
        coords.append([float(parts[1]), float(parts[2]), float(parts[3])])
    if len(symbols) != n:
        raise ValueError(f"expected {n} atoms in {path}, found {len(symbols)}")
    return symbols, np.asarray(coords, dtype=float), comment


def rotation_matrix(degrees: str) -> np.ndarray:
    vals = [float(v) for v in degrees.split(",")]
    if len(vals) != 3:
        raise ValueError("rotation must be three comma-separated degrees: x,y,z")
    ax, ay, az = [math.radians(v) for v in vals]
    rx = np.array([[1, 0, 0], [0, math.cos(ax), -math.sin(ax)], [0, math.sin(ax), math.cos(ax)]])
    ry = np.array([[math.cos(ay), 0, math.sin(ay)], [0, 1, 0], [-math.sin(ay), 0, math.cos(ay)]])
    rz = np.array([[math.cos(az), -math.sin(az), 0], [math.sin(az), math.cos(az), 0], [0, 0, 1]])
    return rz @ ry @ rx


def guess_bonds(symbols: list[str], coords: np.ndarray) -> list[tuple[int, int]]:
    bonds: list[tuple[int, int]] = []
    n = len(symbols)
    for i in range(n):
        ri = COVALENT.get(_key(symbols[i]), 0.75)
        for j in range(i + 1, n):
            rj = COVALENT.get(_key(symbols[j]), 0.75)
            cutoff = 1.22 * (ri + rj) + 0.05
            d = float(np.linalg.norm(coords[i] - coords[j]))
            if 0.35 < d <= cutoff:
                bonds.append((i, j))
    return bonds


def blend(rgb: tuple[int, int, int], factor: float) -> tuple[int, int, int]:
    # factor < 1 darkens; factor > 1 lightens toward white.
    if factor <= 1:
        return tuple(max(0, min(255, int(c * factor))) for c in rgb)
    return tuple(max(0, min(255, int(c + (255 - c) * (factor - 1)))) for c in rgb)


def rgba(rgb: tuple[int, int, int], alpha: int) -> tuple[int, int, int, int]:
    return rgb[0], rgb[1], rgb[2], alpha


def render(
    symbols: list[str],
    coords: np.ndarray,
    out: Path,
    *,
    width: int,
    height: int,
    solute_atoms: int,
    rotation: str,
    zoom: float,
) -> None:
    rot = rotation_matrix(rotation)
    xyz = (coords - coords.mean(axis=0)) @ rot.T
    xy = xyz[:, :2]
    z = xyz[:, 2]

    span = np.ptp(xy, axis=0)
    scale = min((width - 110) / max(span[0], 1e-6), (height - 90) / max(span[1], 1e-6)) * zoom
    px = xy[:, 0] * scale + width / 2
    py = -xy[:, 1] * scale + height / 2

    zmin, zmax = float(z.min()), float(z.max())
    zspan = max(zmax - zmin, 1e-6)
    depth = (z - zmin) / zspan

    img = Image.new("RGBA", (width, height), (248, 250, 252, 255))
    draw = ImageDraw.Draw(img, "RGBA")

    # Gentle background grid gives large solvent boxes shape without visual noise.
    for x in range(0, width, 80):
        draw.line((x, 0, x, height), fill=(226, 232, 240, 80), width=1)
    for y in range(0, height, 80):
        draw.line((0, y, width, y), fill=(226, 232, 240, 80), width=1)

    bonds = guess_bonds(symbols, coords)
    for i, j in sorted(bonds, key=lambda ij: (z[ij[0]] + z[ij[1]]) / 2):
        solute_bond = i < solute_atoms and j < solute_atoms
        alpha = 185 if solute_bond else 58
        width_px = 3 if solute_bond else 1
        draw.line((px[i], py[i], px[j], py[j]), fill=(71, 85, 105, alpha), width=width_px)

    for i in np.argsort(z):
        key = _key(symbols[int(i)])
        base = CPK.get(key, (148, 163, 184))
        is_solute = int(i) < solute_atoms
        d = float(depth[int(i)])
        shade = 0.78 + 0.32 * d
        color = blend(base, shade)
        atom_alpha = 242 if is_solute else 122
        radius_scale = 0.31 if is_solute else 0.18
        r = max(2.2, min(15.0, VDW.get(key, 1.60) * radius_scale * scale))
        if is_solute:
            r *= 1.25
        x0, y0, x1, y1 = px[i] - r, py[i] - r, px[i] + r, py[i] + r
        shadow = (0, 0, 0, 40 if is_solute else 15)
        draw.ellipse((x0 + 1.5, y0 + 1.5, x1 + 1.5, y1 + 1.5), fill=shadow)
        draw.ellipse((x0, y0, x1, y1), fill=rgba(color, atom_alpha), outline=(15, 23, 42, 180 if is_solute else 55), width=1)
        # Small highlight for sphere-like depth.
        hr = r * 0.34
        draw.ellipse((px[i] - r * 0.35, py[i] - r * 0.42, px[i] - r * 0.35 + hr, py[i] - r * 0.42 + hr), fill=(255, 255, 255, 80 if is_solute else 32))

    out.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(out, optimize=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("xyz", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--width", type=int, default=900)
    parser.add_argument("--height", type=int, default=650)
    parser.add_argument("--solute-atoms", type=int, default=0, help="first N atoms to highlight as solute")
    parser.add_argument("--rotation", default="-62,0,34", help="x,y,z Euler rotation in degrees")
    parser.add_argument("--zoom", type=float, default=1.0)
    args = parser.parse_args()
    symbols, coords, _comment = read_xyz(args.xyz)
    render(
        symbols,
        coords,
        args.out,
        width=args.width,
        height=args.height,
        solute_atoms=args.solute_atoms,
        rotation=args.rotation,
        zoom=args.zoom,
    )
    print(f"Rendered {len(symbols)} atoms -> {args.out}")


if __name__ == "__main__":
    main()
