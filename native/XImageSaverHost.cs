using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace XImageSaver {
    public class Folder {
        public string id { get; set; }
        public string name { get; set; }
        public string path { get; set; }
    }

    public static class Program {
        private const int MaxImageBytes = 20 * 1024 * 1024;
        private const int MaxMessageBytes = 30 * 1024 * 1024;
        private const int MaxChunkBytes = 256 * 1024;
        private const long MaxVideoBytes = 512L * 1024 * 1024;
        private const long MaxGifBytes = 256L * 1024 * 1024;
        private sealed class Upload {
            public Folder Folder;
            public string Filename;
            public string Temporary;
            public FileStream File;
            public long Bytes;
            public int Sequence;
            public bool ConvertToGif;
            public string PaletteTemporary;
            public string GifTemporary;
        }
        private static Upload ActiveUpload;
        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer {
            MaxJsonLength = 32 * 1024 * 1024, RecursionLimit = 30
        };
        private static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
        private static readonly string ConfigPath = Path.Combine(Root, "folders.json");
        private static readonly string FfmpegPath = Path.Combine(Root, "ffmpeg", "ffmpeg.exe");

        [STAThread]
        public static void Main(string[] args) {
            Stream input = Console.OpenStandardInput();
            Stream output = Console.OpenStandardOutput();
            try {
                string manifestPath = Path.Combine(Root, "com.local.x_image_saver.json");
                Dictionary<string, object> manifest = Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(manifestPath));
                ArrayList origins = manifest["allowed_origins"] as ArrayList;
                if (args.Length == 0 || origins == null || !origins.Cast<object>().Any(x => (string)x == args[0]))
                    throw new InvalidOperationException("调用来源未获授权。");
                while (true) {
                    byte[] header = ReadExact(input, 4, true);
                    if (header == null) break;
                    uint length = BitConverter.ToUInt32(header, 0);
                    if (length == 0 || length > MaxMessageBytes) throw new InvalidOperationException("消息大小超出限制。");
                    string text = Encoding.UTF8.GetString(ReadExact(input, (int)length, false));
                    try {
                        Dictionary<string, object> request = Json.Deserialize<Dictionary<string, object>>(text);
                        WriteMessage(output, Handle(request));
                    } catch (Exception error) {
                        WriteMessage(output, new { ok = false, error = FriendlyError(error) });
                    }
                }
            } catch (Exception error) {
                try { WriteMessage(output, new { ok = false, error = FriendlyError(error) }); }
                catch { /* A closed Chrome pipe is a normal way to exit. */ }
            } finally {
                CancelUpload();
            }
        }

        private static byte[] ReadExact(Stream input, int count, bool allowEof) {
            byte[] data = new byte[count];
            int offset = 0;
            while (offset < count) {
                int read = input.Read(data, offset, count - offset);
                if (read == 0) {
                    if (allowEof && offset == 0) return null;
                    throw new EndOfStreamException("消息传输中断。");
                }
                offset += read;
            }
            return data;
        }

        private static void WriteMessage(Stream output, object response) {
            byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(response));
            if (data.Length > 1024 * 1024) throw new InvalidOperationException("响应过大。");
            byte[] header = BitConverter.GetBytes((uint)data.Length);
            output.Write(header, 0, header.Length);
            output.Write(data, 0, data.Length);
            output.Flush();
        }

        private static string Value(Dictionary<string, object> request, string key) {
            object value;
            return request.TryGetValue(key, out value) && value is string ? (string)value : "";
        }

        private static object Handle(Dictionary<string, object> request) {
            string action = Value(request, "action");
            if (action == "ping") return new { ok = true, version = "1.2.0", streamingVideo = true, revealSaved = true, gifConversion = File.Exists(FfmpegPath), folders = LoadFolders() };
            if (action == "configure") {
                object payload;
                if (!request.TryGetValue("folders", out payload)) throw new InvalidOperationException("缺少文件夹设置。");
                List<Folder> folders = Json.Deserialize<List<Folder>>(Json.Serialize(payload));
                ValidateFolders(folders);
                string temporary = ConfigPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try {
                    File.WriteAllText(temporary, Json.Serialize(folders), new UTF8Encoding(false));
                    if (File.Exists(ConfigPath)) File.Replace(temporary, ConfigPath, null);
                    else File.Move(temporary, ConfigPath);
                } finally { if (File.Exists(temporary)) File.Delete(temporary); }
                return new { ok = true, folders = folders };
            }
            if (action == "pickDirectory") {
                Application.EnableVisualStyles();
                using (FolderBrowserDialog dialog = new FolderBrowserDialog())
                using (Form owner = new Form()) {
                    dialog.Description = "选择图片、动图和视频保存目录";
                    dialog.ShowNewFolderButton = true;
                    string initial = Value(request, "initialPath");
                    if (Directory.Exists(initial)) dialog.SelectedPath = initial;
                    owner.ShowInTaskbar = false;
                    owner.TopMost = true;
                    owner.StartPosition = FormStartPosition.CenterScreen;
                    owner.Size = new System.Drawing.Size(1, 1);
                    owner.Opacity = 0;
                    owner.Show();
                    DialogResult result = dialog.ShowDialog(owner);
                    return new { ok = true, cancelled = result != DialogResult.OK, path = result == DialogResult.OK ? dialog.SelectedPath : "" };
                }
            }
            if (action == "save") return SaveImage(request);
            if (action == "revealSaved") return RevealSaved(Value(request, "path"));
            if (action == "beginSave") return BeginUpload(request);
            if (action == "saveChunk" || action == "endSave") {
                try { return action == "saveChunk" ? WriteChunk(request) : FinishUpload(); }
                catch { CancelUpload(); throw; }
            }
            if (action == "cancelSave") { CancelUpload(); return new { ok = true }; }
            throw new InvalidOperationException("无法识别的操作。");
        }

        private static List<Folder> LoadFolders() {
            if (!File.Exists(ConfigPath)) return new List<Folder>();
            List<Folder> folders = Json.Deserialize<List<Folder>>(File.ReadAllText(ConfigPath, Encoding.UTF8));
            // Do not require disks to be online just to show the saved configuration.
            ValidateFolders(folders, false);
            return folders;
        }

        private static void ValidateFolders(List<Folder> folders, bool checkExists = true) {
            if (folders == null || folders.Count > 20) throw new InvalidOperationException("最多可以设置 20 个目录。");
            HashSet<string> ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (Folder folder in folders) {
                Guid id;
                if (folder == null || !Guid.TryParseExact(folder.id, "D", out id) || !ids.Add(folder.id))
                    throw new InvalidOperationException("文件夹编号无效或重复。");
                folder.name = (folder.name ?? "").Trim();
                folder.path = (folder.path ?? "").Trim();
                if (folder.name.Length == 0 || folder.name.Length > 40 || folder.name.Any(Char.IsControl))
                    throw new InvalidOperationException("目录名称需要 1–40 个字，且不能包含控制字符。");
                if (!Regex.IsMatch(folder.path, @"^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)") ||
                    folder.path.StartsWith(@"\\?\") || folder.path.StartsWith(@"\\.\") || folder.path.Length > 220)
                    throw new InvalidOperationException("请输入完整的 Windows 文件夹路径。");
                folder.path = Path.GetFullPath(folder.path);
                if (checkExists && !Directory.Exists(folder.path))
                    throw new InvalidOperationException("目录不存在或暂不可访问：" + folder.path);
            }
        }

        private static object SaveImage(Dictionary<string, object> request) {
            string folderId = Value(request, "folderId");
            Folder folder = LoadFolders().FirstOrDefault(item => item.id == folderId);
            if (folder == null) throw new InvalidOperationException("这个目录尚未配置，请重新保存设置。");
            if (!Directory.Exists(folder.path)) throw new InvalidOperationException("保存目录不存在或当前无法访问。");
            string filename = Value(request, "filename");
            if (filename.Length == 0 || filename.Length > 120 || filename != Path.GetFileName(filename) ||
                filename.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || filename.EndsWith(".") || filename.EndsWith(" ") ||
                Regex.IsMatch(filename, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("图片文件名无效。");
            string encoded = Value(request, "base64");
            if (encoded.Length > ((MaxImageBytes + 2) / 3) * 4) throw new InvalidOperationException("图片超过 20 MB。");
            byte[] bytes = Convert.FromBase64String(encoded);
            if (bytes.Length == 0 || bytes.Length > MaxImageBytes) throw new InvalidOperationException("图片为空或超过 20 MB。");
            string extension = DetectFormat(bytes);
            if (extension == null) throw new InvalidOperationException("内容不是支持的图片格式。");
            string stem = Path.GetFileNameWithoutExtension(filename);
            if (String.IsNullOrWhiteSpace(stem)) throw new InvalidOperationException("图片文件名无效。");
            for (int number = 0; number < 10000; number++) {
                string suffix = (number == 0 ? "" : " (" + number + ")") + "." + extension;
                // .NET Framework uses the legacy 260-character Windows path limit.
                int available = 259 - folder.path.TrimEnd('\\').Length - 1 - suffix.Length;
                if (available < 1) throw new InvalidOperationException("保存目录路径过长，请选择更短的目录。");
                string chosen = stem.Substring(0, Math.Min(stem.Length, available)) + suffix;
                string target = Path.Combine(folder.path, chosen);
                FileStream file;
                try { file = new FileStream(target, FileMode.CreateNew, FileAccess.Write, FileShare.None); }
                catch (IOException) { if (File.Exists(target) || Directory.Exists(target)) continue; throw; }
                try {
                    using (file) { file.Write(bytes, 0, bytes.Length); file.Flush(true); }
                } catch {
                    try { File.Delete(target); } catch { }
                    throw;
                }
                return new { ok = true, filename = chosen, path = target, bytes = bytes.Length };
            }
            throw new InvalidOperationException("同名文件过多，请调整保存目录。");
        }

        private static bool At(byte[] bytes, int start, string text) {
            if (start + text.Length > bytes.Length) return false;
            for (int i = 0; i < text.Length; i++) if (bytes[start + i] != (byte)text[i]) return false;
            return true;
        }

        private sealed class SavedLocation {
            public string Path;
            public string FolderPath;
            public bool SelectFile;
        }

        private static SavedLocation ResolveSavedLocation(string path) {
            if (String.IsNullOrWhiteSpace(path) || path.Length > 259 || path.Any(Char.IsControl) ||
                !Regex.IsMatch(path, @"^(?:[a-zA-Z]:\\|\\\\[^\\]+\\[^\\]+)") ||
                path.StartsWith(@"\\?\") || path.StartsWith(@"\\.\"))
                throw new InvalidOperationException("保存文件的路径无效。");
            string filename = System.IO.Path.GetFileName(path);
            if (filename.Length == 0 || filename.EndsWith(".") || filename.EndsWith(" ") ||
                filename.IndexOfAny(System.IO.Path.GetInvalidFileNameChars()) >= 0 ||
                !Regex.IsMatch(filename, @"\.(jpg|jpeg|png|webp|gif|avif|mp4)$", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("保存文件的名称或格式无效。");
            string fullPath = System.IO.Path.GetFullPath(path);
            string parent = System.IO.Path.GetDirectoryName(fullPath);
            if (!LoadFolders().Any(folder => String.Equals(folder.path.TrimEnd('\\'), parent.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("原保存目录已移除或更改，无法通过这条通知打开。请在最近保存中查看原路径。");
            if (!Directory.Exists(parent)) throw new InvalidOperationException("保存目录不存在或当前无法访问。");
            return new SavedLocation { Path = fullPath, FolderPath = parent, SelectFile = File.Exists(fullPath) };
        }

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr reserved, uint flags);
        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SHParseDisplayName(string name, IntPtr bindingContext, out IntPtr itemIdList, uint attributes, out uint attributesOut);
        [DllImport("shell32.dll")]
        private static extern int SHOpenFolderAndSelectItems(IntPtr itemIdList, uint count, IntPtr items, uint flags);

        private static object RevealSaved(string path) {
            SavedLocation location = ResolveSavedLocation(path);
            if (!location.SelectFile) {
                // The user asked to open this directory; never execute the media file itself.
                Process.Start(new ProcessStartInfo { FileName = location.FolderPath, Verb = "open", UseShellExecute = true });
                return new { ok = true, selectedFile = false, path = location.FolderPath };
            }
            int initialized = CoInitializeEx(IntPtr.Zero, 2); // COINIT_APARTMENTTHREADED
            Marshal.ThrowExceptionForHR(initialized);
            IntPtr itemIdList = IntPtr.Zero;
            try {
                uint attributes;
                Marshal.ThrowExceptionForHR(SHParseDisplayName(location.Path, IntPtr.Zero, out itemIdList, 0, out attributes));
                // count=0 selects this item in its parent folder, without a command-line path.
                Marshal.ThrowExceptionForHR(SHOpenFolderAndSelectItems(itemIdList, 0, IntPtr.Zero, 0));
                return new { ok = true, selectedFile = true, path = location.FolderPath };
            } finally {
                if (itemIdList != IntPtr.Zero) Marshal.FreeCoTaskMem(itemIdList);
                CoUninitialize();
            }
        }

        private static void CancelUpload() {
            Upload upload = ActiveUpload;
            ActiveUpload = null;
            if (upload == null) return;
            try { if (upload.File != null) upload.File.Dispose(); } catch { }
            foreach (string temporary in new[] { upload.Temporary, upload.PaletteTemporary, upload.GifTemporary }) {
                try { if (!String.IsNullOrEmpty(temporary) && File.Exists(temporary)) File.Delete(temporary); } catch { }
            }
        }

        private static object BeginUpload(Dictionary<string, object> request) {
            if (ActiveUpload != null) throw new InvalidOperationException("上一项视频保存还没有结束。");
            Folder folder = LoadFolders().FirstOrDefault(item => item.id == Value(request, "folderId"));
            if (folder == null || !Directory.Exists(folder.path)) throw new InvalidOperationException("保存目录未配置或当前无法访问。");
            string filename = Value(request, "filename");
            if (filename.Length == 0 || filename.Length > 120 || filename != Path.GetFileName(filename) ||
                filename.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || filename.EndsWith(".") || filename.EndsWith(" ") ||
                String.IsNullOrWhiteSpace(Path.GetFileNameWithoutExtension(filename)) ||
                Regex.IsMatch(filename, @"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", RegexOptions.IgnoreCase))
                throw new InvalidOperationException("视频文件名无效。");
            object convert;
            bool convertToGif = request.TryGetValue("convertToGif", out convert) && convert is bool && (bool)convert;
            if (convertToGif && !File.Exists(FfmpegPath)) throw new InvalidOperationException("GIF 转码工具尚未安装，请运行新版 install.cmd。");
            string temporary = Path.Combine(folder.path, ".xs-" + Guid.NewGuid().ToString("N") + ".p");
            FileStream file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            ActiveUpload = new Upload { Folder = folder, Filename = filename, Temporary = temporary, File = file, ConvertToGif = convertToGif };
            return new { ok = true };
        }

        private static object WriteChunk(Dictionary<string, object> request) {
            Upload upload = ActiveUpload;
            if (upload == null) throw new InvalidOperationException("视频保存尚未开始。");
            object sequence;
            if (!request.TryGetValue("sequence", out sequence) || !(sequence is int) || (int)sequence != upload.Sequence)
                throw new InvalidOperationException("视频分块顺序错误。");
            string encoded = Value(request, "base64");
            if (encoded.Length == 0 || encoded.Length > ((MaxChunkBytes + 2) / 3) * 4)
                throw new InvalidOperationException("视频分块大小无效。");
            byte[] bytes = Convert.FromBase64String(encoded);
            if (bytes.Length == 0 || bytes.Length > MaxChunkBytes || upload.Bytes + bytes.Length > MaxVideoBytes)
                throw new InvalidOperationException("视频为空、分块过大或超过 512 MB。");
            if (upload.Sequence == 0 && !IsMp4(bytes)) throw new InvalidOperationException("内容不是支持的 MP4 视频。");
            upload.File.Write(bytes, 0, bytes.Length);
            upload.Bytes += bytes.Length;
            upload.Sequence++;
            return new { ok = true, bytes = upload.Bytes };
        }

        private static object FinishUpload() {
            Upload upload = ActiveUpload;
            if (upload == null || upload.Bytes == 0) throw new InvalidOperationException("视频数据为空。");
            upload.File.Flush(true);
            upload.File.Dispose();
            upload.File = null;
            string output = upload.Temporary;
            string extension = "mp4";
            if (upload.ConvertToGif) {
                ConvertGif(upload);
                output = upload.GifTemporary;
                extension = "gif";
            }
            long savedBytes = new FileInfo(output).Length;
            string stem = Path.GetFileNameWithoutExtension(upload.Filename);
            for (int number = 0; number < 10000; number++) {
                string suffix = (number == 0 ? "" : " (" + number + ")") + "." + extension;
                int available = 259 - upload.Folder.path.TrimEnd('\\').Length - 1 - suffix.Length;
                if (available < 1) throw new InvalidOperationException("保存目录路径过长。");
                string chosen = stem.Substring(0, Math.Min(stem.Length, available)) + suffix;
                string target = Path.Combine(upload.Folder.path, chosen);
                // Rename only after a successful transfer. File.Move never replaces a prior file.
                try { File.Move(output, target); }
                catch (IOException) { if (File.Exists(target) || Directory.Exists(target)) continue; throw; }
                CancelUpload();
                return new { ok = true, filename = chosen, path = target, bytes = savedBytes, convertedGif = upload.ConvertToGif };
            }
            throw new InvalidOperationException("同名文件过多，请调整保存目录。");
        }

        private static string ReserveTemporary(Folder folder, string prefix) {
            string path = Path.Combine(folder.path, prefix + Guid.NewGuid().ToString("N") + ".p");
            using (new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            return path;
        }

        private static string Quote(string value) {
            // These are generated local filenames or fixed filters, never a shell command.
            if (value.IndexOf('"') >= 0) throw new InvalidOperationException("转码参数无效。");
            return "\"" + value + "\"";
        }

        private static void RunFfmpeg(string arguments, string output, DateTime deadline) {
            var errors = new StringBuilder();
            var start = new ProcessStartInfo {
                FileName = FfmpegPath, Arguments = arguments, UseShellExecute = false,
                CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardErrorEncoding = Encoding.UTF8, WorkingDirectory = Root
            };
            using (var process = new Process { StartInfo = start }) {
                process.ErrorDataReceived += (sender, args) => {
                    if (args.Data == null) return;
                    lock (errors) { if (errors.Length < 4096) errors.AppendLine(args.Data); }
                };
                process.OutputDataReceived += (sender, args) => { }; // Never contaminate native stdout.
                try {
                    if (!process.Start()) throw new InvalidOperationException("无法启动 GIF 转码工具。");
                    process.BeginErrorReadLine();
                    process.BeginOutputReadLine();
                    while (!process.WaitForExit(200)) {
                        if (DateTime.UtcNow > deadline) throw new InvalidOperationException("GIF 转换超过 5 分钟，请在设置中关闭动图转 GIF 后保存 MP4。");
                        if (File.Exists(output) && new FileInfo(output).Length > MaxGifBytes)
                            throw new InvalidOperationException("生成的 GIF 超过 256 MB，请在设置中关闭动图转 GIF 后保存 MP4。");
                    }
                    process.WaitForExit(); // Drain redirected output before inspecting the exit code.
                    if (process.ExitCode != 0) throw new InvalidOperationException("GIF 转换失败，请重新保存或在设置中关闭动图转 GIF。" );
                    if (!File.Exists(output) || new FileInfo(output).Length > MaxGifBytes)
                        throw new InvalidOperationException("GIF 输出缺失或超过 256 MB。");
                } catch (System.ComponentModel.Win32Exception) {
                    throw new InvalidOperationException("无法启动 GIF 转码工具，请重新运行新版 install.cmd 并检查系统提示。");
                } finally {
                    try { if (!process.HasExited) { process.Kill(); process.WaitForExit(5000); } } catch { }
                }
            }
        }

        private static void ConvertGif(Upload upload) {
            if (!File.Exists(FfmpegPath)) throw new InvalidOperationException("GIF 转码工具尚未安装，请运行新版 install.cmd。");
            upload.PaletteTemporary = ReserveTemporary(upload.Folder, ".xp-");
            upload.GifTemporary = ReserveTemporary(upload.Folder, ".xg-");
            DateTime deadline = DateTime.UtcNow.AddMinutes(5);
            string scaled = "fps=15,scale=w='min(720,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:flags=lanczos";
            string common = "-hide_banner -loglevel error -nostdin -y -threads 2 -filter_threads 1 -filter_complex_threads 1 ";
            string input = "-protocol_whitelist file,pipe -f mp4 -i " + Quote(upload.Temporary) + " ";
            // Two passes avoid retaining every decoded frame while building a global palette.
            RunFfmpeg(common + input + "-map 0:v:0 -an -sn -dn -vf " + Quote(scaled + ",palettegen=stats_mode=diff") +
                " -frames:v 1 -f image2 -c:v png -update 1 " + Quote(upload.PaletteTemporary), upload.PaletteTemporary, deadline);
            string graph = "[0:v]" + scaled + "[v];[v][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle[out]";
            RunFfmpeg(common + input + "-protocol_whitelist file,pipe -i " + Quote(upload.PaletteTemporary) +
                " -filter_complex " + Quote(graph) + " -map " + Quote("[out]") + " -an -sn -dn -loop 0 -f gif " + Quote(upload.GifTemporary), upload.GifTemporary, deadline);
            using (var gif = new FileStream(upload.GifTemporary, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                byte[] header = new byte[6];
                if (gif.Read(header, 0, header.Length) != header.Length || (!At(header, 0, "GIF87a") && !At(header, 0, "GIF89a")))
                    throw new InvalidOperationException("转码工具没有生成有效的 GIF。");
                gif.Position = gif.Length - 1;
                if (gif.ReadByte() != 0x3B) throw new InvalidOperationException("GIF 转换未完整结束，请重新保存。");
            }
        }

        private static bool IsMp4(byte[] bytes) {
            if (bytes.Length < 16 || !At(bytes, 4, "ftyp")) return false;
            uint size = ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) | ((uint)bytes[2] << 8) | bytes[3];
            if (size < 16 || size > 4096) return false;
            string[] brands = { "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "MSNV" };
            for (int offset = 8; offset + 4 <= Math.Min((long)size, bytes.Length); offset += 4) {
                if (offset == 12) continue;
                if (brands.Any(brand => At(bytes, offset, brand))) return true;
            }
            return false;
        }

        private static string DetectFormat(byte[] b) {
            byte[] png = {137,80,78,71,13,10,26,10};
            if (b.Length >= 8 && png.Select((n, i) => b[i] == n).All(x => x)) return "png";
            if (b.Length >= 3 && b[0] == 255 && b[1] == 216 && b[2] == 255) return "jpg";
            if (At(b, 0, "GIF87a") || At(b, 0, "GIF89a")) return "gif";
            if (b.Length >= 12 && At(b, 0, "RIFF") && At(b, 8, "WEBP")) return "webp";
            if (b.Length >= 16 && At(b, 4, "ftyp") && (At(b, 8, "avif") || At(b, 8, "avis"))) return "avif";
            return null;
        }

        private static string FriendlyError(Exception error) {
            if (error is COMException || error is System.ComponentModel.Win32Exception) return "Windows 未能打开文件夹，请在设置页查看文件位置。";
            if (error is UnauthorizedAccessException) return "没有权限写入这个目录，请选择自己可写的文件夹。";
            if (error is FormatException) return "媒体数据格式错误，请重新下载。";
            if (error is IOException) return "文件操作失败：" + error.Message;
            return error.Message;
        }
    }
}
