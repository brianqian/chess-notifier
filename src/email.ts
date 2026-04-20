import type { ChessComGame } from './chess';

export type ImportedGame = {
  game: ChessComGame;
  lichessUrl: string;
};

export type EmailEnv = {
  RESEND_API_KEY: string;
  EMAIL_FROM: string;
  EMAIL_TO: string;
  CHESS_USERNAME: string;
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );

function renderGame(imported: ImportedGame, username: string): string {
  const { game, lichessUrl } = imported;
  const me = game.white.username.toLowerCase() === username.toLowerCase() ? game.white : game.black;
  const opp = me === game.white ? game.black : game.white;
  const label = me.result === 'win' ? 'Won' : opp.result === 'win' ? 'Lost' : 'Draw';
  const color = me === game.white ? 'White' : 'Black';
  const date = new Date(game.end_time * 1000).toISOString().slice(0, 10);

  return `
    <p style="margin:0 0 16px">
      <strong>${label}</strong> as ${color} vs
      ${escapeHtml(opp.username)} (${opp.rating})
      &middot; ${escapeHtml(game.time_class)} &middot; ${date}<br>
      <a href="${lichessUrl}">Lichess analysis</a>
      &middot;
      <a href="${game.url}">Chess.com game</a>
    </p>
  `;
}

export async function sendEmail(env: EmailEnv, imported: ImportedGame[]): Promise<void> {
  const html = imported.map((i) => renderGame(i, env.CHESS_USERNAME)).join('');
  const subject =
    imported.length === 1
      ? 'New chess game ready for analysis'
      : `${imported.length} new chess games ready for analysis`;

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
