import type { Metadata } from "next";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import { CoworkProviders } from "@/components/cowork/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Cowork Cockpit",
  description:
    "Cowork Cockpit — a dashboard for persisted cowork data. Tabs, workspaces, agents, workflows, sessions, memory, security, MCP tools and more.",
  keywords: [
    "Cowork",
    "Agent Browser",
    "MCP",
    "Web Cockpit",
    "Next.js",
    "React",
  ],
  authors: [{ name: "Cowork" }],
  icons: {
    icon: "/logo.svg",
  },
  openGraph: {
    title: "Cowork Cockpit",
    description: "Dashboard for persisted cowork data",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cowork Cockpit",
    description: "Dashboard for persisted cowork data",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <CoworkProviders>{children}</CoworkProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
