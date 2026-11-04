from __future__ import annotations

import hashlib
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
CHECKPOINT = ROOT / "public/models/beat-detection-tcn.pt"
OUTPUT = ROOT / "public/models/beat-detection-tcn.onnx"
EXPECTED_SHA256 = "0a2e4420f48cdc6554a5e57214e23cdc89c0dcbc6d8987dc34647cfe33cf96fc"


def load_checkpoint():
    digest = hashlib.sha256(CHECKPOINT.read_bytes()).hexdigest()
    if digest != EXPECTED_SHA256:
        raise ValueError(f"Unexpected checkpoint SHA256: {digest}")
    # The HF checkpoint stores NumPy scalar/dtype config values. Explicit allowlisting
    # keeps weights_only=True and avoids executing arbitrary pickle globals.
    torch.serialization.add_safe_globals([
        np._core.multiarray.scalar,
        np.dtype,
        type(np.dtype(np.float64)),
    ])
    return torch.load(CHECKPOINT, map_location="cpu", weights_only=True)


class TCNBlock(nn.Module):
    def __init__(self, channels: int, kernel: int, dilation1: int, dilation2: int, dropout: float):
        super().__init__()
        self.conv1 = nn.Conv1d(channels, channels, kernel, padding=(kernel - 1) * dilation1 // 2, dilation=dilation1)
        self.bn1 = nn.BatchNorm1d(channels)
        self.drop1 = nn.Dropout(dropout)
        self.conv2 = nn.Conv1d(channels, channels, kernel, padding=(kernel - 1) * dilation2 // 2, dilation=dilation2)
        self.bn2 = nn.BatchNorm1d(channels)
        self.drop2 = nn.Dropout(dropout)
        self.elu = nn.ELU()

    def forward(self, x):
        residual = x
        x = self.drop1(self.elu(self.bn1(self.conv1(x))))
        x = self.drop2(self.elu(self.bn2(self.conv2(x))))
        return x + residual


class BeatTCN(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.frontend = nn.Sequential(
            nn.Conv2d(1, 16, kernel_size=3, padding=1), nn.BatchNorm2d(16), nn.ELU(), nn.MaxPool2d((3, 1)),
            nn.Conv2d(16, 16, kernel_size=3, padding=1), nn.BatchNorm2d(16), nn.ELU(), nn.MaxPool2d((3, 1)),
            nn.Conv2d(16, 16, kernel_size=1), nn.BatchNorm2d(16), nn.ELU(),
        )
        self.projection = nn.Sequential(nn.Linear(16 * (config.n_mels // 9), config.tcn_channels), nn.ELU())
        self.tcn_blocks = nn.ModuleList([
            TCNBlock(config.tcn_channels, config.tcn_kernel_size, 2**i, 2**(i + 1), config.dropout)
            for i in range(config.tcn_layers)
        ])
        self.output_head = nn.Sequential(
            nn.Conv1d(config.tcn_channels, config.tcn_channels, 1), nn.ELU(), nn.Dropout(config.dropout),
            nn.Conv1d(config.tcn_channels, 1, 1),
        )

    def forward(self, mel):
        x = self.frontend(mel.unsqueeze(1))
        batch, channels, freq, frames = x.shape
        x = x.permute(0, 3, 1, 2).reshape(batch, frames, channels * freq)
        x = self.projection(x).permute(0, 2, 1)
        for block in self.tcn_blocks:
            x = block(x)
        return self.output_head(x).squeeze(1)


def main():
    checkpoint = load_checkpoint()
    config = SimpleNamespace(**checkpoint["config"])
    model = BeatTCN(config).eval()
    model.load_state_dict(checkpoint["model_state_dict"], strict=True)
    sample = torch.zeros(1, config.n_mels, 800, dtype=torch.float32)
    with torch.inference_mode():
        output = model(sample)
    if output.shape != (1, 800) or not torch.isfinite(output).all():
        raise RuntimeError(f"Unexpected model output: {tuple(output.shape)}")

    torch.onnx.export(
        model,
        (sample,),
        OUTPUT,
        input_names=["log_mel"],
        output_names=["beat_logits"],
        dynamic_axes={"log_mel": {2: "frames"}, "beat_logits": {1: "frames"}},
        opset_version=17,
        dynamo=False,
        do_constant_folding=True,
    )
    import onnx
    exported = onnx.load(OUTPUT)
    onnx.checker.check_model(exported)
    print(f"Exported {OUTPUT.relative_to(ROOT)} ({OUTPUT.stat().st_size:,} bytes)")
    print(f"Checkpoint F-measure: {checkpoint.get('best_f_measure')}")
    print(f"Config: {checkpoint['config']}")


if __name__ == "__main__":
    main()
