"""Package a Windows installer from a prepared checkout using a file allowlist."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

PACKAGE = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    manifest = json.loads((PACKAGE / "extension/manifest.json").read_text(encoding="utf-8"))
    metadata = json.loads((PACKAGE / "native/ffmpeg/provenance.json").read_text(encoding="utf-8"))
    converter = PACKAGE / "native/ffmpeg/ffmpeg.exe"
    if not (PACKAGE / "native/XImageSaverHost.exe").is_file() or not converter.is_file():
        raise RuntimeError("Prepare FFmpeg and compile the native helper before packaging")
    if hashlib.sha256(converter.read_bytes()).hexdigest() != metadata["binarySha256"]:
        raise RuntimeError("Converter binary SHA-256 mismatch")
    files = []
    for directory in ("extension", "scripts", "tests"):
        files.extend(path for path in (PACKAGE / directory).rglob("*")
            if path.is_file() and "__pycache__" not in path.parts)
    for name in ("XImageSaverHost.cs", "XImageSaverHost.exe", "Install.ps1", "Uninstall.ps1"):
        files.append(PACKAGE / "native" / name)
    for name in ("ffmpeg.exe", "LICENSE", "README.txt", "provenance.json", "来源与许可.txt"):
        files.append(PACKAGE / "native/ffmpeg" / name)
    for name in ("README.md", "使用说明.txt", "package.json", "requirements-dev.txt", "install.cmd", "uninstall.cmd"):
        files.append(PACKAGE / name)
    output = args.output.resolve() if args.output else PACKAGE / "dist" / ("x-image-saver-v" + manifest["version"] + ".zip")
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(set(files)):
            archive.write(path, "x-image-saver/" + path.relative_to(PACKAGE).as_posix())
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Release archive integrity check failed")
        for script in manifest["content_scripts"]:
            for filename in script["js"]:
                if "x-image-saver/extension/" + filename not in archive.namelist():
                    raise RuntimeError("Release archive is missing a page script")
        for name in ("Install.ps1", "Uninstall.ps1"):
            if not archive.read("x-image-saver/native/" + name).startswith(b"\xef\xbb\xbf"):
                raise RuntimeError("Installer must preserve its UTF-8 BOM")
    print(json.dumps({"archive": str(output), "version": manifest["version"], "files": len(set(files)), "bytes": output.stat().st_size}))

if __name__ == "__main__":
    main()
