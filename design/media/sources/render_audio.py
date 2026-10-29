"""Earshot procedural path only: no Torch, model weights, inference, or network."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys

os.environ["EARSHOT_OFFLINE"] = "1"
parser = argparse.ArgumentParser()
parser.add_argument("--earshot-source", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
sys.path.insert(0, str(Path(args.earshot_source).resolve()))
import earshot
from earshot.forge import bank, sfx
import soundfile as sf

if earshot.__version__ != "0.4.0":
    raise SystemExit("Expected Earshot 0.4.0")
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
recipe = {"sound_id": "notify/mid_tine", "seed": 51, "peak_db": -16.0}
samples, metadata = bank.render(**recipe)
checks = sfx.check(samples, sr=48000, category="notify")
if not checks["ok"]:
    raise SystemExit(json.dumps(checks, ensure_ascii=False))
wav = output / "jk-ready.wav"
sf.write(wav, samples, 48000, subtype="PCM_24")
report = {"tool": "earshot", "version": earshot.__version__,
          "sourceCommit": "591fa3e028032e6dce56620a20e932e35667e8d8",
          "path": "earshot.forge.bank.render + earshot.forge.sfx.check",
          "modelsLoaded": False, "networkRequiredAtRender": False,
          "recipe": recipe, "metadata": metadata, "checks": checks,
          "output": wav.name, "sha256": hashlib.sha256(wav.read_bytes()).hexdigest()}
(output / "earshot-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"output": wav.name, "ok": checks["ok"], "warnings": checks["warnings"],
                  "durationSeconds": len(samples)/48000, "modelsLoaded": False}))
