// Minimal markdown -> HTML renderer for the reporting suite's generated
// text reports (Monthly Report now, RF Audit's findings report later).
// v1 has its own markdownToHtmlSimple() (bts_monitor.html ~line 4123)
// but it doesn't actually render `|...|` tables at all — despite the
// reports it's used on being full of them — so tables show up as raw
// pipe-delimited text in v1. That's a real display gap in v1, not
// intentional; this renders tables properly instead, which is a pure
// presentation improvement with no effect on the report's underlying
// data or logic (the thing that must stay a faithful port).

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function inline(s: string): string {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim()
  const inner = trimmed.startsWith('|') && trimmed.endsWith('|') ? trimmed.slice(1, -1) : trimmed
  return inner.split('|').map((c) => c.trim())
}

function isSeparatorRow(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line.trim()) && line.includes('-')
}

function renderTable(lines: string[]): string {
  const header = parseTableRow(lines[0])
  const bodyLines = lines.slice(1).filter((l) => !isSeparatorRow(l))
  const headHtml = `<thead><tr>${header.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead>`
  const bodyHtml = `<tbody>${bodyLines
    .map((l) => `<tr>${parseTableRow(l).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`
  return `<table class="md-table">${headHtml}${bodyHtml}</table>`
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('### ')) {
      out.push(`<h4>${inline(line.slice(4))}</h4>`)
      i++
      continue
    }
    if (line.startsWith('## ')) {
      out.push(`<h3>${inline(line.slice(3))}</h3>`)
      i++
      continue
    }
    if (line.startsWith('# ')) {
      out.push(`<h2>${inline(line.slice(2))}</h2>`)
      i++
      continue
    }
    if (line.trim() === '---') {
      out.push('<hr/>')
      i++
      continue
    }
    if (line.trim().startsWith('|')) {
      const tableLines: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i])
        i++
      }
      out.push(renderTable(tableLines))
      continue
    }
    if (line.startsWith('- ')) {
      const items: string[] = []
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(lines[i].slice(2))
        i++
      }
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join('')}</ul>`)
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
    i++
  }
  return out.join('\n')
}
