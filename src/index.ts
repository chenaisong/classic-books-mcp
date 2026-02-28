import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

// ─── 语言映射 ────────────────────────────────────────────────────────────────
const LANG_MAP: Record<string, string> = {
	en: "English", zh: "Chinese", fr: "French", de: "German",
	es: "Spanish", pt: "Portuguese", ru: "Russian", ar: "Arabic",
	la: "Latin", el: "Greek", ja: "Japanese", ko: "Korean",
};

// ─── 缓存（Worker 实例内存级）────────────────────────────────────────────────
const cache = new Map<string, { data: any; ts: number }>();
function getCache(key: string, ttl = 300_000) {
	const entry = cache.get(key);
	if (entry && Date.now() - entry.ts < ttl) return entry.data;
	return null;
}
function setCache(key: string, data: any) {
	cache.set(key, { data, ts: Date.now() });
}

// ─── 通用 fetch with timeout + headers ──────────────────────────────────────
async function fetchWithTimeout(
	url: string,
	ms = 8000,
	headers: Record<string, string> = {}
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), ms);
	try {
		return await fetch(url, { signal: controller.signal, headers });
	} finally {
		clearTimeout(timer);
	}
}

// ─── 安全 JSON 解析（防止 HTML 错误页导致崩溃）──────────────────────────────
async function safeJson(res: Response, sourceName: string): Promise<any> {
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return {
			error: `${sourceName} returned non-JSON response`,
			hint: "The API may be temporarily unavailable or blocking this request",
			preview: text.slice(0, 300),
		};
	}
}

// ─── 章节提取（健壮版）──────────────────────────────────────────────────────
function extractChapter(text: string, chapterNum: number) {
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
		while ((match = regex.exec(text)) !== null) dividers.push(match.index);
		if (dividers.length > 1) break;
	}

	dividers = [...new Set(dividers)].sort((a, b) => a - b);
	const total = dividers.length || 1;

	if (dividers.length === 0) {
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

	return {
		total,
		title: raw.split("\n")[0].trim(),
		content: raw.slice(0, 15000),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// 数据源适配器
// ════════════════════════════════════════════════════════════════════════════

// ─── Gutenberg（多语言）─────────────────────────────────────────────────────
async function searchGutenberg(query: string, lang = "en", limit = 5) {
	const url = `https://gutendex.com/books/?search=${encodeURIComponent(query)}&languages=${lang}&mime_type=text`;
	const res = await fetchWithTimeout(url);
	const data: any = await safeJson(res, "Gutenberg");
	if (data.error) return [data];
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

// ─── Wikisource（多语言维基文库）────────────────────────────────────────────
async function searchWikisource(query: string, lang = "en", limit = 5) {
	const url = `https://${lang}.wikisource.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=${limit}&format=json&origin=*`;
	const res = await fetchWithTimeout(url);
	const data: any = await safeJson(res, "Wikisource");
	if (data.error) return [data];
	return (data.query?.search || []).map((p: any) => ({
		source: "wikisource",
		id: `wikisource:${lang}:${p.pageid}`,
		title: p.title,
		language: lang,
		snippet: p.snippet?.replace(/<[^>]+>/g, "") || "",
	}));
}

// ─── OpenLibrary ─────────────────────────────────────────────────────────────
async function searchOpenLibrary(query: string, limit = 5) {
	const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}&fields=key,title,author_name,first_publish_year,subject,language,cover_i`;
	const res = await fetchWithTimeout(url);
	const data: any = await safeJson(res, "OpenLibrary");
	if (data.error) return [data];
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

// ─── LibriVox 有声书 ─────────────────────────────────────────────────────────
async function searchLibriVox(query: string, limit = 5) {
	const url = `https://librivox.org/api/feed/audiobooks/?title=${encodeURIComponent(query)}&format=json&limit=${limit}`;
	const res = await fetchWithTimeout(url);
	const data: any = await safeJson(res, "LibriVox");
	if (data.error) return [];
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

// ─── ctext.org 中国哲学书电子化计划 ─────────────────────────────────────────
const CTEXT_HEADERS = {
	"User-Agent": "Mozilla/5.0 (compatible; ClassicBooksMCP/3.0)",
	"Accept": "application/json",
};

async function searchCtext(query: string) {
	const url = `https://ctext.org/api.pl?if=en&op=searchtexts&text=${encodeURIComponent(query)}&format=json`;
	const res = await fetchWithTimeout(url, 8000, CTEXT_HEADERS);
	const data: any = await safeJson(res, "ctext.org");
	if (data.error) return [data];
	return (data.results || []).map((r: any) => ({
		source: "ctext",
		id: `ctext:${r.urn}`,
		title: r.title,
		urn: r.urn,
		description: r.description || "",
	}));
}

async function getCtextChapter(urn: string) {
	const url = `https://ctext.org/api.pl?if=en&op=gettext&urn=${encodeURIComponent(urn)}&format=json`;
	const res = await fetchWithTimeout(url, 8000, CTEXT_HEADERS);
	return safeJson(res, "ctext.org");
}

// ─── 今日诗词 ────────────────────────────────────────────────────────────────
async function getDailyPoem() {
	const res = await fetchWithTimeout("https://v1.jinrishici.com/all.json");
	return safeJson(res, "jinrishici");
}

// ─── 青空文庫（Aozora Bunko）────────────────────────────────────────────────
async function searchAozora(query: string, limit = 5) {
	const url = `https://pubapi.aozorahack.org/books?title=${encodeURIComponent(query)}`;
	const res = await fetchWithTimeout(url);
	const data: any = await safeJson(res, "Aozora Bunko");
	if (data.error) return [data];
	return (Array.isArray(data) ? data : []).slice(0, limit).map((b: any) => ({
		source: "aozora",
		id: `aozora:${b.book_id}`,
		title: b.title,
		authors: b.authors?.map((a: any) => `${a.last_name}${a.first_name}`).join(", ") || "",
		language: "ja",
		card_url: b.card_url,
	}));
}

async function getAozoraText(book_id: string) {
	const res = await fetchWithTimeout(`https://pubapi.aozorahack.org/book/${book_id}`);
	const meta: any = await safeJson(res, "Aozora Bunko");
	if (meta.error || !meta.text_url) return null;
	const textRes = await fetchWithTimeout(meta.text_url);
	const buffer = await textRes.arrayBuffer();
	const decoder = new TextDecoder("shift-jis");
	return { meta, text: decoder.decode(buffer) };
}

// ─── Sacred Texts 搜索 ───────────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// 静态目录数据
// ════════════════════════════════════════════════════════════════════════════

// ─── 宗教文本目录 ────────────────────────────────────────────────────────────
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

// ─── 中国古籍目录 ─────────────────────────────────────────────────────────────
const CHINESE_CLASSICS_CATALOG: Record<string, { title: string; urn: string; dynasty: string; genre: string }[]> = {
	philosophy: [
		{ title: "论语", urn: "ctp:analects", dynasty: "春秋", genre: "儒家" },
		{ title: "道德经", urn: "ctp:dao-de-jing", dynasty: "春秋", genre: "道家" },
		{ title: "庄子", urn: "ctp:zhuangzi", dynasty: "战国", genre: "道家" },
		{ title: "孟子", urn: "ctp:mengzi", dynasty: "战国", genre: "儒家" },
		{ title: "荀子", urn: "ctp:xunzi", dynasty: "战国", genre: "儒家" },
		{ title: "韩非子", urn: "ctp:hanfeizi", dynasty: "战国", genre: "法家" },
		{ title: "墨子", urn: "ctp:mozi", dynasty: "战国", genre: "墨家" },
		{ title: "孙子兵法", urn: "ctp:sunzi", dynasty: "春秋", genre: "兵家" },
	],
	history: [
		{ title: "史记", urn: "ctp:shiji", dynasty: "西汉", genre: "纪传体史书" },
		{ title: "汉书", urn: "ctp:hanshu", dynasty: "东汉", genre: "纪传体史书" },
		{ title: "资治通鉴", urn: "ctp:zizhi-tongjian", dynasty: "北宋", genre: "编年体史书" },
	],
	poetry: [
		{ title: "诗经", urn: "ctp:shijing", dynasty: "西周至春秋", genre: "诗歌总集" },
		{ title: "楚辞", urn: "ctp:chuci", dynasty: "战国", genre: "楚辞" },
		{ title: "全唐诗（节选）", urn: "ctp:quantangshi", dynasty: "唐", genre: "唐诗" },
	],
	classics: [
		{ title: "易经", urn: "ctp:yijing", dynasty: "西周", genre: "经部" },
		{ title: "礼记", urn: "ctp:liji", dynasty: "西汉", genre: "经部" },
		{ title: "大学", urn: "ctp:daxue", dynasty: "先秦", genre: "儒家" },
		{ title: "中庸", urn: "ctp:zhongyong", dynasty: "先秦", genre: "儒家" },
	],
};

// ─── 日本名著目录（青空文庫 book_id）────────────────────────────────────────
const JAPANESE_CLASSICS_CATALOG: { title: string; author: string; book_id: number; era: string; genre: string }[] = [
	{ title: "源氏物語", author: "紫式部", book_id: 5162, era: "平安", genre: "物語" },
	{ title: "枕草子", author: "清少納言", book_id: 4383, era: "平安", genre: "随筆" },
	{ title: "竹取物語", author: "不詳", book_id: 4231, era: "平安", genre: "物語" },
	{ title: "伊勢物語", author: "不詳", book_id: 4073, era: "平安", genre: "歌物語" },
	{ title: "奥の細道", author: "松尾芭蕉", book_id: 2310, era: "江戸", genre: "俳諧紀行" },
	{ title: "吾輩は猫である", author: "夏目漱石", book_id: 789, era: "明治", genre: "小説" },
	{ title: "坊っちゃん", author: "夏目漱石", book_id: 790, era: "明治", genre: "小説" },
	{ title: "こころ", author: "夏目漱石", book_id: 773, era: "明治", genre: "小説" },
	{ title: "舞姫", author: "森鴎外", book_id: 684, era: "明治", genre: "小説" },
	{ title: "羅生門", author: "芥川龍之介", book_id: 127, era: "大正", genre: "短編小説" },
	{ title: "蜘蛛の糸", author: "芥川龍之介", book_id: 92, era: "大正", genre: "短編小説" },
	{ title: "鼻", author: "芥川龍之介", book_id: 130, era: "大正", genre: "短編小説" },
	{ title: "藪の中", author: "芥川龍之介", book_id: 177, era: "大正", genre: "短編小説" },
	{ title: "走れメロス", author: "太宰治", book_id: 1567, era: "昭和", genre: "短編小説" },
	{ title: "人間失格", author: "太宰治", book_id: 301, era: "昭和", genre: "小説" },
	{ title: "斜陽", author: "太宰治", book_id: 1569, era: "昭和", genre: "小説" },
	{ title: "伊豆の踊子", author: "川端康成", book_id: 249, era: "昭和", genre: "小説" },
	{ title: "檸檬", author: "梶井基次郎", book_id: 41, era: "昭和", genre: "短編小説" },
];

// ─── 韩国古典目录 ────────────────────────────────────────────────────────────
const KOREAN_CLASSICS_CATALOG: { title: string; title_ko: string; lang: string; era: string; description: string }[] = [
	{ title: "三国遗事 (삼국유사)", title_ko: "삼국유사", lang: "ko", era: "高丽 13世纪", description: "朝鲜半岛最古老的历史与神话集" },
	{ title: "三国史记 (삼국사기)", title_ko: "삼국사기", lang: "ko", era: "高丽 12世纪", description: "朝鲜最古老的官修正史" },
	{ title: "春香传 (춘향전)", title_ko: "춘향전", lang: "ko", era: "朝鲜 18世纪", description: "最具代表性的朝鲜古典爱情小说" },
	{ title: "洪吉童传 (홍길동전)", title_ko: "홍길동전", lang: "ko", era: "朝鲜 17世纪", description: "第一部用韩文写成的小说" },
	{ title: "九云梦 (구운몽)", title_ko: "구운몽", lang: "ko", era: "朝鲜 17世纪", description: "朝鲜古典浪漫主义小说" },
	{ title: "沈清传 (심청전)", title_ko: "심청전", lang: "ko", era: "朝鲜时代", description: "以孝道为主题的朝鲜古典故事" },
	{ title: "兴夫传 (흥부전)", title_ko: "흥부전", lang: "ko", era: "朝鲜时代", description: "善恶有报的朝鲜民间故事" },
	{ title: "龟兔传 (토끼전)", title_ko: "토끼전", lang: "ko", era: "朝鲜时代", description: "朝鲜寓言故事，来自佛典本生谭" },
];

// ════════════════════════════════════════════════════════════════════════════
// MCP Server
// ════════════════════════════════════════════════════════════════════════════
export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Classic Books & Sacred Texts",
		version: "3.1.0",
	});

	async init() {

		// ── 工具1：统一多源搜索 ───────────────────────────────────────────────────
		this.server.tool(
			"search_books",
			"Search for classic books, religious texts, and literature across multiple sources (Gutenberg, Wikisource, OpenLibrary, Sacred Texts). Default language is English.",
			{
				query: z.string().describe("Book title, author, or topic"),
				language: z.string().default("en").describe(
					`Language code, default is English (en). Options: ${Object.entries(LANG_MAP).map(([k, v]) => `${k}(${v})`).join(", ")}`
				),
				sources: z.array(z.enum(["gutenberg", "wikisource", "openlibrary", "sacred_texts"]))
					.default(["gutenberg", "openlibrary", "sacred_texts"])
					.describe("Data sources to search"),
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

		// ── 工具2：获取书籍章节（Gutenberg / Wikisource）─────────────────────────
		this.server.tool(
			"get_chapter",
			"Get chapter content from a book. Supports Gutenberg (id: 'gutenberg:1342') and Wikisource (id: 'wikisource:en:12345'). Use search_books to find IDs.",
			{
				book_id: z.string().describe("Book ID from search_books, e.g. 'gutenberg:1342' or 'wikisource:zh:12345'"),
				chapter: z.number().default(1).describe("Chapter number starting from 1"),
			},
			async ({ book_id, chapter }) => {
				const cacheKey = `chapter:${book_id}:${chapter}`;
				const cached = getCache(cacheKey, 600_000);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

				const [source, ...rest] = book_id.split(":");

				if (source === "gutenberg") {
					const id = rest[0];
					const metaRes = await fetchWithTimeout(`https://gutendex.com/books/${id}`);
					const meta: any = await safeJson(metaRes, "Gutenberg");
					if (meta.error) return { content: [{ type: "text", text: JSON.stringify(meta) }] };
					const textUrl = meta.formats["text/plain; charset=utf-8"] || meta.formats["text/plain"];
					if (!textUrl) return { content: [{ type: "text", text: "No plain text available for this book" }] };
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
					const data: any = await safeJson(res, "Wikisource");
					if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
					const page = Object.values(data.query?.pages || {})[0] as any;
					const wikitext = page?.revisions?.[0]?.slots?.main?.["*"] || "";
					const clean = wikitext
						.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, "$2")
						.replace(/\{\{[^}]+\}\}/g, "")
						.replace(/==([^=]+)==/g, "\n\n$1\n")
						.slice(0, 15000);
					const result = { source: "wikisource", lang, pageid, title: page.title, content: clean, chapter };
					setCache(cacheKey, result);
					return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
				}

				return { content: [{ type: "text", text: `Unsupported source: ${source}. Use search_books to get valid IDs.` }] };
			}
		);

		// ── 工具3：宗教文本目录浏览 ──────────────────────────────────────────────
		this.server.tool(
			"browse_religious_texts",
			"Browse religious and philosophical classics catalog. Returns available texts by tradition.",
			{
				tradition: z.enum(["all", "bible", "quran", "buddhism", "hinduism", "taoism", "confucianism", "greek"])
					.default("all")
					.describe("Religious or philosophical tradition"),
			},
			async ({ tradition }) => {
				const catalog = tradition === "all"
					? SACRED_TEXTS_CATALOG
					: { [tradition]: SACRED_TEXTS_CATALOG[tradition] || [] };
				return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
			}
		);

		// ── 工具4：有声书搜索 ────────────────────────────────────────────────────
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

		// ── 工具5：书籍主题推荐 ──────────────────────────────────────────────────
		this.server.tool(
			"recommend_classics",
			"Get curated recommendations of classic books by theme. Default language is English.",
			{
				theme: z.string().describe("Theme like: philosophy, love, war, religion, science, political, tragedy, comedy"),
				language: z.string().default("en").describe("Preferred language code, default is English (en)"),
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

		// ── 工具6：搜索中国古籍（ctext）─────────────────────────────────────────
		this.server.tool(
			"search_chinese_classics",
			"Search Chinese classical texts from the Chinese Text Project (ctext.org). Covers pre-Qin, Han dynasty philosophy, Confucianism, Taoism, history, poetry and more.",
			{
				query: z.string().describe("Search term in Chinese or English, e.g. '论语', 'analects', '道德经'"),
			},
			async ({ query }) => {
				const cacheKey = `ctext:search:${query}`;
				const cached = getCache(cacheKey);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };
				const data = await searchCtext(query);
				const response = { query, source: "ctext.org", total: data.length, results: data };
				setCache(cacheKey, response);
				return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
			}
		);

		// ── 工具7：获取中国古籍章节（ctext URN）─────────────────────────────────
		this.server.tool(
			"get_chinese_classic_chapter",
			"Get chapter content from Chinese Text Project using a URN. Use browse_chinese_classics to find URNs. Example URNs: ctp:analects/xue-er, ctp:dao-de-jing, ctp:sunzi",
			{
				urn: z.string().describe("CTP URN, e.g. 'ctp:analects/xue-er', 'ctp:dao-de-jing', 'ctp:shiji/benji'"),
			},
			async ({ urn }) => {
				const cacheKey = `ctext:chapter:${urn}`;
				const cached = getCache(cacheKey, 600_000);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };
				const data: any = await getCtextChapter(urn);
				const result = { source: "ctext.org", urn, ...data };
				setCache(cacheKey, result);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
			}
		);

		// ── 工具8：浏览中国古典名著目录 ─────────────────────────────────────────
		this.server.tool(
			"browse_chinese_classics",
			"Browse curated catalog of Chinese classical texts with URNs for use with get_chinese_classic_chapter.",
			{
				category: z.enum(["all", "philosophy", "history", "poetry", "classics"])
					.default("all")
					.describe("Category: philosophy(诸子百家), history(史书), poetry(诗词), classics(经部)"),
			},
			async ({ category }) => {
				const catalog = category === "all"
					? CHINESE_CLASSICS_CATALOG
					: { [category]: CHINESE_CLASSICS_CATALOG[category] || [] };
				return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
			}
		);

		// ── 工具9：今日诗词（随机古诗推荐）─────────────────────────────────────
		this.server.tool(
			"get_daily_poem",
			"Get a random classic Chinese poem with title, author, and content. Great for daily inspiration.",
			{},
			async () => {
				const data: any = await getDailyPoem();
				if (data.error) return { content: [{ type: "text", text: JSON.stringify(data) }] };
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							source: "今日诗词 jinrishici.com",
							content: data.content,
							author: data.author,
							origin: data.origin,
							category: data.category,
						}, null, 2)
					}]
				};
			}
		);

		// ── 工具10：搜索日本文学（青空文庫）─────────────────────────────────────
		this.server.tool(
			"search_japanese_classics",
			"Search Japanese classic literature from Aozora Bunko (青空文庫). Covers Heian, Edo, Meiji, Taisho, and Showa era works. Leave query empty to browse the built-in catalog.",
			{
				query: z.string().optional().describe("Title or author in Japanese or English, e.g. '夏目漱石', '源氏物語'. Leave empty to browse catalog."),
				era: z.enum(["all", "平安", "江戸", "明治", "大正", "昭和"]).default("all").describe("Filter catalog by era (only used when query is empty)"),
			},
			async ({ query, era }) => {
				if (!query) {
					const catalog = era === "all"
						? JAPANESE_CLASSICS_CATALOG
						: JAPANESE_CLASSICS_CATALOG.filter(b => b.era === era);
					return { content: [{ type: "text", text: JSON.stringify({ catalog }, null, 2) }] };
				}
				const cacheKey = `aozora:search:${query}`;
				const cached = getCache(cacheKey);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };
				const results = await searchAozora(query);
				const response = { query, source: "aozora_bunko", results };
				setCache(cacheKey, response);
				return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
			}
		);

		// ── 工具11：获取日本名著章节（青空文庫）─────────────────────────────────
		this.server.tool(
			"get_japanese_classic_chapter",
			"Get text content from Aozora Bunko. Use search_japanese_classics to find book IDs.",
			{
				book_id: z.string().describe("Aozora book ID from search results, e.g. 'aozora:789' or '789'"),
				chapter: z.number().default(1).describe("Chapter number starting from 1"),
			},
			async ({ book_id, chapter }) => {
				const id = book_id.replace("aozora:", "");
				const cacheKey = `aozora:chapter:${id}:${chapter}`;
				const cached = getCache(cacheKey, 600_000);
				if (cached) return { content: [{ type: "text", text: JSON.stringify(cached, null, 2) }] };

				const result = await getAozoraText(id);
				if (!result) return { content: [{ type: "text", text: "Text not available for this book. Check the book_id is correct." }] };

				// 清理青空文庫特有格式注释
				const cleaned = result.text
					.replace(/［＃[^\]]*］/g, "")   // 移除格式注释
					.replace(/《[^》]*》/g, "")      // 移除振假名
					.replace(/｜/g, "");             // 移除分隔符

				const chapterData = extractChapter(cleaned, chapter);
				const response = {
					source: "aozora_bunko",
					book_id: id,
					title: result.meta.title,
					authors: result.meta.authors?.map((a: any) => `${a.last_name}${a.first_name}`).join(", "),
					language: "ja",
					chapter,
					...chapterData,
				};
				setCache(cacheKey, response);
				return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }] };
			}
		);

		// ── 工具12：浏览韩国古典目录 ─────────────────────────────────────────────
		this.server.tool(
			"browse_korean_classics",
			"Browse Korean classical literature catalog. Full text available via search_books with language='ko' on Wikisource.",
			{},
			async () => {
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							note: "To read full text, use search_books with language='ko' and the title_ko field as query.",
							catalog: KOREAN_CLASSICS_CATALOG,
						}, null, 2)
					}]
				};
			}
		);
	}
}

export default MyMCP.serve("/mcp");