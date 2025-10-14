// src/worker.ts
// Cloudflare Worker: проверяет за последние 5 дней сообщения, начинающиеся с "code review",
// если суммарных реакций < 2 — пишет ответ в тред. Дополнительно пингует user group (если задана).
// Требуемые Slack scopes: chat:write, channels:read, conversations.history, reactions:read,
// usergroups:read; для приватных каналов добавьте groups:history, groups:read.

type SlackListResp<T> = { ok: boolean; error?: string; response_metadata?: { next_cursor?: string }; [k: string]: any } & T;

export interface Env {
	SLACK_BOT_TOKEN: string;     // xoxb-***
	SLACK_CHANNEL_ID: string;    // C**** / G****
	REMINDER_TEXT?: string;      // Текст напоминания
	GROUP_HANDLE?: string;       // usergroup handle без @ (например unity_front_team)
	WORK_TZ?: string;            // Таймзона для "рабочих часов", по умолчанию Europe/Kyiv
	REMINDER_INTERVAL?: number;
}

const FIVE_DAYS_SEC = 5 * 24 * 60 * 60;

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(req.url);
		if (url.pathname === "/run" && req.method === "POST") {
			const res = await runSlackReminder(env);
			return json(res);
		}
		if (url.pathname === "/health") return new Response("ok");
		return new Response("Use POST /run", { status: 404 });
	},

	// Cron-триггер (см. wrangler.toml → triggers.crons)
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		await runSlackReminder(env);
	},
};

async function runSlackReminder(env: Env) {
	const nowSec = Math.floor(Date.now() / 1000);
	const oldest = nowSec - FIVE_DAYS_SEC;

	let cursor: string | undefined;
	let sent = 0, skipped = 0;

	do {
		const page = await slackFetch<SlackListResp<{ messages: any[] }>>(
			env, "conversations.history",
			{ channel: env.SLACK_CHANNEL_ID, oldest, limit: 200, cursor }
		);

		for (const msg of page.messages ?? []) {
			const text = (msg.text ?? "").trim();
			if (!text || !/\bcode review\b/i.test(text)) { skipped++; continue; }

			const reactions = totalReactions(msg);
			if (reactions >= 2) { skipped++; continue; }

			const isYongMessage = await shouldSkipByTimeOrRecentThread(env, msg.ts)
			if (isYongMessage) { skipped++; continue; }

			const mention = await buildUsergroupMention(env).catch(() => "");
			const body = `${mention ? mention + " " : ""}${env.REMINDER_TEXT || "Auto-reminder: add at least 2 reactions (emoji :+1::skin-tone-5: | :question: ) to confirm the review."}`;

			console.log("sending for message", text);
			await slackFetch(env, "chat.postMessage", {
				channel: env.SLACK_CHANNEL_ID,
				thread_ts: msg.ts,
				text: body,
			}, "POST");

			sent++;
			// необязательно, но снизит риск rate-limit
			await sleep(250);
		}
		cursor = page.response_metadata?.next_cursor || undefined;
	} while (cursor);

	return { sent, skipped };
}

function totalReactions(msg: any): number {
	const rs = msg.reactions || [];
	return rs.reduce((s: number, r: any) => s + (r.count || 0), 0);
}

async function buildUsergroupMention(env: Env): Promise<string> {
	if (!env.GROUP_HANDLE) return "";
	const r = await slackFetch<SlackListResp<{ usergroups: any[] }>>(env, "usergroups.list", {});
	const g = (r.usergroups || []).find((x: any) =>
		x.handle === env.GROUP_HANDLE || x.name === env.GROUP_HANDLE);
	return g?.id ? `<!subteam^${g.id}>` : "";
}

// Пропуск по "рабочим окнам" и если в треде была активность менее 3 часов назад
async function shouldSkipByTimeOrRecentThread(env: Env, threadTs: string): Promise<boolean> {
	const tz = env.WORK_TZ || "Europe/Kyiv";
	const now = new Date();
	const localNow = new Date(now.toLocaleString("en-US", { timeZone: tz }));
	const day = localNow.getDay(); // 0-6 (Sun-Sat)
	const hour = localNow.getHours();

	if (day === 0 || day === 6) return true;       // выходные
	if (hour >= 20 || hour < 8) return true;       // ночь

	// Проверим последнюю активность треда
	let cursor: string | undefined;
	let lastTs = parseFloat(threadTs);
	do {
		const r = await slackFetch<SlackListResp<{ messages: any[] }>>(
			env, "conversations.replies",
			{ channel: env.SLACK_CHANNEL_ID, ts: threadTs, limit: 200, cursor }
		);
		for (const m of r.messages || []) {
			const tsNum = parseFloat(m.ts);
			if (!Number.isNaN(tsNum) && tsNum > lastTs) lastTs = tsNum;
		}
		cursor = r.response_metadata?.next_cursor || undefined;
	} while (cursor);

	const hoursPassed = (Date.now() - Math.floor(lastTs * 1000)) / 3_600_000;
	const activityInThread = env.REMINDER_INTERVAL || 3;
	return hoursPassed < activityInThread;
}

// Унифицированный вызов Slack Web API с ретраями 429/5xx
async function slackFetch<T = any>(
	env: Env,
	method: string,
	body: Record<string, any>,
	httpMethod: "GET" | "POST" = "GET",
	retries = 3
): Promise<T> {
	const url = new URL(`https://slack.com/api/${method}`);
	let init: RequestInit;

	if (httpMethod === "GET") {
		for (const [k, v] of Object.entries(body)) if (v !== undefined) url.searchParams.set(String(k), String(v));
		init = {
			method: "GET",
			headers: { "Authorization": `Bearer ${env.SLACK_BOT_TOKEN}` },
		};
	} else {
		init = {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${env.SLACK_BOT_TOKEN}`,
				"Content-Type": "application/json; charset=utf-8",
			},
			body: JSON.stringify(body),
		};
	}

	const res = await fetch(url.toString(), init);

	if (res.status === 429 && retries > 0) {
		const ra = Number(res.headers.get("Retry-After") || "1");
		await sleep((isFinite(ra) ? ra : 1) * 1000);
		return slackFetch(env, method, body, httpMethod, retries - 1);
	}
	if (res.status >= 500 && retries > 0) {
		await sleep(500 * (4 - retries));
		return slackFetch(env, method, body, httpMethod, retries - 1);
	}

	const data = await res.json();
	if (!data.ok) {
		throw new Error(`Slack ${method} failed: ${data.error || res.status}`);
	}
	return data as T;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function json(obj: unknown, status = 200) {
	return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
