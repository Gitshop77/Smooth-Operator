const TEXT_ENCODER = new TextEncoder();
const HEX_LOOKUP: string[] = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(text));
  const bytes = new Uint8Array(buf);
  return Array.from(bytes, (b) => HEX_LOOKUP[b]).join("");
}

export class PageFingerprint {
  constructor(
    public readonly url: string,
    public readonly elementCount: number,
    public readonly textHash: string,
  ) {}

  static async fromBrowserState(
    url: string,
    domText: string,
    elementCount: number,
  ): Promise<PageFingerprint> {
    const fullHash = await sha256Hex(domText);
    return new PageFingerprint(url, elementCount, fullHash.slice(0, 16));
  }

  equals(other: PageFingerprint): boolean {
    return (
      this.url === other.url &&
      this.elementCount === other.elementCount &&
      this.textHash === other.textHash
    );
  }
}
