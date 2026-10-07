"""The stub-span rule: a road that ENDS at ours is not stubbed across the junction.

Rich's "crofton-triangle on both sides of highway" is a way ending on one carriageway that the bake
then drew 60 m on the far side of — which, across a divided highway, is the other carriageway.
"""
import unittest

from corridor.export import _stub_span

STUB = 60.0


class StubSpan(unittest.TestCase):
    def test_a_through_way_is_stubbed_either_side(self):
        self.assertEqual(_stub_span(200.0, 500.0, STUB), (140.0, 260.0))

    def test_a_way_ending_at_ours_is_drawn_only_its_own_side(self):
        # meet near the start: draw from the start up to the junction plus one stub
        self.assertEqual(_stub_span(10.0, 500.0, STUB), (0.0, 70.0))
        # meet near the end: draw from the junction minus one stub to the end
        self.assertEqual(_stub_span(490.0, 500.0, STUB), (430.0, 500.0))

    def test_a_way_shorter_than_the_stub_is_drawn_whole(self):
        self.assertEqual(_stub_span(10.0, 40.0, STUB), (0.0, 40.0))
        self.assertEqual(_stub_span(0.0, 5.0, STUB), (0.0, 5.0))

    def test_a_through_way_near_the_end_still_reaches_the_end(self):
        lo, hi = _stub_span(80.0, 120.0, STUB)
        self.assertEqual((lo, hi), (20.0, 120.0))


if __name__ == "__main__":
    unittest.main()
