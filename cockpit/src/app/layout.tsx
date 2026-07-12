import type { Metadata } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import { CoworkProviders } from "@/components/cowork/providers";

// Negotiate the document language from the request's Accept-Language header so
// the <html lang> reflects the user's preferred locale (for screen readers /
// translation tooling) instead of being hard-coded to "en". The app is
// English-only today, but this keeps the attribute honest and ready for an i18n
// layer. Only a BCP-47-safe subset of characters is allowed.
async function getRequestLocale(): Promise<string> {
  const header = (await headers()).get("accept-language");
  if (!header) return "en";
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  if (!first) return "en";
 // Allow only letters, digits and hyphens; cap length.
  if (!/^[a-zA-Z0-9-]{2,35}$/.test(first)) return "en";
  return first.toLowerCase();
}

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
  title: "Open Cowork",
  description:
    "Open Cowork — a dashboard for persisted cowork data. Tabs, workspaces, agents, workflows, sessions, memory, security, MCP tools and more.",
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
    title: "Open Cowork",
    description: "Dashboard for persisted cowork data",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Open Cowork",
    description: "Dashboard for persisted cowork data",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getRequestLocale();
  return (
    <html lang={locale} suppressHydrationWarning>
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
