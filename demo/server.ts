import { resolve, basename, relative } from "path";
import { Glob } from "bun";

const PORT = 3456;
const AGENT_DIR = resolve(import.meta.dir, "../agent");
const NOTES_DIR = resolve(import.meta.dir, "../notes");
const BUN = resolve(process.env.HOME!, ".bun/bin/bun");
const GARDEN_BASE = "https://physics-garden.pages.dev";

// Build title → garden URL mapping on startup
async function buildNoteMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  const glob = new Glob("**/*.md");
  for await (const file of glob.scan({ cwd: NOTES_DIR, absolute: false })) {
    const title = basename(file, ".md");
    // e.g. "concepts/庫侖定律.md" → "/concepts/庫侖定律"
    const urlPath = file.replace(/\.md$/, "");
    map[title] = `${GARDEN_BASE}/${encodeURI(urlPath)}`;
  }
  return map;
}

const noteMap = await buildNoteMap();
console.log(`Loaded ${Object.keys(noteMap).length} note URLs`);

// Meta questions about the conversation itself — answer directly without agent
const META_PATTERNS = /^(剛才|上一個|之前|前面)(我)?(問了?|說了?)(什麼|啥|哪)/;

function isMetaQuestion(raw: string, history: string[]): string | null {
  if (history.length === 0) return null;
  if (META_PATTERNS.test(raw)) {
    return `你剛才問的是：「${history[history.length - 1]}」`;
  }
  return null;
}

function enrichQuestion(raw: string, history: string[], shown: string[]): string {
  const parts: string[] = [];
  if (history.length > 0) {
    const ctx = history.map((q, i) => `${i + 1}.「${q}」`).join(" ");
    parts.push(`背景：之前的對話依序討論了：${ctx}`);
  }
  if (shown.length > 0) {
    parts.push(`已出過的題目：${shown.join("、")}，請不要重複`);
  }
  if (parts.length === 0) return raw;
  return `（${parts.join("。")}）\n\n${raw}`;
}

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(Bun.file(resolve(import.meta.dir, "index.html")));
    }

    if (url.pathname === "/api/note-map") {
      return Response.json(noteMap);
    }

    if (url.pathname === "/api/ask" && req.method === "POST") {
      const { question: q, history, shownQuestions } = (await req.json()) as {
        question: string;
        history?: string[];
        shownQuestions?: string[];
      };
      const trimmed = q?.trim();
      if (!trimmed) {
        return Response.json({ error: "question is required" }, { status: 400 });
      }
      const hist = (history ?? []).slice(-5); // Keep last 5 questions max
      const shown = shownQuestions ?? [];

      // Handle meta questions directly without calling agent
      const metaAnswer = isMetaQuestion(trimmed, hist);
      if (metaAnswer) {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            const send = (obj: Record<string, unknown>) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            send({ type: "answer", text: metaAnswer });
            send({ type: "done" });
            controller.close();
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      const enriched = enrichQuestion(trimmed, hist, shown);

      const proc = Bun.spawn({
        cmd: [BUN, "run", "src/index.ts", enriched],
        cwd: AGENT_DIR,
        stdout: "pipe",
        stderr: "pipe",
      });

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (obj: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
          };

          const stderrDone = (async () => {
            const reader = proc.stderr.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const lines = buffer.split("\n");
              buffer = lines.pop()!;
              for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed) send({ type: "log", text: trimmed });
              }
            }
            if (buffer.trim()) send({ type: "log", text: buffer.trim() });
          })();

          const stdoutDone = new Response(proc.stdout).text();

          await stderrDone;
          const answer = await stdoutDone;
          const exitCode = await proc.exited;

          if (exitCode !== 0 && !answer.trim()) {
            send({ type: "error", text: "Agent 執行失敗，請檢查 .env 設定或筆記索引" });
          } else {
            send({ type: "answer", text: answer });
          }

          send({ type: "done" });
          controller.close();
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`\n  物理知識庫 Demo → http://localhost:${PORT}\n`);
