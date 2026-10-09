# 媒体存档 · X Image Saver

在 X / Twitter 的图片、动图或视频画面上右键，选择预设目录，直接保存到 Windows 本机文件夹。

**[下载完整安装包](https://github.com/Hyougokita/x-image-saver/releases/latest)**

安装包位于 Releases 的 Assets 中，文件名为 `x-image-saver-v1.2.1.zip`，包含扩展、本机助手和 GIF 转码工具。仓库的源码 ZIP 用于开发，编译和准备转码工具后才能运行安装脚本。

## 功能

- 设置最多 20 个保存目录，支持中文路径和多个磁盘。
- 图片优先保存原图；同名文件自动加编号，保留已有文件。
- 自动识别可下载的 MP4 视频，并选择识别到的最高码率版本。
- X 动图默认转换为真正的循环 GIF：保留完整时长，15 帧/秒，最长边 720 像素。可以在设置里关闭转换，保留源 MP4。
- 在视频上右键可使用浏览器扩展菜单；Shift + 右键保留 X 的原菜单。
- 点击保存成功的系统通知，打开文件夹并选中对应文件。
- 本机助手按操作启动，任务完成后退出。各自的目录配置保存在各自电脑上。

## 安装

适用于 **64 位 Windows 10 / 11、桌面版 Chrome 123 或更新版本**。

1. 从 [Releases](https://github.com/Hyougokita/x-image-saver/releases/latest) 下载完整安装包，解压到固定位置。
2. 双击 `install.cmd` 安装本机助手。无需管理员权限，也无需安装 Python 或 Node.js。
3. 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」。
4. 选择解压目录内的 `extension` 文件夹，其中应有 `manifest.json`。
5. 点击扩展图标，确认「本机助手已连接」，添加自己的保存目录并保存设置。
6. 刷新已打开的 X 页面，在媒体画面上右键，选择「媒体存档 · 保存到」中的目录。

完整说明见 [使用说明.txt](使用说明.txt)。升级扩展后，需要重新加载扩展并刷新 X 页面；从 v1.2.0 升级到 v1.2.1 无需重装助手。

## 范围与限制

支持 `pbs.twimg.com` 的图片，以及有 `video.twimg.com` MP4 地址的动图和普通视频。直播、仅 HLS、DRM 和站外视频暂不支持。

图片最大 20 MB，源视频最大 512 MB，转码 GIF 最大 256 MB。GIF 转换最长等待 5 分钟。GIF 为 256 色，画质与原 MP4 有差异且没有声音；超限或转换失败会显示错误。

扩展使用 Manifest V3。页面脚本只发送媒体类型、封面、推文编号和视频地址，不发送 Cookie、登录凭据或推文正文。媒体下载由 Chrome 发起；GIF 转换使用本地文件。

## 从源码开发

需要 Windows、Node.js 22.8+、Python 3.11+；本机助手使用 Windows 自带 .NET Framework 的 C# 编译器。第三方转码工具的固定版本和 SHA-256 记录在 `native/ffmpeg/provenance.json`。

在仓库根目录依次执行：

```powershell
python scripts/prepare-ffmpeg.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1
node scripts/build-content.mjs
python -m pip install -r requirements-dev.txt
```

准备脚本从固定的 Gyan.dev 构建地址下载 FFmpeg，并校验原始压缩包和二进制的 SHA-256。已存在且校验正确的转码工具会直接复用。

验证与打包：

```powershell
node scripts/build-content.mjs --check
node --test --test-isolation=none tests/core.test.js tests/media.test.js tests/page.test.js tests/background.test.js
python tests/native_test.py
python tests/installer_test.py
python scripts/package-release.py
```

安装包生成在 `dist/`，打包采用明确的文件列表，不收录 `.git`、本机目录配置或下载媒体。运行上述构建和测试不会在系统上安装助手或写入注册表。

## 文件结构

| 位置 | 用途 |
| --- | --- |
| `extension/` | 可直接加载的 Chrome 扩展 |
| `extension/media-core.js` | 媒体地址校验、解析与选择逻辑 |
| `scripts/*-runtime.js` | 两个页面脚本的源码 |
| `scripts/build-content.mjs` | 生成各自包含解析函数的页面脚本 |
| `native/XImageSaverHost.cs` | Windows 本机助手源码 |
| `native/Install.ps1`、`native/Uninstall.ps1` | 当前用户范围的安装和卸载脚本 |
| `native/ffmpeg/` | 转码工具的许可、来源和版本信息 |
| `tests/` | 扩展、页面脚本、真实本机程序和安装校验测试 |

## 版本与验证

v1.2.1 修复页面脚本对全局 `XImageSaverMedia` 对象的启动依赖。每个执行环境加载一个完整脚本，后台采用显式模块导入；本机助手继续使用 v1.2.0。

该版已通过 44 项扩展/页面测试和 5 项安装校验。v1.2.0 本机助手已通过 21 项真实程序测试，包含多帧 GIF、循环播放、时长、重名保留、中文长路径及失败清理。登录后的 X 页面下载和 Windows 通知点击后的完整 UI 交互尚未自动实测；X 页面变动可能影响识别。

第三方 FFmpeg 构建的 GPL v3 许可、构建配置和源码链接见 [native/ffmpeg/来源与许可.txt](native/ffmpeg/来源与许可.txt) 与 [LICENSE](native/ffmpeg/LICENSE)。
