import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('./assets/terminal.js', import.meta.url), 'utf8');
const style = `
html,body{width:100%;height:100%;min-height:0;margin:0;overflow:hidden}
#terminal-container{position:fixed;left:var(--terminal-left,0px);top:var(--terminal-top,0px);width:var(--terminal-width,100%);height:var(--terminal-height,100%);margin:0;padding:0;overflow:hidden}
#terminal-container .terminal{box-sizing:border-box;width:100%;height:100%;padding:5px}
`;

export function terminalPage(html) {
  return html.replace(/<meta\b(?=[^>]*\bname=["']viewport["'])[^>]*>/gi, '')
    .replace(/<head\b[^>]*>/i, '$&<meta name="viewport" content="width=device-width, initial-scale=1">')
    .replace(
    /<link\b(?=[^>]*\brel=["'](?:shortcut )?icon["'])[^>]*>/gi,
    '<link rel="icon" type="image/png" href="/assets/logo.png">')
    .replace(/<title>[^<]*<\/title>/i, '<title>Codex Terminal</title>')
    .replace(/<\/head>/i, `<style>${style}</style></head>`)
    .replace(/<\/body>/i, `<script>${script}</script></body>`);
}
