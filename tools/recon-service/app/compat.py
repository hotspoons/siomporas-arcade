"""Compatibility shims for vendored model code, applied before any pipeline import.

Keep this module tiny and keep every shim explained. Each one exists because an upstream component
was written against an older dependency; a shim with no note becomes impossible to remove safely.
"""
from __future__ import annotations


def apply() -> None:
    _birefnet_tied_weights()
    _dinov3_layer_attribute()


def _birefnet_tied_weights() -> None:
    """RMBG-2.0 ships its own BiRefNet class via trust_remote_code, written before transformers 5.x.

    transformers 5 asks every model for `all_tied_weights_keys` while finalising a load. BiRefNet
    does not define it, and nn.Module.__getattr__ raises AttributeError rather than returning a
    default, so the load dies with:

        AttributeError: 'BiRefNet' object has no attribute 'all_tied_weights_keys'

    A class-level default on the base restores pre-5.x behaviour for any such model without
    touching vendored code. Remove this once RMBG-2.0's remote code is updated.
    """
    import transformers.modeling_utils as mu

    if not hasattr(mu.PreTrainedModel, "all_tied_weights_keys"):
        mu.PreTrainedModel.all_tied_weights_keys = {}


def _dinov3_layer_attribute() -> None:
    """TRELLIS.2 reads `model.layer`; transformers 5.x nests the encoder one level down.

    `DinoV3FeatureExtractor.extract_features` walks the transformer blocks directly:

        for i, layer_module in enumerate(self.model.layer):

    In transformers 5.x the encoder is a child module named `model`, so the blocks live at
    `model.model.layer` and the old path raises:

        AttributeError: 'DINOv3ViTModel' object has no attribute 'layer'

    `embeddings` and `rope_embeddings`, which the same function also uses, are still top-level --
    this is the only path that moved. A property re-exposes it without editing vendored code.
    Remove this if TRELLIS.2 is updated for transformers 5.
    """
    from transformers.models.dinov3_vit.modeling_dinov3_vit import DINOv3ViTModel

    if not hasattr(DINOv3ViTModel, "layer"):
        DINOv3ViTModel.layer = property(lambda self: self.model.layer)
