import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('./assets/terminal.js', import.meta.url), 'utf8');
const style = `
html,body{width:100%;height:100%;min-height:0;margin:0;overflow:hidden}
#terminal-container{position:fixed;left:var(--terminal-left,0px);top:var(--terminal-top,0px);width:var(--terminal-width,100%);height:var(--terminal-height,100%);margin:0;padding:0;overflow:hidden}
#terminal-container .terminal{box-sizing:border-box;width:100%;height:100%;padding:5px}
#mobile-terminal-keys{display:none}
@media (max-width:767px) and (pointer:coarse){
  #mobile-terminal-keys{
    position:fixed;z-index:100;
    left:var(--mobile-keys-left,0px);top:var(--mobile-keys-top,calc(100% - 52px));
    width:var(--mobile-keys-width,100%);
    height:52px;box-sizing:border-box;
    display:flex;gap:5px;align-items:center;overflow-x:auto;overscroll-behavior-x:contain;
    padding:5px 8px;background:#20252d;border-top:1px solid #414958;
    scrollbar-width:none;touch-action:pan-x;
  }
  #mobile-terminal-keys::-webkit-scrollbar{display:none}
  #mobile-terminal-keys button{
    flex:0 0 auto;min-width:40px;min-height:40px;
    padding:0 11px;border:1px solid #526174;border-radius:8px;
    background:#303a49;color:#f2f5fa;font:600 14px system-ui,sans-serif;
    touch-action:manipulation;user-select:none;-webkit-user-select:none;
  }
  #mobile-terminal-keys button:active{background:#56687e}
  #mobile-terminal-keys button:focus-visible{outline:2px solid #b8e7ce;outline-offset:1px}
}
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
