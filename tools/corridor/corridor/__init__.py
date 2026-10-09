"""The corridor bake.

One thing lives at the package root because every stage needs it and none owns it:
"""


class BakeFault(RuntimeError):
    """
    A bake that would ship a wrong world, caught by measuring its own output.

    The stages wrap most failures as a note and carry on — a missing canopy is a world without
    trees, which is still a world. A fault is different: the numbers say the output is wrong
    (junctions a kilometre off their roads, every branch grade a metre above the earth the
    pyramid writes), and a bake that prints a line and continues has shipped it. Everything that
    catches `Exception` on the export path re-raises this, so it reaches the job's exit status.
    """
