"""The corridor bake.

Two things live at the package root because every stage needs them and none owns them:
`BakeFault`, and `write_atomic` for anything written into the shared cache.
"""

import os as _os
import threading as _threading
from pathlib import Path as _Path


def write_atomic(path, data) -> None:
    """Write `data` (str or bytes) to `path` so a reader sees all of it or none of it.

    THE CACHE IS SHARED. A sharded bake runs 25 Jobs on one volume, and they ask for the same
    Overpass answers, lidar hierarchy files and catalogue indexes at once. A plain `write_text`
    opens the file empty and fills it, and a second shard that reads in between gets nothing — one
    dc-metro shard died on exactly that on 2026-10-10 (an empty EPT hierarchy file, `json.loads`).
    So: a private temp file in the same directory, then `os.replace`, which is atomic on POSIX.
    """
    path = _Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{_os.getpid()}.{_threading.get_ident()}.tmp")
    try:
        if isinstance(data, str):
            tmp.write_text(data)
        else:
            tmp.write_bytes(data)
        _os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


class BakeFault(RuntimeError):
    """
    A bake that would ship a wrong world, caught by measuring its own output.

    The stages wrap most failures as a note and carry on — a missing canopy is a world without
    trees, which is still a world. A fault is different: the numbers say the output is wrong
    (junctions a kilometre off their roads, every branch grade a metre above the earth the
    pyramid writes), and a bake that prints a line and continues has shipped it. Everything that
    catches `Exception` on the export path re-raises this, so it reaches the job's exit status.
    """
