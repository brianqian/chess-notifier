import { format, fromUnixTime } from 'date-fns';
import { escapeHtml, safeHref } from './html';
import type { ChessComGame } from './chess';
import { TIME_CLASSES, type RatingStats, type TimeClass, type TodaySummary } from './ratings';

export type ImportedGame = {
  game: ChessComGame;
  lichessUrl: string;
};

export type EmailEnv = {
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
  CHESS_USERNAME: string;
  PUBLIC_URL?: string;
  TRIGGER_SECRET?: string;
};

const formatGameDate = (endTimeSeconds: number) =>
  format(fromUnixTime(endTimeSeconds), 'yyyy-MM-dd');

function pickSides(g: ChessComGame, username: string) {
  const me = g.white.username.toLowerCase() === username.toLowerCase() ? g.white : g.black;
  const opp = me === g.white ? g.black : g.white;
  const label = me.result === 'win' ? 'Won' : opp.result === 'win' ? 'Lost' : 'Draw';
  const color = me === g.white ? 'White' : 'Black';
  return { me, opp, label, color };
}

function renderGame(imported: ImportedGame, username: string): string {
  const { game, lichessUrl } = imported;
  const { opp, label, color } = pickSides(game, username);
  const date = formatGameDate(game.end_time);

  return `
    <p style="margin:0 0 16px">
      <strong>${label}</strong> as ${color} vs
      ${escapeHtml(opp.username)} (${opp.rating})
      &middot; ${escapeHtml(game.time_class)} &middot; ${date}<br>
      <a href="${safeHref(lichessUrl)}">Lichess analysis</a>
      &middot;
      <a href="${safeHref(game.url)}">Chess.com game</a>
    </p>
  `;
}

function renderRecentLink(env: EmailEnv): string {
  if (!env.PUBLIC_URL || !env.TRIGGER_SECRET) return '';
  const base = env.PUBLIC_URL.replace(/\/$/, '');
  const href = `${base}/recent?key=${encodeURIComponent(env.TRIGGER_SECRET)}`;
  return `<p style="margin:24px 0 0;font-size:14px">
    <a href="${safeHref(href)}">View all games from the last 24 hours</a>
  </p>`;
}

function renderRateLimitedSection(
  env: EmailEnv,
  rateLimited: ChessComGame[],
  username: string
): string {
  if (rateLimited.length === 0) return '';
  const list = rateLimited
    .map((g) => {
      const { opp, label, color } = pickSides(g, username);
      const date = formatGameDate(g.end_time);
      return `<li>
        <strong>${label}</strong> as ${color} vs ${escapeHtml(opp.username)} (${opp.rating})
        &middot; ${escapeHtml(g.time_class)} &middot; ${date}
        &middot; <a href="${safeHref(g.url)}">Chess.com game</a>
      </li>`;
    })
    .join('');

  let retryLink = '';
  if (env.PUBLIC_URL && env.TRIGGER_SECRET) {
    const base = env.PUBLIC_URL.replace(/\/$/, '');
    const href = `${base}/retry?key=${encodeURIComponent(env.TRIGGER_SECRET)}`;
    retryLink = `<p style="margin:8px 0 0;font-size:14px">
      <a href="${safeHref(href)}">Kick the retry job now</a>
      (these are queued and auto-retried at 1/min; the link just nudges the next import).
    </p>`;
  }

  return `<div style="margin:24px 0 0;padding:12px 14px;background:#fff4e5;border-left:3px solid #d97706">
    <p style="margin:0 0 8px"><strong>${rateLimited.length} game${rateLimited.length === 1 ? '' : 's'} queued for retry — Lichess rate limit hit.</strong></p>
    <ul style="margin:0 0 0 20px;padding:0">${list}</ul>
    ${retryLink}
  </div>`;
}

export type RatingContext = {
  statsByClass: Partial<Record<TimeClass, RatingStats>>;
  todaySummaries: TodaySummary[];
};

const SUBJECT_PREFIX = 'Chess report:';

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

function formatRecord(s: TodaySummary): string {
  const parts = [`${s.wins}W`, `${s.losses}L`];
  if (s.draws > 0) parts.push(`${s.draws}D`);
  return parts.join('-');
}

function buildSubject(
  imported: ImportedGame[],
  rateLimited: ChessComGame[],
  todaySummaries: TodaySummary[]
): string {
  if (todaySummaries.length > 0) {
    const parts = todaySummaries.map((s) => {
      // For N=1 games today with no next-game lookahead, delta is 0 because we have
      // no post-game rating yet — drop the misleading "+0" and just show the record.
      const showDelta = s.delta !== 0 || s.deltaComplete;
      const head = showDelta
        ? `${capitalize(s.timeClass)} ${signed(s.delta)}`
        : capitalize(s.timeClass);
      return `${head} (${formatRecord(s)})`;
    });
    return `${SUBJECT_PREFIX} ${parts.join(' · ')}`;
  }
  if (imported.length === 0) {
    return `${SUBJECT_PREFIX} ${rateLimited.length} game${rateLimited.length === 1 ? '' : 's'} queued (Lichess rate limit)`;
  }
  return `${SUBJECT_PREFIX} ${imported.length} new game${imported.length === 1 ? '' : 's'}`;
}

function renderSparklineCell(
  point: { rating: number; day_close_rating: number } | null,
  min: number,
  range: number
): string {
  if (!point) {
    return `<td style="width:6px;height:42px;padding:0;font-size:0;line-height:0">&nbsp;</td>`;
  }
  const r = point.day_close_rating;
  const h = Math.max(2, Math.round(((r - min) / range) * 36) + 2);
  return `<td style="width:6px;height:42px;padding:0;font-size:0;line-height:0;vertical-align:bottom">
    <div style="height:${h}px;background:#2f6feb;width:5px;margin:0 auto"></div>
  </td>`;
}

function renderRatingBlock(stats: RatingStats, today: TodaySummary | undefined): string {
  const days = 30;
  // Bucket history by `day` (days-since-epoch); the series is sparse — days without
  // games carry forward (rendered as empty cells so the gap is visible).
  const byDay = new Map<number, RatingStats['history'][number]>();
  let maxDay = -Infinity;
  for (const p of stats.history) {
    byDay.set(p.day, p);
    if (p.day > maxDay) maxDay = p.day;
  }
  // Last cell = the latest day in the series; window goes back `days-1` cells.
  const cells: (RatingStats['history'][number] | null)[] = [];
  for (let i = days - 1; i >= 0; i--) {
    cells.push(byDay.get(maxDay - i) ?? null);
  }
  const present = cells.filter((c): c is RatingStats['history'][number] => c != null);
  if (present.length === 0) return '';
  const ratings = present.map((c) => c.day_close_rating);
  const min = Math.min(...ratings);
  const max = Math.max(...ratings);
  const range = Math.max(1, max - min);

  const bars = cells.map((c) => renderSparklineCell(c, min, range)).join('');

  const total = stats.rating_delta;
  const totalColor = total > 0 ? '#1a7f37' : total < 0 ? '#cf222e' : '#57606a';
  const showTodayBadge = today != null && (today.delta !== 0 || today.deltaComplete);
  const todayBadge = showTodayBadge
    ? ` &middot; <span style="color:${today!.delta > 0 ? '#1a7f37' : today!.delta < 0 ? '#cf222e' : '#57606a'}">${signed(today!.delta)} today</span>`
    : '';

  return `<div style="margin:0 0 18px">
    <div style="font-size:13px;color:#57606a;margin-bottom:4px">
      <strong style="color:#000">${capitalize(stats.timeClass)}</strong>
      &middot; ${stats.rating_last}
      &middot; <span style="color:${totalColor}">${signed(total)} over 30d</span>
      ${todayBadge}
      &middot; <span style="color:#8b949e">range ${min}–${max} &middot; peak ${stats.rating_max}</span>
    </div>
    <table cellpadding="0" cellspacing="1" role="presentation" style="border-collapse:separate"><tr>${bars}</tr></table>
  </div>`;
}

function renderRatingHeader(ctx: RatingContext): string {
  const blocks: string[] = [];
  for (const tc of TIME_CLASSES) {
    const stats = ctx.statsByClass[tc];
    if (!stats) continue;
    const today = ctx.todaySummaries.find((s) => s.timeClass === tc);
    blocks.push(renderRatingBlock(stats, today));
  }
  if (blocks.length === 0) return '';
  return `<div style="margin:0 0 24px;padding:14px 16px;background:#f6f8fa;border:1px solid #d0d7de;border-radius:6px">
    ${blocks.join('')}
  </div>`;
}

export async function sendEmail(
  env: EmailEnv,
  imported: ImportedGame[],
  rateLimited: ChessComGame[] = [],
  ratingContext?: RatingContext
): Promise<void> {
  if (imported.length === 0 && rateLimited.length === 0) return;

  const ratingHeader = ratingContext ? renderRatingHeader(ratingContext) : '';
  const html =
    ratingHeader +
    imported.map((i) => renderGame(i, env.CHESS_USERNAME)).join('') +
    renderRateLimitedSection(env, rateLimited, env.CHESS_USERNAME) +
    renderRecentLink(env);

  const subject = buildSubject(imported, rateLimited, ratingContext?.todaySummaries ?? []);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: env.EMAIL_TO,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`resend failed ${res.status}: ${text.slice(0, 200)}`);
  }
}
