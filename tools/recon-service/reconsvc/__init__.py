"""Recon service package.

Named `reconsvc` and not `app` on purpose: TRELLIS.2 ships its own `/opt/TRELLIS2/app.py` (a Gradio
demo), and it has to be on PYTHONPATH for `trellis2` to import. A plain module beats a namespace
package in Python's import order, so `app.main` resolved to THEIR app.py and the service died at
startup trying to import gradio. A distinct name cannot collide.
"""
