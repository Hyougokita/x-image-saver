"""Run the actual installer validation path with Windows PowerShell 5.1."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid

PACKAGE = Path(__file__).resolve().parents[1]
POWERSHELL = Path(os.environ.get("SystemRoot", "C:\\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
MANIFEST = json.loads((PACKAGE / "extension/manifest.json").read_text(encoding="utf-8"))
PUBLIC_KEY_HASH = hashlib.sha256(base64.b64decode(MANIFEST["key"])).digest()[:16].hex()
EXTENSION_ID = "".join(chr(97 + int(c, 16)) for c in PUBLIC_KEY_HASH)

class InstallerTests(unittest.TestCase):
    def test_converter_binary_hash_validation_without_installation(self):
        result = subprocess.run([str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(PACKAGE / "native/Install.ps1"), "-ValidateConverterOnly"], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", errors="replace"))
        response = json.loads(result.stdout.decode("utf-8-sig"))
        metadata = json.loads((PACKAGE / "native/ffmpeg/provenance.json").read_text(encoding="utf-8"))
        self.assertTrue(response["valid"])
        self.assertEqual(response["binarySha256"].lower(), metadata["binarySha256"])
        self.assertEqual(response["build"], metadata["build"])

    def test_corrupted_converter_is_rejected_before_install(self):
        test_base = Path(os.environ.get("X_IMAGE_SAVER_TEST_TMP", tempfile.gettempdir())).resolve()
        root = test_base / ("x-image-saver-installer-" + uuid.uuid4().hex)
        root.mkdir(mode=0o777)
        try:
            (root / "native/ffmpeg").mkdir(parents=True); (root / "extension").mkdir()
            shutil.copyfile(PACKAGE / "native/Install.ps1", root / "native/Install.ps1")
            shutil.copyfile(PACKAGE / "extension/manifest.json", root / "extension/manifest.json")
            (root / "native/ffmpeg/provenance.json").write_text('{"binarySha256":"' + "0" * 64 + '"}', encoding="utf-8")
            (root / "native/ffmpeg/ffmpeg.exe").write_bytes(b"corrupt binary")
            result = subprocess.run([str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass",
                "-File", str(root / "native/Install.ps1"), "-ValidateConverterOnly"], capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 1)
        finally:
            if root.resolve().parent != test_base or not root.name.startswith("x-image-saver-installer-"):
                raise RuntimeError("Unsafe test cleanup target")
            shutil.rmtree(root)

    def validate(self, package):
        result = subprocess.run([
            str(POWERSHELL), "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(package / "native/Install.ps1"), "-ValidateOnly"
        ], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout.decode("utf-8", errors="replace"))
        self.assertEqual(result.stderr, b"")
        response = json.loads(result.stdout.decode("utf-8-sig"))
        self.assertTrue(response["valid"])
        self.assertEqual(response["name"], MANIFEST["name"])
        self.assertEqual(response["description"], MANIFEST["description"])
        self.assertEqual(response["version"], MANIFEST["version"])
        self.assertEqual(response["extensionId"], EXTENSION_ID)

    def test_utf8_without_bom_preserves_chinese_manifest_fields(self):
        self.assertFalse((PACKAGE / "extension/manifest.json").read_bytes().startswith(b"\xef\xbb\xbf"))
        self.validate(PACKAGE)

    def test_script_bom_preserves_windows_powershell_chinese_strings(self):
        self.assertTrue((PACKAGE / "native/Install.ps1").read_bytes().startswith(b"\xef\xbb\xbf"))
        self.assertTrue((PACKAGE / "native/Uninstall.ps1").read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_package_path_with_chinese_and_spaces(self):
        test_base = Path(os.environ.get("X_IMAGE_SAVER_TEST_TMP", tempfile.gettempdir())).resolve()
        root = test_base / ("x-image-saver-installer-" + uuid.uuid4().hex)
        root.mkdir(mode=0o777)
        try:
            package = root / "中文 安装包"
            (package / "native").mkdir(parents=True)
            (package / "extension").mkdir()
            shutil.copyfile(PACKAGE / "native/Install.ps1", package / "native/Install.ps1")
            shutil.copyfile(PACKAGE / "extension/manifest.json", package / "extension/manifest.json")
            self.validate(package)
            self.assertEqual(sorted(p.name for p in (package / "native").iterdir()), ["Install.ps1"])
        finally:
            if root.resolve().parent != test_base or not root.name.startswith("x-image-saver-installer-"):
                raise RuntimeError("Unsafe test cleanup target")
            shutil.rmtree(root)

if __name__ == "__main__":
    unittest.main(verbosity=2)
