"""`python -m corridor.overview <slug>` — the ten-second repair for a tiled site that will not load.

See `network_tiles.ensure_overview`. Safe to re-run; it only adds the dem/chm/naip overview layers
to a manifest that has `layers.tiles`, and leaves everything else alone.
"""
from .network_tiles import main_overview

if __name__ == "__main__":
    main_overview()
