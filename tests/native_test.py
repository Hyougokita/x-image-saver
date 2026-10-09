"""Exercise the actual Windows native binary over length-prefixed stdio."""
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import time
import unittest
import uuid
from PIL import Image

PACKAGE = Path(__file__).resolve().parents[1]
KEY = json.loads((PACKAGE / "extension/manifest.json").read_text(encoding="utf-8"))["key"]
DIGEST = hashlib.sha256(base64.b64decode(KEY)).digest()[:16].hex()
ORIGIN = "chrome-extension://" + "".join(chr(97 + int(c, 16)) for c in DIGEST) + "/"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZQkAAAAASUVORK5CYII=")
MP4 = bytes.fromhex("000000186674797069736f6d0000000069736f6d6d703432") + b"\x07" * 300000

def frame(value):
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload

class NativeTests(unittest.TestCase):
    def setUp(self):
        self.test_base = Path(os.environ.get("X_IMAGE_SAVER_TEST_TMP", tempfile.gettempdir())).resolve()
        self.root = self.test_base / ("x-image-saver-test-" + uuid.uuid4().hex)
        self.root.mkdir(mode=0o777)
        self.exe = self.root / "XImageSaverHost.exe"
        shutil.copyfile(PACKAGE / "native/XImageSaverHost.exe", self.exe)
        (self.root / "com.local.x_image_saver.json").write_text(json.dumps({"allowed_origins": [ORIGIN]}), encoding="utf-8")
        self.destination = self.root / "中文 图片目录"
        self.destination.mkdir()
        self.folder = {"id": "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", "name": "插画", "path": str(self.destination)}

    def tearDown(self):
        if self.root.resolve().parent != self.test_base or not self.root.name.startswith("x-image-saver-test-"):
            raise RuntimeError("Unsafe test cleanup target")
        # Windows may briefly retain the executed converter image after process exit.
        for attempt in range(6):
            try:
                shutil.rmtree(self.root)
                break
            except PermissionError:
                if attempt == 5:
                    raise
                time.sleep(0.2)

    def call(self, *requests, origin=ORIGIN):
        process = subprocess.run([str(self.exe), origin], input=b"".join(frame(r) for r in requests), capture_output=True, timeout=15)
        self.assertEqual(process.stderr, b"")
        data = process.stdout
        responses = []
        while data:
            self.assertGreaterEqual(len(data), 4)
            size = struct.unpack("<I", data[:4])[0]
            self.assertLessEqual(size, 1024 * 1024)
            self.assertGreaterEqual(len(data) - 4, size)
            responses.append(json.loads(data[4:4+size]))
            data = data[4+size:]
        return responses

    def configure(self):
        self.assertTrue(self.call({"action": "configure", "folders": [self.folder]})[0]["ok"])

    def save_request(self, **values):
        return {"action": "save", "folderId": self.folder["id"], "filename": "x_sample.png", "base64": base64.b64encode(PNG).decode("ascii"), **values}

    def test_protocol_and_unicode_configuration(self):
        replies = self.call({"action": "ping"}, {"action": "configure", "folders": [self.folder]}, {"action": "ping"})
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["folders"], [])
        self.assertEqual(replies[2]["folders"][0]["name"], "插画")
        self.assertEqual(replies[2]["folders"][0]["path"], str(self.destination))

    def test_saving_bytes_and_duplicate_preservation(self):
        self.configure()
        first, second = self.call(self.save_request(), self.save_request())
        self.assertTrue(first["ok"], first)
        self.assertTrue(second["ok"], second)
        self.assertNotEqual(first["path"], second["path"])
        self.assertEqual(second["filename"], "x_sample (1).png")
        self.assertEqual(Path(first["path"]).read_bytes(), PNG)
        self.assertEqual(Path(second["path"]).read_bytes(), PNG)

    def test_reject_unknown_folder_traversal_and_reserved_names(self):
        self.configure()
        for changes in [{"folderId": "unknown"}, {"filename": "..\\escape.png"}, {"filename": "C:\\outside.png"}, {"filename": "CON.png"}, {"filename": "bad:stream.png"}]:
            with self.subTest(changes=changes):
                self.assertFalse(self.call(self.save_request(**changes))[0]["ok"])
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_content_validation_and_actual_extension(self):
        self.configure()
        bad = self.call(self.save_request(base64=base64.b64encode(b"<html>Error</html>").decode("ascii")))[0]
        self.assertFalse(bad["ok"])
        good = self.call(self.save_request(filename="x_sample.jpg", path="C:\\unconfigured"))[0]
        self.assertTrue(good["ok"], good)
        self.assertEqual(good["filename"], "x_sample.png")
        self.assertEqual(Path(good["path"]).parent, self.destination)

    def test_invalid_configuration_keeps_existing_settings(self):
        self.configure()
        result = self.call({"action": "configure", "folders": [{**self.folder, "path": "relative\\path"}]})[0]
        self.assertFalse(result["ok"])
        self.assertEqual(self.call({"action": "ping"})[0]["folders"][0], self.folder)

    def test_reject_other_extension_origin(self):
        self.assertFalse(self.call({"action": "ping"}, origin="chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/")[0]["ok"])

    def test_size_limit(self):
        self.configure()
        encoded = base64.b64encode(PNG + b"\0" * (20 * 1024 * 1024)).decode("ascii")
        self.assertFalse(self.call(self.save_request(base64=encoded))[0]["ok"])
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_long_directory_truncates_only_media_filename(self):
        target = self.destination
        while len(str(target)) < 175:
            target = target / ("子目录" * 8)
        target.mkdir(parents=True)
        long_folder = {**self.folder, "path": str(target)}
        result = self.call({"action": "configure", "folders": [long_folder]}, self.save_request(filename="x_" + "A" * 110 + ".png"))
        self.assertTrue(result[0]["ok"], result[0])
        self.assertTrue(result[1]["ok"], result[1])
        self.assertLess(len(result[1]["path"]), 260)
        self.assertEqual(Path(result[1]["path"]).read_bytes(), PNG)

    def begin(self, **values):
        return {"action": "beginSave", "folderId": self.folder["id"], "filename": "x_video.mp4", **values}

    def chunks(self, data=MP4):
        return [{"action": "saveChunk", "sequence": i // (256 * 1024), "base64": base64.b64encode(data[i:i + 256 * 1024]).decode("ascii")} for i in range(0, len(data), 256 * 1024)]

    def converter(self):
        directory = self.root / "ffmpeg"
        directory.mkdir()
        tool = directory / "ffmpeg.exe"
        shutil.copyfile(PACKAGE / "native/ffmpeg/ffmpeg.exe", tool)
        return tool

    def real_video(self, converter, size="160x96"):
        video = self.root / "fixture.mp4"
        result = subprocess.run([str(converter), "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=" + size + ":rate=10:duration=1.2", "-c:v", "libx264",
            "-threads", "2", "-pix_fmt", "yuv420p", str(video)], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", errors="replace"))
        return video.read_bytes()

    def test_gif_converter_capability_and_missing_tool(self):
        self.configure()
        self.assertFalse(self.call({"action": "ping"})[0]["gifConversion"])
        rejected = self.call(self.begin(convertToGif=True))[0]
        self.assertFalse(rejected["ok"]); self.assertIn("install.cmd", rejected["error"])
        self.assertEqual(list(self.destination.iterdir()), [])
        self.converter()
        self.assertTrue(self.call({"action": "ping"})[0]["gifConversion"])

    def test_real_animated_gif_frames_duration_loop_and_duplicate_preservation(self):
        self.configure()
        data = self.real_video(self.converter())
        request = [self.begin(convertToGif=True), *self.chunks(data), {"action": "endSave"}]
        replies = self.call(*request, *request)
        self.assertTrue(all(item["ok"] for item in replies), replies)
        first, second = replies[len(request)-1], replies[-1]
        self.assertEqual(first["filename"], "x_video.gif")
        self.assertEqual(second["filename"], "x_video (1).gif")
        self.assertTrue(first["convertedGif"])
        output = Path(first["path"]).read_bytes()
        self.assertEqual(first["bytes"], len(output))
        self.assertTrue(output.startswith(b"GIF89a")); self.assertEqual(output[-1], 0x3B)
        self.assertEqual(output, Path(second["path"]).read_bytes())
        with Image.open(first["path"]) as gif:
            self.assertEqual(gif.format, "GIF"); self.assertEqual(gif.info["loop"], 0)
            self.assertGreater(gif.n_frames, 1); self.assertLessEqual(max(gif.size), 720)
            frames = []; duration = 0
            for index in range(gif.n_frames):
                gif.seek(index); frames.append(gif.convert("RGB").tobytes()); duration += gif.info["duration"]
            self.assertGreater(len(set(frames)), 1)
            self.assertAlmostEqual(duration, 1200, delta=100)
        self.assertEqual(sorted(path.suffix for path in self.destination.iterdir()), [".gif", ".gif"])

    def test_gif_failure_cleans_input_palette_output_and_preserves_existing_file(self):
        self.configure(); self.converter()
        existing = self.destination / "keep.gif"
        existing.write_bytes(b"existing file")
        replies = self.call(self.begin(convertToGif=True), *self.chunks(), {"action": "endSave"})
        self.assertTrue(replies[0]["ok"]); self.assertFalse(replies[-1]["ok"], replies)
        self.assertIn("GIF 转换失败", replies[-1]["error"])
        self.assertEqual(list(self.destination.iterdir()), [existing])
        self.assertEqual(existing.read_bytes(), b"existing file")

    def test_gif_scales_to_720_and_supports_long_chinese_directory(self):
        target = self.destination / ("长" * (220 - len(str(self.destination)) - 1))
        target.mkdir()
        data = self.real_video(self.converter(), "1280x720")
        replies = self.call({"action": "configure", "folders": [{**self.folder, "path": str(target)}]},
            self.begin(convertToGif=True), *self.chunks(data), {"action": "endSave"})
        self.assertTrue(all(item["ok"] for item in replies), replies)
        with Image.open(replies[-1]["path"]) as gif:
            self.assertEqual(gif.size, (720, 405)); self.assertGreater(gif.n_frames, 1)
        self.assertLess(len(replies[-1]["path"]), 260)
        self.assertEqual(len(list(target.iterdir())), 1)

    def test_stream_video_bytes_and_duplicate_preservation(self):
        self.configure()
        replies = self.call(self.begin(), *self.chunks(), {"action": "endSave"}, self.begin(), *self.chunks(), {"action": "endSave"})
        self.assertTrue(all(item["ok"] for item in replies), replies)
        first, second = replies[3], replies[7]
        self.assertEqual(Path(first["path"]).read_bytes(), MP4)
        self.assertEqual(Path(second["path"]).read_bytes(), MP4)
        self.assertEqual(second["filename"], "x_video (1).mp4")
        self.assertEqual(first["bytes"], len(MP4))
        self.assertEqual(len(list(self.destination.iterdir())), 2)

    def test_stream_aborted_on_eof_cancel_and_bad_sequence(self):
        self.configure()
        keep = self.destination / "keep.mp4"
        keep.write_bytes(MP4)
        for ending in [[], [{"action": "cancelSave"}], [{**self.chunks()[1], "sequence": 99}]]:
            with self.subTest(ending=ending):
                replies = self.call(self.begin(), self.chunks()[0], *ending)
                self.assertTrue(replies[0]["ok"], replies)
                self.assertEqual(list(self.destination.iterdir()), [keep])
                self.assertEqual(keep.read_bytes(), MP4)

    def test_stream_rejects_error_page_bad_names_and_chunk_size(self):
        self.configure()
        for filename in ["..\\escape.mp4", "CON.mp4", "C:\\outside.mp4"]:
            self.assertFalse(self.call(self.begin(filename=filename))[0]["ok"])
        for payload in [b"<html>error</html>", MP4[:24] + b"\0" * (256 * 1024)]:
            replies = self.call(self.begin(), {"action": "saveChunk", "sequence": 0, "base64": base64.b64encode(payload).decode("ascii")})
            self.assertFalse(replies[1]["ok"], replies)
        self.assertFalse(self.call(self.begin(folderId="unknown"))[0]["ok"])
        self.assertEqual(list(self.destination.iterdir()), [])

    def test_stream_empty_finish_and_recovery_after_error(self):
        self.configure()
        replies = self.call(self.begin(), {"action": "endSave"}, self.begin(), *self.chunks(), {"action": "endSave"})
        self.assertFalse(replies[1]["ok"])
        self.assertTrue(replies[-1]["ok"], replies)
        self.assertEqual(Path(replies[-1]["path"]).read_bytes(), MP4)

    def test_stream_larger_than_legacy_20mb_without_giant_messages(self):
        self.configure()
        data = MP4[:24] + b"\x06" * (21 * 1024 * 1024)
        requests = self.chunks(data)
        self.assertTrue(all(len(frame(request)) < 400000 for request in requests))
        replies = self.call(self.begin(), *requests, {"action": "endSave"})
        self.assertTrue(all(item["ok"] for item in replies), replies)
        self.assertEqual(Path(replies[-1]["path"]).read_bytes(), data)

    def test_stream_longest_allowed_directory_and_filename(self):
        target = self.destination / ("长" * (220 - len(str(self.destination)) - 1))
        target.mkdir()
        self.assertEqual(len(str(target)), 220)
        replies = self.call({"action": "configure", "folders": [{**self.folder, "path": str(target)}]}, self.begin(filename="x_" + "A" * 110 + ".mp4"), *self.chunks(), {"action": "endSave"})
        self.assertTrue(all(item["ok"] for item in replies), replies)
        self.assertEqual(Path(replies[-1]["path"]).read_bytes(), MP4)
        self.assertLess(len(replies[-1]["path"]), 260)

    def path_probe(self, path):
        probe = self.root / "RevealPathProbe.exe"
        if not probe.exists():
            compiler = Path(os.environ.get("SystemRoot", "C:\\Windows")) / "Microsoft.NET/Framework64/v4.0.30319/csc.exe"
            compiled = subprocess.run([str(compiler), "/nologo", "/target:exe", "/codepage:65001", "/out:" + str(probe), "/reference:" + str(self.exe), "/reference:System.Web.Extensions.dll", str(PACKAGE / "tests/RevealPathProbe.cs")], capture_output=True, timeout=20)
            self.assertEqual(compiled.returncode, 0, compiled.stdout.decode("utf-8", errors="replace"))
        result = subprocess.run([str(probe), str(path)], capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0)
        return json.loads(result.stdout.decode("utf-8-sig"))

    def test_reveal_resolves_chinese_file_and_missing_file_fallback(self):
        self.configure()
        saved = self.call(self.save_request(filename="收藏, 图片.png"))[0]
        self.assertTrue(saved["ok"], saved)
        location = self.path_probe(saved["path"])
        self.assertTrue(location["ok"], location)
        self.assertEqual(location["folderPath"], str(self.destination))
        self.assertTrue(location["selectFile"])
        Path(saved["path"]).unlink()
        fallback = self.path_probe(saved["path"])
        self.assertTrue(fallback["ok"], fallback)
        self.assertFalse(fallback["selectFile"])
        self.assertEqual(fallback["folderPath"], str(self.destination))

    def test_reveal_protocol_rejects_outside_path_devices_and_commands(self):
        self.configure()
        for path in ["https://example.org/a.png", "C:\\unconfigured\\a.png", "relative.png", "\\\\?\\C:\\example.png", "\\\\.\\C:\\example.png", str(self.destination / "run.exe"), str(self.destination / "bad:stream.png"), str(self.destination / "child" / "picture.png")]:
            with self.subTest(path=path):
                reply = self.call({"action": "revealSaved", "path": path})[0]
                self.assertFalse(reply["ok"], reply)

    def test_reveal_removed_or_unavailable_directory_does_not_open(self):
        self.configure()
        saved = self.call(self.save_request())[0]
        # Simulate a later configuration edit; this test covers reveal validation, not config replacement.
        (self.root / "folders.json").write_text("[]", encoding="utf-8")
        rejected = self.call({"action": "revealSaved", "path": saved["path"]})[0]
        self.assertFalse(rejected["ok"])
        self.assertIn("移除或更改", rejected["error"])
        (self.root / "folders.json").write_text(json.dumps([self.folder], ensure_ascii=False), encoding="utf-8")
        Path(saved["path"]).unlink()
        self.destination.rmdir()
        rejected = self.call({"action": "revealSaved", "path": saved["path"]})[0]
        self.assertFalse(rejected["ok"])
        self.assertIn("不存在或当前无法访问", rejected["error"])

if __name__ == "__main__":
    unittest.main(verbosity=2)
