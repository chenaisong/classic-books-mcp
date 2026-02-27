import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

export class MyMCP extends McpAgent {
	server = new McpServer({
		name: "Classic Books",
		version: "1.0.0",
	});

	async init() {

		// 工具1：搜索书籍
		this.server.tool(
			"search_books",
			"Search for classic books by title or author from Project Gutenberg",
			{ query: z.string().describe("Book title or author name to search for") },
			async ({ query }) => {
				const res = await fetch(
					`https://gutendex.com/books/?search=${encodeURIComponent(query)}&languages=en`
				);
				const data: any = await res.json();

				if (!data.results?.length) {
					return { content: [{ type: "text", text: `No books found for: ${query}` }] };
				}

				const books = data.results.slice(0, 5).map((book: any) => ({
					id: book.id,
					title: book.title,
					authors: book.authors.map((a: any) => a.name).join(", "),
					download_count: book.download_count,
					cover_url: book.formats["image/jpeg"],
				}));

				return {
					content: [{
						type: "text",
						text: JSON.stringify({ total: data.count, books }, null, 2)
					}]
				};
			}
		);

		// 工具2：获取章节内容
		this.server.tool(
			"get_chapter",
			"Get the text content of a specific chapter from a Project Gutenberg book",
			{
				book_id: z.string().describe("The Gutenberg book ID, obtained from search_books"),
				chapter: z.number().default(1).describe("Chapter number to retrieve, starting from 1"),
			},
			async ({ book_id, chapter }) => {
				const metaRes = await fetch(`https://gutendex.com/books/${book_id}`);
				if (!metaRes.ok) return { content: [{ type: "text", text: "Book not found" }] };
				const meta: any = await metaRes.json();

				const textUrl = meta.formats["text/plain; charset=utf-8"] || meta.formats["text/plain"];
				if (!textUrl) return { content: [{ type: "text", text: "No plain text available for this book" }] };

				const textRes = await fetch(textUrl);
				const fullText = await textRes.text();
				const chapterData = extractChapter(fullText, chapter);

				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							id: book_id,
							title: meta.title,
							authors: meta.authors.map((a: any) => a.name).join(", "),
							chapter,
							total_chapters: chapterData.total,
							chapter_title: chapterData.title,
							content: chapterData.content,
							word_count: chapterData.content.split(/\s+/).length,
						}, null, 2)
					}]
				};
			}
		);

		// 工具3：搜索有声书
		this.server.tool(
			"search_audiobook",
			"Search for free audiobooks from LibriVox by title",
			{ query: z.string().describe("Book title to search for audiobook") },
			async ({ query }) => {
				const res = await fetch(
					`https://librivox.org/api/feed/audiobooks/?title=${encodeURIComponent(query)}&format=json&limit=5`
				);
				const data: any = await res.json();

				if (!data.books?.length) {
					return { content: [{ type: "text", text: `No audiobooks found for: ${query}` }] };
				}

				const audiobooks = data.books.map((book: any) => ({
					id: book.id,
					title: book.title,
					authors: book.authors
						? book.authors.map((a: any) => `${a.first_name} ${a.last_name}`).join(", ")
						: "Unknown",
					url_librivox: book.url_librivox,
					url_rss: book.url_rss,
					url_zip_file: book.url_zip_file,
					totaltime: book.totaltime,
				}));

				return {
					content: [{
						type: "text",
						text: JSON.stringify({ audiobooks }, null, 2)
					}]
				};
			}
		);
	}
}

export default MyMCP.serve("/mcp");
