# SPDX-License-Identifier: GPL-3.0-or-later
"""
Find the four wheels in a reconstructed car, geometrically.

WHY THIS CANNOT USE CONNECTIVITY. `blrig`'s `rig_wheel` skill rigs a wheel that is already its own
object, and `loose_parts` finds objects. Measured on `190e-evo/mesh.finished.glb`: the raw file has
20,742 "parts", because TRELLIS writes a vertex per triangle corner and nothing is joined to
anything. Welding at 1e-5 drops that to 96 — and 63,298 of the 65,095 remaining vertices are in ONE
component. The wheels are fused to the body. That is Rich's "make sure the wheels are free from the
body!" stated as a measurement: connectivity will never separate them, so shape has to.

WHAT A WHEEL IS, GEOMETRICALLY. Seen from the side a wheel is a disc: its surface is at a roughly
constant distance from an axis that runs across the car. So for each corner of the car this fits a
circle in the longitudinal/vertical plane and keeps the vertices that sit on it. Nothing here reads
colour — the glass work cost four rounds on exactly that mistake, and a dark tyre is no more
reliable a signal than dark glass was.

NOTHING IS ASSUMED ABOUT THE AXES. A .glb carries whatever the exporter wrote; the long horizontal
extent is the length and the short one is the width, and which of those is X is read, not declared.
"""

import json
import math
import sys


def say(tag, payload):
    print("@@ {} {}".format(tag, json.dumps(payload)), flush=True)


def kasa_circle(pts):
    """
    Least-squares circle through (u, v) points — Kasa's algebraic fit.

    Algebraic rather than geometric on purpose: it is a single linear solve, it cannot fail to
    converge, and the refinement below throws away the outliers that make the algebraic fit biased.
    """
    n = len(pts)
    if n < 8:
        return None
    su = sv = suu = svv = suv = suuu = svvv = suvv = svuu = 0.0
    for u, v in pts:
        su += u; sv += v
        suu += u * u; svv += v * v; suv += u * v
        suuu += u * u * u; svvv += v * v * v
        suvv += u * v * v; svuu += v * u * u
    a11 = 2 * (n * suu - su * su)
    a12 = 2 * (n * suv - su * sv)
    a22 = 2 * (n * svv - sv * sv)
    b1 = n * (suuu + suvv) - su * (suu + svv)
    b2 = n * (svvv + svuu) - sv * (suu + svv)
    det = a11 * a22 - a12 * a12
    if abs(det) < 1e-12:
        return None
    cu = (b1 * a22 - b2 * a12) / det
    cv = (a11 * b2 - a12 * b1) / det
    r = sum(math.hypot(u - cu, v - cv) for u, v in pts) / n
    return cu, cv, r


def fit_wheel(pts, tol=0.18, rounds=4):
    """
    Fit, drop the points that do not lie on the circle, fit again.

    The corner of a car contains an arch, a sill and a bumper as well as a wheel, and an unfiltered
    fit splits the difference between all of them. Each round keeps only what is within `tol` of
    the current radius, so the arch falls away and the tyre survives. Returns the fit and the share
    of the original points that agreed with it — that share is what tells a wheel from a bumper.
    """
    keep = list(pts)
    fit = None
    for _ in range(rounds):
        fit = kasa_circle(keep)
        if fit is None:
            return None
        cu, cv, r = fit
        if r <= 1e-6:
            return None
        nxt = [(u, v) for u, v in keep if abs(math.hypot(u - cu, v - cv) - r) <= tol * r]
        if len(nxt) < 8:
            break
        keep = nxt
    cu, cv, r = fit
    agree = sum(1 for u, v in pts if abs(math.hypot(u - cu, v - cv) - r) <= tol * r)
    return {"centre": (cu, cv), "radius": r, "inliers": len(keep),
            "share": agree / max(1, len(pts))}
