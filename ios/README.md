# iOS 客户端

这是 SwiftUI 原生加入者端的工程源文件，最低支持 iOS 17。它已实现 `shengjian://join#MB1…` 深链接接收、旧邀请粘贴和严格解析。

在 Mac 上安装 XcodeGen 后，于本目录执行 `xcodegen generate`，再用 Xcode 打开生成的工程。

当前还需在 Mac/Xcode 上完成并验证：

- 用 `URLSessionWebSocketTask` + CryptoKit 移植 MB1 挑战认证、HKDF 和 AES-256-GCM 消息层。
- 用 `WKWebView` 加载选中网页，同步 HTML5 媒体的播放、暂停和进度。
- 配置签名、实机媒体策略测试和 App Store 所需的隐私说明。
- 拥有 HTTPS 域名后增加 Associated Domains 和 `apple-app-site-association`，将自定义协议升级为 Universal Link。

