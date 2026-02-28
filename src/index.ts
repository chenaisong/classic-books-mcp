import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ─── 语言映射 ───────────────────────────────────────────────────────────────
const LANG_MAP: Record<string, string> = {
	en: "English", zh: "Chinese", fr: "French", de: "German",
	es: "Spanish", pt: "Portuguese", ru: "Russian", ar: "Arabic",
	la: "Latin", el: "Greek", ja: "Japanese", ko: "Korean",
};

// ─── 缓存（Cloudflare Worker 内存级，生命周期内有效）──────────────────────
const cache = new Map<string, { data: any; ts: number }>();
function getCache(key: string, ttl = 300_000) {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.ts < ttl) return entry.data;
	return null;
}
function setCache(key: string, data: any) {
	cache.set(key, { data, ts: Date.now() });
}

// ─── 通用 fetch with timeout ─────────────────────────────────────────────────
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await fetch(url, { signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

// ─── 数据源适配器 ─────────────────────────────────────────────────────────────

// 1. Gutenberg (多语言)
async function searchGutenberg(query: string, lang = "en", limit = 5) {
	const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}&languages=${lang}&mime_type=text`;
	const res = await fetchWithTimeout(url);
	const data: any = await res.json();
	return (data.results || []).slice(0, limit).map((b: any) => ({
		source: "gutenberg",
		id: `gutenberg:${b.id}`,
		title: b.title,
		authors: b.authors.map((a: any) => a.name).join(", "),
		language: lang,
		download_count: b.download_count,
		cover_url: b.formats["image/jpeg"] || null,
		subjects: b.subjects?.slice(0, 5) || [],
	}));
}

// 2. Wikisource (多语言维基文库)
async function searchWikisource(query: string, lang = "en", limit = 5) {
	const base = `https://${lang}.wikisource.org/w/api.php`;
	const url = `${base}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=${limit}&format=json&origin=*`;
	const res = await fetchWithTimeout(url);
	const data: any = await res.json();
	return (data.query?.search || []).map((p: any) => ({
		source: "wikisource",
		id: `wikisource:${lang}:${p.pageid}`,
		title: p.title,
		language: lang,
		snippet: p.snippet?.replace(/<[^>]+>/g, "") || "",
		cover_url: null,
	}));
}

// 3. OpenLibrary 书目搜索
async function searchOpenLibrary(query: string, limit = 5) {
	const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=key,title,author_name,first_publish_year,subject,language,cover_i`;
	const res = await fetchWithTimeout(url);
	const data: any = await res.json();
	return (data.docs || []).map((b: any) => ({
		source: "openlibrary",
		id: `openlibrary:${b.key}`,
		title: b.title,
		authors: (b.author_name || []).join(", "),
		year: b.first_publish_year || null,
		languages: b.language || [],
		cover_url: b.cover_i ? `https://covers.openlibrary.org/b/id/${b.cover_i}-M.jpg` : null,
		subjects: (b.subject || []).slice(0, 5),
	}));
}

// 4. Sacred Texts (宗教原典目录，静态结构)
const SACRED_TEXTS_CATALOG: Record<string, { title: string; url: string; tradition: string }[]> = {
	bible: [
		{ title: "King James Bible (1611)", url: "https://sacred-texts.com/bib/kjb/index.htm", tradition: "Christianity" },
		{ title: "Latin Vulgate", url: "https://sacred-texts.com/bib/vul/index.htm", tradition: "Christianity" },
	],
	quran: [
		{ title: "The Holy Quran (Pickthall)", url: "https://sacred-texts.com/isl/pick/index.htm", tradition: "Islam" },
		{ title: "Quran (Rodwell)", url: "https://sacred-texts.com/isl/qr/index.htm", tradition: "Islam" },
	],
	buddhism: [
		{ title: "Dhammapada", url: "https://sacred-texts.com/bud/dhp/index.htm", tradition: "Buddhism" },
		{ title: "The Tibetan Book of the Dead", url: "https://sacred-texts.com/bud/bardo/index.htm", tradition: "Buddhism" },
		{ title: "Diamond Sutra", url: "https://sacred-texts.com/bud/Diamond_Sutra.htm", tradition: "Buddhism" },
	],
	hinduism: [
		{ title: "Rigveda", url: "https://sacred-texts.com/hin/rigveda/index.htm", tradition: "Hinduism" },
		{ title: "Bhagavad Gita", url: "https://sacred-texts.com/hin/gita/index.htm", tradition: "Hinduism" },
		{ title: "Upanishads", url: "https://sacred-texts.com/hin/upan/index.htm", tradition: "Hinduism" },
	],
	taoism: [
		{ title: "Tao Te Ching", url: "https://sacred-texts.com/tao/taote.htm", tradition: "Taoism" },
		{ title: "Zhuangzi", url: "https://sacred-texts.com/tao/sbe39/index.htm", tradition: "Taoism" },
	],
	confucianism: [
		{ title: "The Analects", url: "https://sacred-texts.com/cfu/conf1.htm", tradition: "Confucianism" },
		{ title: "The Great Learning", url: "https://sacred-texts.com/cfu/conf3.htm", tradition: "Confucianism" },
	],
	greek: [
		{ title: "The Iliad (Homer)", url: "https://sacred-texts.com/cla/homer/ili/index.htm", tradition: "Greek Classical" },
		{ title: "The Odyssey (Homer)", url: "https://sacred-texts.com/cla/homer/ody/index.htm", tradition: "Greek Classical" },
	],
};

function searchSacredTexts(query: string) {
	const q = query.toLowerCase();
	const results: any[] = [];
	for (const [category, texts] of Object.entries(SACRED_TEXTS_CATALOG)) {
		for (const text of texts) {
			if (
				text.title.toLowerCase().includes(q) ||
				text.tradition.toLowerCase().includes(q) ||
				category.includes(q)
			) {
				results.push({ source: "sacred_texts", id: `sacred:${category}:${text.title}`, ...text, category });
			}
		}
	}
	return results;
}

// 5. LibriVox 有声书
async function searchLibriVox(query: string, limit = 5) {
	const url = `https://librivox.org/api/feed/audiobooks/?title=${encodeURIComponent(query)}&format=json&limit=${limit}`;
	const res = await fetchWithTimeout(url);
	const data: any = await res.json();
	return (data.books || []).map((b: any) => ({
		source: "librivox",
		id: `librivox:${b.id}`,
		title: b.title,
		authors: (b.authors || []).map((a: any) => `${a.first_name} ${a.last_name}`.trim()).join(", "),
		language: b.language,
		totaltime: b.totaltime,
		url_librivox: b.url_librivox,
		url_rss: b.url_rss,
		url_zip_file: b.url_zip_file,
	}));
}

// ─── 章节提取（健壮版）──────────────────────────────────────────────────────
function extractChapter(text: string, chapterNum: number) {
	// 多种章节标记正则
	const patterns = [
		/^(CHAPTER\s+[IVXLCDM\d]+[^\n]*)/im,
		/^(Chapter\s+\d+[^\n]*)/im,
		/^(BOOK\s+[IVXLCDM\d]+[^\n]*)/im,
		/^(PART\s+[IVXLCDM\d]+[^\n]*)/im,
		/^([IVX]{1,5}\.\s+[A-Z][^\n]{0,60})/m,
	];

	let dividers: number[] = [];
	for (const pattern of patterns) {
		const regex = new RegExp(pattern.source, "gim");
		let match;
		while ((match = regex.exec(text)) !== null) {
			dividers.push(match.index);
		}
		if (dividers.length > 1) break;
	}

	dividers = [...new Set(dividers)].sort((a, b) => a - b);
	const total = dividers.length || 1;

	if (dividers.length === 0) {
		// 无章节标记，按字数切割
		const words = text.split(/\s+/);
		const chunkSize = Math.ceil(words.length / 20);
		const start = (chapterNum - 1) * chunkSize;
		return {
			total: 20,
			title: `Section ${chapterNum}`,
			content: words.slice(start, start + chunkSize).join(" ").slice(0, 15000),
		};
	}

	const idx = Math.min(chapterNum - 1, dividers.length - 1);
	const start = dividers[idx];
	const end = dividers[idx + 1] || text.length;
	const raw = text.slice(start, end);
	const firstLine = raw.split("\n")[0].trim();

	return {
		total,
		title: firstLine,
		content: raw.slice(0, 15000), // 限制返回长度
	};
}

// ─── MCP Server ───────────────────────────────────────────────────────────────
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Classic Books & Sacred Texts",
		version: "2.0.0",
	});

	async init() {
		// ── 工具1: 统一多源搜索 ──────────────────────────────────────────────────
		this.server.tool(
			"search_books",
			"Search for classic books, religious texts, and literature across multiple sources (Gutenberg, Wikisource, OpenLibrary, Sacred Texts). Supports multilingual search.",
			{
				query: z.string().describe("Book title, author, or topic"),
				language: z.string().default("en").describe(`Language code: ${Object.entries(LANG_MAP).map(([k, v]) => `${k}(${v})`).join(", ")}`),
				sources: z.array(z.enum(["gutenberg", "wikisource", "openlibrary", "sacred_texts"])).default(["gutenberg", "openlibrary", "sacred_texts"]).describe("Data sources to search"),
				limit: z.number().default(5).describe("Max results per source"),
			},
			async ({ query, language, sources, limit }) => {
				const cacheKey = `search:${query}:${language}:${sources.join(",")}`;
				const cached = getCache(cacheKey);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

				const tasks = await Promise.allSettled([
					sources.includes("gutenberg") ? searchGutenberg(query, language, limit) : Promise.resolve([]),
					sources.includes("wikisource") ? searchWikisource(query, language, limit) : Promise.resolve([]),
					sources.includes("openlibrary") ? searchOpenLibrary(query, limit) : Promise.resolve([]),
					sources.includes("sacred_texts") ? Promise.resolve(searchSacredTexts(query)) : Promise.resolve([]),
				]);

				const results = tasks.flatMap(t => t.status === "fulfilled" ? t.value : []);
				const response = { query, language, total: results.length, results };
				setCache(cacheKey, response);
				return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
			}
		);

		// ── 工具2: 获取章节内容（支持多源）─────────────────────────────────────
		this.server.tool(
			"get_chapter",
			"Get chapter content from a book. Supports Gutenberg books (id: 'gutenberg:1234') and Wikisource pages (id: 'wikisource:en:12345').",
			{
				book_id: z.string().describe("Book ID from search_books result (e.g. 'gutenberg:1342' or 'wikisource:en:12345')"),
				chapter: z.number().default(1).describe("Chapter number, starting from 1"),
			},
			async ({ book_id, chapter }) => {
				const cacheKey = `chapter:${book_id}:${chapter}`;
				const cached = getCache(cacheKey, 600_000);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

				const [source, ...rest] = book_id.split(":");

				if (source === "gutenberg") {
					const id = rest[0];
					const metaRes = await fetchWithTimeout(`https://gutendex.com/books/${id}`);
					if (!metaRes.ok) return { content: [{ type: "text", text: "Book not found" }] };
					const meta: any = await metaRes.json();
					const textUrl = meta.formats["text/plain; charset=utf-8"] || meta.formats["text/plain"];
					if (!textUrl) return { content: [{ type: "text", text: "No plain text available" }] };
					const fullText = await (await fetchWithTimeout(textUrl)).text();
					const chapterData = extractChapter(fullText, chapter);
					const result = {
						source: "gutenberg", id, title: meta.title,
						authors: meta.authors.map((a: any) => a.name).join(", "),
						chapter, ...chapterData,
						word_count: chapterData.content.split(/\s+/).length,
					};
					setCache(cacheKey, result);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				}

				if (source === "wikisource") {
					const [lang, pageid] = rest;
					const url = `https://${lang}.wikisource.org/w/api.php?action=query&pageids=${pageid}&prop=revisions&rvprop=content&rvslots=main&format=json&origin=*`;
					const res = await fetchWithTimeout(url);
					const data: any = await res.json();
					const page = Object.values(data.query?.pages || {})[0] as any;
					const wikitext = page?.revisions?.[0]?.slots?.main?.["*"] || "";
					const clean = wikitext.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2").replace(/\{\{[^}]+\}\}/g, "").replace(/==([^=]+)==/g, "\n\n$1\n").slice(0, 15000);
					const result = { source: "wikisource", lang, pageid, title: page.title, content: clean, chapter };
					setCache(cacheKey, result);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				}

				return { content: [{ type: "text", text: `Unsupported source: ${source}` }] };
			}
		);

		// ── 工具3: 宗教文本浏览 ──────────────────────────────────────────────────
		this.server.tool(
			"browse_religious_texts",
			"Browse religious and philosophical classics catalog. Returns available texts by tradition.",
			{
				tradition: z.enum(["all", "bible", "quran", "buddhism", "hinduism", "taoism", "confucianism", "greek"]).default("all").describe("Religious or philosophical tradition"),
			},
			async ({ tradition }) => {
				const catalog = tradition === "all"
					? SACRED_TEXTS_CATALOG
					: { [tradition]: SACRED_TEXTS_CATALOG[tradition] || [] };
				return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
			}
		);

		// ── 工具4: 有声书搜索 ────────────────────────────────────────────────────
		this.server.tool(
			"search_audiobooks",
			"Search for free audiobooks from LibriVox",
			{
				query: z.string().describe("Book title or author"),
				limit: z.number().default(5),
			},
			async ({ query, limit }) => {
				const audiobooks = await searchLibriVox(query, limit);
				if (!audiobooks.length) return { content: [{ type: "text", text: `No audiobooks found for: ${query}` }] };
				return { content: [{ type: "text", text: JSON.stringify({ audiobooks }, null, 2) }] };
			}
		);

		// ── 工具5: 书籍推荐（按主题/传统）───────────────────────────────────────
		this.server.tool(
			"recommend_classics",
			"Get curated recommendations of classic books by theme, tradition, or era",
			{
				theme: z.string().describe("Theme like: philosophy, love, war, religion, science, political, tragedy, comedy"),
				language: z.string().default("en").describe("Preferred language code"),
				limit: z.number().default(8),
			},
			async ({ theme, language, limit }) => {
				const query = `${theme} classic literature`;
				const [gutenbergResults, openLibResults] = await Promise.allSettled([
					searchGutenberg(query, language, limit),
					searchOpenLibrary(query, limit),
				]);
				const results = [
					...(gutenbergResults.status === "fulfilled" ? gutenbergResults.value : []),
					...(openLibResults.status === "fulfilled" ? openLibResults.value : []),
				].slice(0, limit);

				return { content: [{ type: "text", text: JSON.stringify({ theme, language, recommendations: results }, null, 2) }] };
			}
		);
	}
}

export default MyMCP.serve("/mcp");