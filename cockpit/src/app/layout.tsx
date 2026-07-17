import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";
import { CoworkProviders } from "@/components/cowork/providers";
import { OfflineBanner } from "@/components/layout/offline-banner";
import { ErrorBoundary } from "@/components/layout/error-boundary";

// Reserved for a future i18n layer. `getRequestLocale` reads the request's
// Accept-Language, so it is intentionally NOT called from the root layout (which
// would opt the document shell into dynamic rendering); the app is English-only
// today and hard-codes lang="en". These helpers can be wired into a per-request
// segment or client component when i18n ships.
export async function getRequestLocale(): Promise<string> {
  const header = (await headers()).get("accept-language");
  if (!header) return "en";
  const first = header.split(",")[0]?.split(";")[0]?.trim();
  if (!first) return "en";
  if (!/^[a-zA-Z0-9-]{2,35}$/.test(first)) return "en";
  return first.toLowerCase();
}

export function localeToDir(locale: string): "ltr" | "rtl" {
  return /^(ar|he|fa|ur|yi|dv|ps|sd|ug|ks|pnb|bal|mzn|lrc|ckb|nqo|adlm)/.test(locale)
    ? "rtl"
    : "ltr";
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

const siteUrl = (() => {
  const raw = process.env.NEXT_PUBLIC_SITE_URL;
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      console.error(
        "NEXT_PUBLIC_SITE_URL is not set; metadata URLs will default to http://localhost:3000. Set it to your production origin.",
      );
    }
    return new URL("http://localhost:3000");
  }
  try {
    return new URL(raw);
  } catch {
    if (process.env.NODE_ENV === "production") {
      console.error(
        `NEXT_PUBLIC_SITE_URL is not a valid URL ("${raw}"); metadata URLs will default to http://localhost:3000.`,
      );
    }
    return new URL("http://localhost:3000");
  }
})();

export const metadata: Metadata = {
  metadataBase: siteUrl,
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

// Theme surfaced to native UI surfaces (form controls, scrollbars, color
// inputs) so they follow the cockpit's dark/light theme. Must live on the
// `viewport` export — putting `colorScheme`/`themeColor` on `metadata` is a
// no-op in the App Router.
export const viewport: Viewport = {
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F7F8FB" },
    { media: "(prefers-color-scheme: dark)", color: "#14161C" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <OfflineBanner />
          <CoworkProviders>
            <ErrorBoundary>{children}</ErrorBoundary>
          </CoworkProviders>
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
