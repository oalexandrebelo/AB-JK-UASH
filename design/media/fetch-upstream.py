#!/usr/bin/env python3
"""Explicit, pinned download for the optional authoring environment; no execution."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import tarfile
from urllib.request import urlopen

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("destination", help="Dedicated empty directory outside the application")
args = parser.parse_args()
root = Path(__file__).resolve().parent
pin = json.loads((root / "upstream.lock.json").read_text())["earshot"]
destination = Path(args.destination).resolve()
if destination.exists() and any(destination.iterdir()):
    raise SystemExit("Destination must be empty; no existing work will be overwritten.")
with urlopen(pin["archiveUrl"], timeout=60) as response:
    data = response.read(32 * 1024 * 1024 + 1)
if len(data) > 32 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != pin["archiveSha256"]:
    raise SystemExit("Pinned archive checksum/size mismatch.")
destination.mkdir(parents=True, exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
    for member in archive.getmembers():
        parts = Path(member.name).parts[1:]
        if not parts:
            continue
        if any(part in (".", "..") for part in parts) or member.issym() or member.islnk():
            raise SystemExit("Unsafe archive member rejected.")
        target = destination.joinpath(*parts)
        if not target.is_relative_to(destination):
            raise SystemExit("Unsafe archive path rejected.")
        if member.isdir():
            target.mkdir(parents=True, exist_ok=True)
        elif member.isfile():
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(archive.extractfile(member).read())
        else:
            raise SystemExit("Unsupported archive member rejected.")
print(json.dumps({"repository": pin["repository"], "commit": pin["commit"], "archiveSha256": pin["archiveSha256"], "extracted": True}))
