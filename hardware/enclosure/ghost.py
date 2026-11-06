# Ghost-shaped case for the ESP32-S3 + INMP441 mic + MAX98357A amp + 40 mm speaker.
# Size: body 100 mm diameter x 100 mm tall, standing on a 104 mm base plate.
# Units: mm. Front of the ghost faces -Y. Print everything in one colour (white).
# Output: ghost_shell.stl (body) and ghost_base.stl (base plate).
import math
import numpy as np
import trimesh
from manifold3d import Manifold

SEG = 160
R = 50.0                   # outer radius of the body (100 mm diameter)
H_BODY = 50.0              # straight part; the dome (radius R) brings the total to 100 mm
WALL = 2.5
RI = R - WALL


def cyl(r, z0, z1, r_top=None):
    top = 1.0 if r_top is None else r_top / r
    return Manifold.cylinder(z1 - z0, 1.0, top, SEG).scale([r, r, 1]).translate([0, 0, z0])


def dome(r, z):
    return Manifold.sphere(1.0, SEG).scale([r, r, r]).translate([0, 0, z])


def rod_y(rx, rz, x, z, y0=-60.0, y1=0.0):
    """Cylinder along Y with an elliptical section (rx wide, rz tall)."""
    return (Manifold.cylinder(y1 - y0, 1.0, 1.0, 48)
            .scale([rx, rz, 1]).rotate([-90, 0, 0]).translate([x, y0, z]))


def tube_y(r_out, r_in, x, z, y0, y1):
    return rod_y(r_out, r_out, x, z, y0, y1) - rod_y(r_in, r_in, x, z, y0 - 1, y1 + 1)


outer = cyl(R, 0, H_BODY) + dome(R, H_BODY)
cavity = cyl(RI, -1, H_BODY) + dome(RI, H_BODY)
shell = outer - cavity

# Wavy hem: 8 scallops around the bottom edge (none at the back, where the USB opening is)
for i in range(8):
    t = 2 * math.pi * (i + 0.5) / 8
    shell -= Manifold.sphere(10.0, 64).translate([R * math.cos(t), R * math.sin(t), -3])

# USB opening at the back, low down, for the ESP32 ports and the cable
USB_W, USB_H = 32.0, 18.0
shell -= Manifold.cube([USB_W, 30, USB_H * 2], True).translate([0, R, 0])

# Eyes (the mic sits behind the right eye, seen from the front)
EYE_Z, EYE_X = 72.0, 16.0
for x in (-EYE_X, EYE_X):
    shell -= rod_y(4.0, 6.0, x, EYE_Z)

# Mic holder: sleeve for the 14 mm round INMP441 board behind one eye
shell += tube_y(9.0, 7.3, EYE_X, EYE_Z, -52, -28) ^ cavity
shell -= rod_y(4.0, 6.0, EYE_X, EYE_Z)

# Speaker grille ("mouth") and holder ring for a 40 mm speaker
SPK_Z, SPK_R = 40.0, 20.3
for gx in np.arange(-15, 15.1, 4.5):
    for gz in np.arange(-15, 15.1, 4.5):
        if gx * gx + gz * gz <= 15.5 ** 2:
            shell -= rod_y(1.5, 1.5, gx, SPK_Z + gz, -60, -38)
shell += tube_y(SPK_R + 2.0, SPK_R, 0, SPK_Z, -52, -38) ^ cavity

# Base plate: 104 mm disc with a 1 mm chamfer; a ring on top fits inside the body
PLATE_R, PLATE_T = 52.0, 3.0
base = cyl(PLATE_R, 0, PLATE_T - 1) + cyl(PLATE_R, PLATE_T - 1, PLATE_T, r_top=PLATE_R - 1)
ring = cyl(RI - 0.3, PLATE_T - 0.5, PLATE_T + 6) - cyl(RI - 2.3, 0, PLATE_T + 7)
ring -= Manifold.cube([USB_W + 4, 30, 40], True).translate([0, R, 0])   # gap at the USB opening
base += ring


def combined(gap=8.0):
    """Both parts side by side on one print bed, as one file."""
    return shell.translate([-(R + gap / 2), 0, 0]) + base.translate([PLATE_R + gap / 2, 0, 0])


def save(m, path):
    mesh = m.to_mesh()
    tm = trimesh.Trimesh(vertices=np.asarray(mesh.vert_properties)[:, :3],
                         faces=np.asarray(mesh.tri_verts), process=False)
    tm.export(path)
    ext = tm.bounds[1] - tm.bounds[0]
    print(f"{path}: {len(tm.faces)} triangles, watertight={tm.is_watertight}, "
          f"size={ext[0]:.1f} x {ext[1]:.1f} x {ext[2]:.1f} mm, volume={tm.volume / 1000:.1f} cm3")
    return tm


if __name__ == "__main__":
    save(shell, "ghost_shell.stl")
    save(base, "ghost_base.stl")
    save(combined(), "ghost_all_in_one.stl")
