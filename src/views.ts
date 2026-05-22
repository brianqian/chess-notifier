import type { ChessComGame } from './chess';
import { escapeHtml, safeHref } from './html';

export type RecentRow = {
  game: ChessComGame;
  lichessUrl: string | null;
  status: 'imported' | 'queued';
};

function renderRow(row: RecentRow, username: string): string {
  const { game: g, lichessUrl, status } = row;
  const me = g.white.username.toLowerCase() === username.toLowerCase() ? g.white : g.black;
  const opp = me === g.white ? g.black : g.white;
  const label = me.result === 'win' ? 'Won' : opp.result === 'win' ? 'Lost' : 'Draw';
  const color = me === g.white ? 'White' : 'Black';
  const link =
    lichessUrl && status === 'imported'
      ? `<a href="${safeHref(lichessUrl)}">Lichess analysis</a>`
      : `<a href="${safeHref(g.url)}">chess.com</a> <span class="pending">queued (1/min)</span>`;
  return `<tr data-end="${g.end_time}">
    <td class="when"></td>
    <td><strong>${label}</strong></td>
    <td>${color}</td>
    <td>${escapeHtml(opp.username)} (${opp.rating})</td>
    <td>${escapeHtml(g.time_class)}</td>
    <td>${link}</td>
  </tr>`;
}

export function renderRecentPage(
  rows: RecentRow[],
  username: string,
  hours: number,
  pendingCount: number
): string {
  const tbody = rows.map((r) => renderRow(r, username)).join('');
  const body = rows.length
    ? `<table cellpadding="6" style="border-collapse:collapse">
         <thead><tr style="text-align:left;border-bottom:1px solid #ccc">
           <th>Ended</th><th>Result</th><th>Color</th><th>Opponent</th><th>Time</th><th>Link</th>
         </tr></thead>
         <tbody>${tbody}</tbody>
       </table>`
    : `<p>No games in the last ${hours}h.</p>`;
  const queueNote =
    pendingCount > 0
      ? `<p><em>${pendingCount} game${pendingCount === 1 ? '' : 's'} pending import; one will be processed each minute.</em></p>`
      : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Last ${hours}h — ${escapeHtml(username)}</title>
    <style>
      body{font-family:system-ui,sans-serif;max-width:900px;margin:40px auto;padding:0 16px}
      .pending{color:#92580a;font-size:12px;display:inline-block;margin-left:6px}
    </style>
    </head><body>
    <h1>Last ${hours}h of games — ${escapeHtml(username)}</h1>
    <p>${rows.length} game${rows.length === 1 ? '' : 's'}.</p>
    ${queueNote}
    ${body}
    <script>
      for (const tr of document.querySelectorAll('tr[data-end]')) {
        const t = Number(tr.getAttribute('data-end')) * 1000;
        tr.querySelector('.when').textContent = new Date(t).toLocaleString(undefined, {
          year: 'numeric', month: 'short', day: 'numeric',
          hour: 'numeric', minute: '2-digit'
        });
      }
    </script>
    </body></html>`;
}
