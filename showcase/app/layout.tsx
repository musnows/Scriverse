import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const incomingHeaders = await headers();
  const host = incomingHeaders.get("x-forwarded-host") ?? incomingHeaders.get("host") ?? "localhost:3000";
  const protocol = incomingHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: "叙界 Scriverse · 长篇小说 AI 创作工作台",
    description: "让正文、人物、设定、时间线与 AI 协作汇聚在同一个可追溯的叙事系统。",
    icons: {
      icon: "/favicon.svg",
      shortcut: "/favicon.svg",
    },
    openGraph: {
      title: "叙界 Scriverse · 让宏大的故事有迹可循",
      description: "面向长篇小说创作的本地 AI 工作台。",
      type: "website",
      locale: "zh_CN",
      url: origin,
      images: [{ url: new URL("/og.png", origin).toString(), width: 1731, height: 909, alt: "叙界 Scriverse 产品介绍" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "叙界 Scriverse · 让宏大的故事有迹可循",
      description: "面向长篇小说创作的本地 AI 工作台。",
      images: [new URL("/og.png", origin).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
