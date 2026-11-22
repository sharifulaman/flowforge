import { defineApp, FatalError, objectSchema, type PolledItem } from '@flowforge/connector-sdk';
import { XMLParser } from 'fast-xml-parser';
import { createHash } from 'node:crypto';

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  summary: string;
  author: string | null;
  publishedAt: string | null;
  categories: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', trimValues: true, processEntities: true });
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => {
  if (v === undefined || v === null) return '';
  if (typeof v === 'object') return text((v as Record<string, unknown>)['#text'] ?? '');
  return String(v);
};
const iso = (v: unknown): string | null => {
  const t = Date.parse(text(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const strip = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2_000);

/** Parse RSS 2.0, RSS 1.0 (RDF) and Atom into a common shape, oldest first. */
export function parseFeed(xml: string): { title: string; items: FeedItem[] } {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new FatalError(`Not a valid RSS/Atom feed: ${(err as Error).message}`, 'INVALID_FEED');
  }
  const channel = doc.rss?.channel ?? doc['rdf:RDF']?.channel;
  const rawItems: Array<Record<string, any>> = doc.rss ? arr(channel?.item) : doc['rdf:RDF'] ? arr(doc['rdf:RDF'].item) : arr(doc.feed?.entry);
  if (!channel && !doc.feed) throw new FatalError('Not a valid RSS/Atom feed', 'INVALID_FEED');

  const items = rawItems.map((it): FeedItem => {
    const links = arr(it.link);
    const atomLink = links.find((l: any) => typeof l === 'object' && (l['@_rel'] ?? 'alternate') === 'alternate') ?? links[0];
    const link = typeof atomLink === 'object' ? String(atomLink['@_href'] ?? '') : text(atomLink);
    const title = text(it.title);
    const published = iso(it.pubDate ?? it.published ?? it.updated ?? it['dc:date']);
    const guid = text(it.guid ?? it.id);
    return {
      id: guid || link || createHash('sha256').update(`${title}|${published}`).digest('hex'),
      title,
      link,
      summary: strip(text(it.description ?? it.summary ?? it.content ?? it['content:encoded'])),
      author: text(it.author?.name ?? it.author ?? it['dc:creator']) || null,
      publishedAt: published,
      categories: arr(it.category).map((c: any) => (typeof c === 'object' ? String(c['@_term'] ?? c['#text'] ?? '') : String(c))).filter(Boolean),
    };
  });
  // Oldest first (feeds are usually newest first); undated items keep document order.
  items.sort((a, b) => (a.publishedAt && b.publishedAt ? a.publishedAt.localeCompare(b.publishedAt) : 0));
  if (items.every((i) => !i.publishedAt)) items.reverse();
  return { title: text(channel?.title ?? doc.feed?.title), items };
}

export default defineApp({
  key: 'rss',
  name: 'RSS',
  description: 'Watch RSS and Atom feeds for new items.',
  category: 'productivity',
  icon: 'Rss',
  color: '#f26522',
  auth: { type: 'none' },
  triggers: [
    {
      key: 'newItem',
      name: 'New item in feed',
      kind: 'polling',
      intervalSeconds: 300,
      description: 'Checks the feed every 5 minutes and fires once per new item.',
      input: objectSchema(
        { url: { type: 'string', title: 'Feed URL', format: 'uri', 'x-ui': { placeholder: 'https://blog.example.com/feed.xml', noTemplates: true } } },
        ['url'],
      ),
      sampleOutput: {
        id: 'https://blog.example.com/posts/hello',
        title: 'Hello world',
        link: 'https://blog.example.com/posts/hello',
        summary: 'Our first post…',
        author: 'Ada',
        publishedAt: '2026-01-01T09:00:00.000Z',
        categories: ['news'],
        feedTitle: 'Example Blog',
      },
      async poll({ input, http }): Promise<{ items: PolledItem[] }> {
        const res = await http.request<string>({ url: input.url, responseType: 'text', headers: { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8' } });
        const feed = parseFeed(res.data);
        return { items: feed.items.slice(-50).map((i) => ({ id: i.id, data: { ...i, feedTitle: feed.title } })) };
      },
    },
  ],
});
