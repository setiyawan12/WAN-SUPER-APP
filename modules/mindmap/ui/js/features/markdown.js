// ── js/features/markdown.js — minimal markdown renderer ──────
// Mendukung: **bold**, *italic*, `code`, - bullet, URL autolink, newline → <br>
// Aman: HTML di-escape sebelum transformasi markdown.

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Regex untuk deteksi URL sebelum di-escape (diterapkan pada raw text)
const URL_RE = /https?:\/\/[^\s<>"'()[\]{}]+/g;

/**
 * Autolink URL di raw text. Placeholder agar URL tidak ikut di-escape.
 * Strategi: pisahkan teks menjadi bagian URL dan bukan-URL, escape bukan-URL,
 * lalu wrap URL dengan <a>.
 */
function autolinkUrls(raw) {
  const parts = [];
  let last = 0;
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(raw)) !== null) {
    // Bagian teks sebelum URL — escape dulu
    parts.push(escHtml(raw.slice(last, m.index)));
    // URL sendiri
    const url = escHtml(m[0]); // escape karakter khusus di URL
    parts.push(`<a href="${url}" target="_blank" rel="noopener noreferrer" class="node-link" onclick="event.stopPropagation()">${url}</a>`);
    last = m.index + m[0].length;
  }
  parts.push(escHtml(raw.slice(last)));
  return parts.join('');
}

function inlineMd(escaped) {
  // Bold DULU (** **), baru italic (* *) agar ** tidak di-match sebagai dua *
  return escaped
    .replace(/\*\*(.+?)\*\*/g,        '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`(.+?)`/g,               '<code class="node-md-code">$1</code>');
}

/**
 * Render teks markdown ke HTML aman.
 * Mendukung: **bold**, *italic*, `code`, - / * / • bullet, 1. 2. ordered list,
 * URL autolink, baris kosong → spasi antar paragraf.
 */
export function renderMd(raw) {
  if (!raw) return '';
  const lines = raw.split('\n');
  const out   = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // ── Ordered list: "1. " "2. " … ──
    const olM = trimmed.match(/^(\d+)\.\s+([\s\S]*)$/);
    if (olM) {
      const content = inlineMd(autolinkUrls(olM[2]));
      out.push(
        `<span class="node-md-ol">` +
        `<span class="node-md-num">${olM[1]}.</span> ${content}` +
        `</span>`
      );
      continue;
    }

    // ── Bullet list: "- ", "* ", or "• " at line start ──
    if (/^[-*•]\s/.test(trimmed)) {
      const content = inlineMd(autolinkUrls(trimmed.replace(/^[-*•]\s+/, '')));
      out.push(`<span class="node-md-li">• ${content}</span>`);
      continue;
    }

    // ── Empty line → visual gap ──
    if (!trimmed) {
      out.push('<span class="node-md-gap"></span>');
      continue;
    }

    // ── Normal line ──
    out.push('<span class="node-md-line">' + inlineMd(autolinkUrls(line)) + '</span>');
  }

  return out.join('');
}
