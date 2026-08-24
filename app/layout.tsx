import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '声笺 · 网页音乐播放器',
  description: '把 Bilibili 视频和网络音频变成一个清爽的音乐播放器。',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
