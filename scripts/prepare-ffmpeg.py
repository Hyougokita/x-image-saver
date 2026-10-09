"""Prepare the pinned Windows converter for source builds; never installs it."""
from pathlib import Path
import hashlib
import json
import shutil
import urllib.parse
import urllib.request
import uuid
import zipfile

PACKAGE = Path(__file__).resolve().parents[1]
DESTINATION = PACKAGE / "native/ffmpeg"

def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

def main():
    metadata = json.loads((DESTINATION / "provenance.json").read_text(encoding="utf-8"))
    binary = DESTINATION / "ffmpeg.exe"
    if binary.exists() and sha256(binary) == metadata["binarySha256"]:
        print("Pinned FFmpeg binary is already present and verified.")
        return
    url = urllib.parse.urlparse(metadata["source"])
    if url.scheme != "https" or url.netloc != "www.gyan.dev" or not url.path.startswith("/ffmpeg/builds/packages/"):
        raise RuntimeError("Unexpected converter source URL")
    scratch = PACKAGE / ".build"
    scratch.mkdir(mode=0o777, exist_ok=True)
    archive = scratch / ("ffmpeg-" + uuid.uuid4().hex + ".zip")
    temporary = DESTINATION / ("ffmpeg.exe." + uuid.uuid4().hex + ".tmp")
    try:
        print("Downloading the pinned FFmpeg Windows build...")
        with urllib.request.urlopen(metadata["source"], timeout=60) as response, archive.open("wb") as output:
            size = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > 512 * 1024 * 1024:
                    raise RuntimeError("Converter archive exceeds the size limit")
                output.write(chunk)
        if sha256(archive) != metadata["archiveSha256"]:
            raise RuntimeError("Converter archive SHA-256 mismatch")
        with zipfile.ZipFile(archive) as source:
            members = [member for member in source.infolist() if member.filename.endswith("/bin/ffmpeg.exe")]
            if len(members) != 1 or members[0].file_size > 256 * 1024 * 1024:
                raise RuntimeError("Unexpected converter archive contents")
            with source.open(members[0]) as input_file, temporary.open("wb") as output:
                shutil.copyfileobj(input_file, output)
        if sha256(temporary) != metadata["binarySha256"]:
            raise RuntimeError("Converter binary SHA-256 mismatch")
        temporary.replace(binary)
        print("Prepared and verified native/ffmpeg/ffmpeg.exe")
    finally:
        for path in (archive, temporary):
            if path.exists():
                path.unlink()

if __name__ == "__main__":
    main()
