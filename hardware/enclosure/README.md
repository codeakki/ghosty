# Ghost enclosure

White, single-colour ghost case for the ESP32-S3 pod. Designed, not printed or test-fitted yet.

| File | What it is | Size |
|---|---|---|
| `ghost_shell.stl` | Body | 100 mm diameter × 100 mm tall, 2.5 mm wall |
| `ghost_base.stl` | Base plate; a 6 mm ring on top fits inside the body | 104 mm diameter × 3 mm (9 mm with ring) |
| `ghost_all_in_one.stl` | Both parts side by side, 8 mm apart | 212 × 104 × 100 mm (needs a bed of 215 mm or more) |
| `ghost.py` | Generates the three STL files | |

All STL files are watertight.

## Features

- Two 8 × 12 mm eyes. The INMP441 sits in a sleeve behind one eye (fits a 14.6 mm round board).
- Mouth grille of 3 mm holes with a ring behind it for a 40 mm speaker (fits 40.6 mm).
- Wavy bottom edge.
- 32 × 18 mm opening at the bottom of the back for the USB-C ports and the cable; the base ring has a matching gap.
- Inside space about 95 mm wide and 97 mm tall.

## Print

| Setting | Value |
|---|---|
| Material | White PLA or PETG |
| Body | Upright, wavy edge on the bed, no supports |
| Base plate | Flat, ring up |
| Layer height / infill | 0.2 mm / 15–20 % |

Measure your speaker, mic board and ESP32 before printing; change the numbers at the top of `ghost.py` if they differ.

## Regenerate

```bash
python3 -m venv .venv && .venv/bin/pip install manifold3d numpy trimesh
cd hardware/enclosure && ../../.venv/bin/python ghost.py
```

Main parameters in `ghost.py`: `R` (body radius), `H_BODY` (straight part; total height = `H_BODY + R`), `WALL`, `EYE_Z`, `SPK_Z`, `PLATE_R`.
