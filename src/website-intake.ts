import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type WebsiteScanRequest = {
  website?: string;
  business_name?: string;
  location?: string;
};

export type WebsiteScanPage = {
  url: string;
  title: string;
  chars: number;
};

export type WebsiteScanProfile = {
  business_name?: string;
  business_tagline?: string;
  business_phone?: string;
  business_website?: string;
  business_address?: string;
  business_hours?: string;
};

export type WebsiteScanFact = {
  label: string;
  value: string;
  sourceUrl: string;
  evidence: string;
  confidence: number;
};

export type WebsiteScanResult = {
  ok: true;
  resolvedWebsite: string;
  candidateWebsites: string[];
  pages: WebsiteScanPage[];
  suggestedProfile: WebsiteScanProfile;
  facts: WebsiteScanFact[];
  knowledgeTitle: string;
  knowledgeContent: string;
  warnings: string[];
};

export type WebsiteScanOptions = {
  allowPrivateHosts?: boolean;
  serperApiKey?: string;
  braveApiKey?: string;
  timeoutMs?: number;
  maxBytesPerPage?: number;
  maxPages?: number;
};

type HtmlPage = WebsiteScanPage & {
  finalUrl: string;
  text: string;
  metaDescription: string;
  links: string[];
};

type SearchCandidate = {
  url: string;
  title: string;
};

type SerperResponse = {
  organic?: { link?: string; title?: string }[];
};

type BraveResponse = {
  web?: { results?: { url?: string; title?: string }[] };
};

type DuckDuckGoTopic = {
  FirstURL?: string;
  Text?: string;
  Topics?: DuckDuckGoTopic[];
};

type DuckDuckGoResponse = {
  AbstractURL?: string;
  Heading?: string;
  RelatedTopics?: DuckDuckGoTopic[];
};

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES_PER_PAGE = 600_000;
const DEFAULT_MAX_PAGES = 5;
const PAGE_HINT = /(about|service|services|contact|faq|pricing|price|hours|location|locations|booking|schedule)/i;
const NON_HTML_EXTENSION = /\.(?:pdf|zip|png|jpe?g|gif|webp|svg|mp4|mp3|mov|avi|docx?|xlsx?|pptx?)(?:$|\?)/i;
const DIRECTORY_HOSTS = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "yelp.com",
  "angi.com",
  "homeadvisor.com",
  "bbb.org",
  "thumbtack.com",
  "yellowpages.com",
  "mapquest.com",
  "google.com",
  "bing.com",
];

const STATE_ABBREVIATIONS = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY",
  "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV",
  "WI", "WY", "DC",
]);

const cleanText = (value: string): string => value.replace(/\s+/g, " ").trim();

const truncate = (value: string, maxLength: number): string => {
  const cleaned = cleanText(value);
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1).trim()}...`;
};

const decodeHtmlEntities = (value: string): string => {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
    ndash: "-",
    mdash: "-",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) {
      const codePoint = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (key.startsWith("#")) {
      const codePoint = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return named[key] ?? match;
  });
};

const normalizeWebsiteInput = (raw: string): URL => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a website URL or business name/location.");
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error("Website URL is invalid.");
  }
  parsed.hash = "";
  return parsed;
};

const isLocalHostname = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "localhost.localdomain";
};

export const isPrivateIp = (ipAddress: string): boolean => {
  const version = isIP(ipAddress);
  if (version === 4) {
    const parts = ipAddress.split(".").map((part) => Number.parseInt(part, 10));
    const [a, b] = parts;
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    if (a === 0 || a === 10 || a === 127 || a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const normalized = ipAddress.toLowerCase();
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  }
  return true;
};

export async function assertSafeWebsiteUrl(raw: string, options: WebsiteScanOptions = {}): Promise<URL> {
  const parsed = normalizeWebsiteInput(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Website scan only supports http and https URLs.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Website URL must not include credentials.");
  }

  if (options.allowPrivateHosts) return parsed;

  const hostname = parsed.hostname;
  if (isLocalHostname(hostname)) {
    throw new Error("Website scan cannot access localhost or private network addresses.");
  }
  if (isIP(hostname) && isPrivateIp(hostname)) {
    throw new Error("Website scan cannot access localhost or private network addresses.");
  }

  const records = await lookup(hostname, { all: true, verbatim: false }).catch(() => []);
  if (records.length === 0) {
    throw new Error("Website hostname could not be resolved.");
  }
  const unsafeRecord = records.find((record) => isPrivateIp(record.address));
  if (unsafeRecord) {
    throw new Error("Website scan cannot access localhost or private network addresses.");
  }
  return parsed;
}

const readCappedBody = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    if (!next.value) continue;
    totalBytes += next.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("Website page is too large to scan safely.");
    }
    chunks.push(next.value);
  }

  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
};

const extractTagContent = (html: string, tagName: string): string => {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = html.match(regex);
  return match ? cleanText(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " "))) : "";
};

const extractMetaDescription = (html: string): string => {
  const match = html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i);
  return match ? truncate(decodeHtmlEntities(match[1]), 320) : "";
};

const extractLinks = (html: string, baseUrl: string): string[] => {
  const links = new Set<string>();
  const matches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi);
  for (const match of matches) {
    const rawHref = decodeHtmlEntities(match[1]).trim();
    if (!rawHref || rawHref.startsWith("mailto:") || rawHref.startsWith("tel:") || rawHref.startsWith("javascript:")) continue;
    try {
      const parsed = new URL(rawHref, baseUrl);
      parsed.hash = "";
      links.add(parsed.toString());
    } catch {
      continue;
    }
  }
  return Array.from(links);
};

const htmlToText = (html: string): string => {
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:br|p|div|li|h[1-6]|tr|section|article|header|footer|nav)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(withoutNoise)
    .split(/\r?\n/)
    .map(cleanText)
    .filter((line) => line.length > 0)
    .join("\n")
    .slice(0, 80_000);
};

const fetchHtmlPage = async (rawUrl: string, options: WebsiteScanOptions): Promise<HtmlPage> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytesPerPage ?? DEFAULT_MAX_BYTES_PER_PAGE;
  let current = await assertSafeWebsiteUrl(rawUrl, options);
  const visited = new Set<string>();

  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    if (visited.has(current.toString())) throw new Error("Website redirect loop detected.");
    visited.add(current.toString());
    const response = await fetch(current.toString(), {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "User-Agent": "SMIRK Website Intake/1.0",
      },
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Website redirect did not include a location.");
      current = await assertSafeWebsiteUrl(new URL(location, current).toString(), options);
      continue;
    }

    if (!response.ok) {
      throw new Error(`Website returned HTTP ${response.status}.`);
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml")) {
      throw new Error("Website page is not HTML.");
    }

    const html = await readCappedBody(response, maxBytes);
    const text = htmlToText(html);
    return {
      url: current.toString(),
      finalUrl: current.toString(),
      title: truncate(extractTagContent(html, "title") || current.hostname, 140),
      chars: text.length,
      text,
      metaDescription: extractMetaDescription(html),
      links: extractLinks(html, current.toString()),
    };
  }

  throw new Error("Website redirected too many times.");
};

const isDirectoryHost = (urlValue: string): boolean => {
  try {
    const hostname = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
    return DIRECTORY_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return true;
  }
};

const flattenDuckDuckGoTopics = (topics: DuckDuckGoTopic[] | undefined): DuckDuckGoTopic[] => {
  if (!topics) return [];
  const flattened: DuckDuckGoTopic[] = [];
  for (const topic of topics) {
    flattened.push(topic);
    flattened.push(...flattenDuckDuckGoTopics(topic.Topics));
  }
  return flattened;
};

const findCandidateWebsites = async (request: WebsiteScanRequest, options: WebsiteScanOptions): Promise<SearchCandidate[]> => {
  const businessName = cleanText(request.business_name || "");
  const location = cleanText(request.location || "");
  if (!businessName && !location) return [];
  const query = `${businessName} ${location} official website`.trim();
  const candidates: SearchCandidate[] = [];

  if (options.serperApiKey) {
    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { "X-API-KEY": options.serperApiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: 6 }),
    });
    if (response.ok) {
      const data = await response.json() as SerperResponse;
      for (const item of data.organic || []) {
        if (item.link) candidates.push({ url: item.link, title: item.title || item.link });
      }
    }
  } else if (options.braveApiKey) {
    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: { "Accept": "application/json", "X-Subscription-Token": options.braveApiKey },
    });
    if (response.ok) {
      const data = await response.json() as BraveResponse;
      for (const item of data.web?.results || []) {
        if (item.url) candidates.push({ url: item.url, title: item.title || item.url });
      }
    }
  } else {
    const response = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    if (response.ok) {
      const data = await response.json() as DuckDuckGoResponse;
      if (data.AbstractURL) candidates.push({ url: data.AbstractURL, title: data.Heading || data.AbstractURL });
      for (const topic of flattenDuckDuckGoTopics(data.RelatedTopics).slice(0, 8)) {
        if (topic.FirstURL) candidates.push({ url: topic.FirstURL, title: topic.Text || topic.FirstURL });
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!/^https?:\/\//i.test(candidate.url)) return false;
    if (isDirectoryHost(candidate.url)) return false;
    const normalized = candidate.url.replace(/\/+$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 5);
};

const resolveWebsite = async (request: WebsiteScanRequest, options: WebsiteScanOptions): Promise<{ resolvedWebsite: string; candidateWebsites: string[]; warnings: string[] }> => {
  const warnings: string[] = [];
  const directWebsite = cleanText(request.website || "");
  if (directWebsite) {
    const safe = await assertSafeWebsiteUrl(directWebsite, options);
    return { resolvedWebsite: safe.toString(), candidateWebsites: [], warnings };
  }

  const candidates = await findCandidateWebsites(request, options);
  const candidateWebsites = candidates.map((candidate) => candidate.url);
  for (const candidate of candidates) {
    try {
      const safe = await assertSafeWebsiteUrl(candidate.url, options);
      return { resolvedWebsite: safe.toString(), candidateWebsites, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : "candidate rejected";
      warnings.push(`Skipped candidate ${candidate.url}: ${message}`);
    }
  }

  throw new Error("No safe official website candidate found. Enter the website URL directly.");
};

const selectLikelyPages = (homepage: HtmlPage, options: WebsiteScanOptions): string[] => {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? DEFAULT_MAX_PAGES, DEFAULT_MAX_PAGES));
  const homepageUrl = new URL(homepage.finalUrl);
  const selected: string[] = [];
  for (const link of homepage.links) {
    if (selected.length >= maxPages - 1) break;
    try {
      const parsed = new URL(link);
      if (parsed.origin !== homepageUrl.origin) continue;
      if (parsed.pathname === homepageUrl.pathname) continue;
      if (NON_HTML_EXTENSION.test(parsed.pathname)) continue;
      if (!PAGE_HINT.test(`${parsed.pathname} ${parsed.search}`)) continue;
      const normalized = parsed.toString();
      if (!selected.includes(normalized)) selected.push(normalized);
    } catch {
      continue;
    }
  }
  return selected;
};

const splitSentences = (text: string): string[] => {
  const normalized = text.replace(/\n+/g, ". ");
  const matches = normalized.match(/[^.!?]{24,260}[.!?]?/g) || [];
  return matches.map(cleanText).filter((sentence) => sentence.length > 20);
};

const findSentence = (pages: HtmlPage[], pattern: RegExp): { sentence: string; sourceUrl: string } | null => {
  for (const page of pages) {
    const sentence = splitSentences(page.text).find((candidate) => pattern.test(candidate));
    if (sentence) return { sentence, sourceUrl: page.finalUrl };
  }
  return null;
};

const extractPhone = (text: string): string | undefined => {
  const match = text.match(/(?:\+?1[\s.-]?)?(?:\(?[2-9]\d{2}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  return match ? cleanText(match[0]) : undefined;
};

const extractAddress = (pages: HtmlPage[]): string | undefined => {
  for (const page of pages) {
    const lines = page.text.split(/\n+/).map(cleanText).filter((line) => line.length >= 12 && line.length <= 180);
    for (const line of lines) {
      const hasStateZip = Array.from(STATE_ABBREVIATIONS).some((state) => new RegExp(`\\b${state}\\b\\s*\\d{5}(?:-\\d{4})?`).test(line));
      const hasStreet = /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|court|ct\.?|way|suite|ste\.?)\b/i.test(line);
      if (hasStateZip && hasStreet) return line;
    }
  }
  return undefined;
};

const extractHours = (pages: HtmlPage[]): string | undefined => {
  const match = findSentence(pages, /\b(?:hours|mon|tue|wed|thu|fri|sat|sun|open|closed|24\/7|24 hours)\b/i);
  return match ? truncate(match.sentence, 220) : undefined;
};

const extractProfile = (request: WebsiteScanRequest, resolvedWebsite: string, pages: HtmlPage[]): WebsiteScanProfile => {
  const homepage = pages[0];
  const titleName = homepage?.title.split(/\s[|-]\s/)[0]?.trim();
  const metaDescription = homepage?.metaDescription || "";
  const combinedText = pages.map((page) => page.text).join("\n");
  const phone = extractPhone(combinedText);
  const address = extractAddress(pages);
  const hours = extractHours(pages);
  const profile: WebsiteScanProfile = {
    business_website: resolvedWebsite,
  };

  const requestedName = cleanText(request.business_name || "");
  if (requestedName) profile.business_name = requestedName;
  else if (titleName && titleName.length >= 2) profile.business_name = truncate(titleName, 120);

  if (metaDescription && metaDescription !== profile.business_name) profile.business_tagline = truncate(metaDescription, 180);
  if (phone) profile.business_phone = phone;
  if (address) profile.business_address = address;
  if (hours) profile.business_hours = hours;
  return profile;
};

const addFact = (facts: WebsiteScanFact[], fact: WebsiteScanFact): void => {
  const key = `${fact.label}:${fact.value}`.toLowerCase();
  if (facts.some((existing) => `${existing.label}:${existing.value}`.toLowerCase() === key)) return;
  facts.push({
    ...fact,
    value: truncate(fact.value, 260),
    evidence: truncate(fact.evidence, 220),
    confidence: Math.max(0.5, Math.min(0.95, fact.confidence)),
  });
};

const extractFacts = (pages: HtmlPage[], profile: WebsiteScanProfile): WebsiteScanFact[] => {
  const facts: WebsiteScanFact[] = [];
  const definitions: { label: string; pattern: RegExp; confidence: number }[] = [
    { label: "Services", pattern: /\b(?:services|repair|installation|maintenance|replacement|inspection|estimate)\b/i, confidence: 0.78 },
    { label: "Service area", pattern: /\b(?:serving|service area|serves|locally owned|nearby|surrounding areas)\b/i, confidence: 0.78 },
    { label: "Booking", pattern: /\b(?:book|schedule|appointment|request a quote|call today|contact us)\b/i, confidence: 0.76 },
    { label: "Escalation", pattern: /\b(?:emergency|urgent|24\/7|after hours|same day|immediate)\b/i, confidence: 0.8 },
    { label: "Policy", pattern: /\b(?:warranty|guarantee|licensed|insured|bonded|privacy|cancellation)\b/i, confidence: 0.74 },
    { label: "Pricing", pattern: /\b(?:price|pricing|starts at|starting at|free estimate|financing|payment)\b/i, confidence: 0.72 },
    { label: "FAQ", pattern: /\b(?:faq|frequently asked|questions|how long|what happens|do you offer)\b/i, confidence: 0.72 },
  ];

  if (profile.business_phone) {
    addFact(facts, {
      label: "Phone",
      value: profile.business_phone,
      sourceUrl: pages[0]?.finalUrl || profile.business_website || "",
      evidence: `Published phone number: ${profile.business_phone}`,
      confidence: 0.86,
    });
  }
  if (profile.business_hours) {
    addFact(facts, {
      label: "Hours",
      value: profile.business_hours,
      sourceUrl: pages[0]?.finalUrl || profile.business_website || "",
      evidence: profile.business_hours,
      confidence: 0.76,
    });
  }

  for (const definition of definitions) {
    const match = findSentence(pages, definition.pattern);
    if (!match) continue;
    addFact(facts, {
      label: definition.label,
      value: match.sentence,
      sourceUrl: match.sourceUrl,
      evidence: match.sentence,
      confidence: definition.confidence,
    });
  }

  return facts.slice(0, 14);
};

const hostnameForTitle = (urlValue: string): string => {
  try {
    return new URL(urlValue).hostname.replace(/^www\./, "");
  } catch {
    return "website";
  }
};

const buildKnowledgeContent = (
  resolvedWebsite: string,
  pages: HtmlPage[],
  profile: WebsiteScanProfile,
  facts: WebsiteScanFact[],
): string => {
  const profileLines = Object.entries(profile)
    .filter((entry): entry is [keyof WebsiteScanProfile, string] => Boolean(entry[1]))
    .map(([key, value]) => `- ${key}: ${value}`);
  const factLines = facts.map((fact) => [
    `- ${fact.label}: ${fact.value}`,
    `  Source: ${fact.sourceUrl}`,
    `  Evidence: ${fact.evidence}`,
    `  Confidence: ${fact.confidence.toFixed(2)}`,
  ].join("\n"));
  const pageLines = pages.map((page) => `- ${page.title || page.url} (${page.url}, ${page.chars} chars)`);

  return [
    `Website scan source: ${resolvedWebsite}`,
    "",
    "Pages scanned:",
    ...pageLines,
    "",
    "Suggested business profile fields:",
    ...(profileLines.length > 0 ? profileLines : ["- No profile fields extracted."]),
    "",
    "Source-linked business facts for Smirk:",
    ...(factLines.length > 0 ? factLines : ["- No facts extracted."]),
  ].join("\n");
};

export async function scanBusinessWebsite(request: WebsiteScanRequest, options: WebsiteScanOptions = {}): Promise<WebsiteScanResult> {
  const { resolvedWebsite, candidateWebsites, warnings } = await resolveWebsite(request, options);
  const homepage = await fetchHtmlPage(resolvedWebsite, options);
  const pageUrls = selectLikelyPages(homepage, options);
  const pages: HtmlPage[] = [homepage];

  for (const pageUrl of pageUrls) {
    try {
      pages.push(await fetchHtmlPage(pageUrl, options));
    } catch (error) {
      const message = error instanceof Error ? error.message : "scan failed";
      warnings.push(`Skipped ${pageUrl}: ${message}`);
    }
  }

  const suggestedProfile = extractProfile(request, homepage.finalUrl, pages);
  const facts = extractFacts(pages, suggestedProfile);
  const knowledgeTitle = `Website scan: ${hostnameForTitle(homepage.finalUrl)}`;
  const knowledgeContent = buildKnowledgeContent(homepage.finalUrl, pages, suggestedProfile, facts);

  return {
    ok: true,
    resolvedWebsite: homepage.finalUrl,
    candidateWebsites,
    pages: pages.map(({ url, title, chars }) => ({ url, title, chars })),
    suggestedProfile,
    facts,
    knowledgeTitle,
    knowledgeContent,
    warnings,
  };
}
