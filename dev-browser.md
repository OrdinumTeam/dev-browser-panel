# Browser do projeto (dev-browser-panel)

Este projeto tem um Chromium controlável via CDP rodando **dentro do VS Code** através
da extensão [`dev-browser-panel`](https://github.com/OrdinumTeam/dev-browser-panel).
Use-o sempre que precisar testar comportamento real em browser: clicar, navegar,
ler DOM, preencher form, capturar network, validar autenticação, etc.

## Descobrir se está rodando

Antes de tentar drivar, sempre confirme que o painel está aberto:

```bash
PORT=$(cat .dev-browser-panel/port 2>/dev/null || cat ~/.dev-browser-panel/port 2>/dev/null)
if [ -z "$PORT" ]; then
  echo "Painel fechado — peça ao operador: 'Cmd+Shift+P → Dev Browser Panel: Open'"
else
  echo "Browser na porta $PORT"
fi
```

- `.dev-browser-panel/port` (project-local) tem prioridade — é o Chromium **desta** janela do VS Code.
- `~/.dev-browser-panel/port` é fallback global ("último aberto").

Cada janela do VS Code tem seu próprio Chromium isolado (profile, cookies, localStorage separados).

## Dirigir o browser

Sempre via shell, usando o `dev-browser` CLI (npm package do [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser)):

```bash
dev-browser --connect "http://localhost:$PORT" <<'EOF'
const tabs = await browser.listPages();
const p = await browser.getPage(tabs[0].id);
await p.goto("https://example.com");
console.log(await p.title());
EOF
```

O objeto `browser` é um wrapper sobre CDP. Métodos principais:

- `browser.listPages()` → array de targets (tabs)
- `browser.getPage(targetId)` → objeto Page
- `page.goto(url)`
- `page.url()` / `page.title()`
- `page.evaluate(() => ...)` → executa JS no contexto da página, retorna o valor
- `page.click(selector)`, `page.type(selector, text)`, `page.waitForSelector(selector)`

## Operações comuns

**Ler DOM**:
```bash
dev-browser --connect "http://localhost:$PORT" <<< '
const p = await browser.getPage((await browser.listPages())[0].id);
const data = await p.evaluate(() => ({
  title: document.title,
  h1s: [...document.querySelectorAll("h1")].map(h => h.innerText),
}));
console.log(JSON.stringify(data, null, 2));
'
```

**Preencher form e submeter**:
```bash
dev-browser --connect "http://localhost:$PORT" <<< '
const p = await browser.getPage((await browser.listPages())[0].id);
await p.evaluate(() => {
  document.querySelector("#email").value = "test@example.com";
  document.querySelector("#password").value = "senha";
  document.querySelector("form").submit();
});
'
```

**Capturar network (no painel Browser Logs)**:
Network já é capturado automaticamente quando o painel está aberto. Pra exportar
como HAR, o operador clica em "Copy HAR" no toolbar do painel Browser Logs.
HAR vai pro clipboard; pode colar em DevTools / Postman / har-analyzer.

**Abrir uma nova tab**:
```bash
dev-browser --connect "http://localhost:$PORT" <<< '
const tabId = await browser.newPage("https://example.com");
console.log("new tab:", tabId);
'
```

**Capturar screenshot** (útil pra mostrar evidência visual ao operador):
```bash
dev-browser --connect "http://localhost:$PORT" <<EOF > /tmp/screenshot.png.b64
const p = await browser.getPage((await browser.listPages())[0].id);
const { data } = await p.sendCommand("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,  // true = full page (incl. abaixo do fold)
});
process.stdout.write(data);
EOF
base64 -d /tmp/screenshot.png.b64 > /tmp/screenshot.png && rm /tmp/screenshot.png.b64
echo "Screenshot salvo em /tmp/screenshot.png"
```

**Salvar página como PDF**:
```bash
dev-browser --connect "http://localhost:$PORT" <<EOF > /tmp/page.pdf.b64
const p = await browser.getPage((await browser.listPages())[0].id);
const { data } = await p.sendCommand("Page.printToPDF", {
  printBackground: true,
  format: "A4",
});
process.stdout.write(data);
EOF
base64 -d /tmp/page.pdf.b64 > /tmp/page.pdf && rm /tmp/page.pdf.b64
```

**Ler cookies** (útil pra debug de auth):
```bash
dev-browser --connect "http://localhost:$PORT" <<< '
const p = await browser.getPage((await browser.listPages())[0].id);
const { cookies } = await p.sendCommand("Network.getAllCookies");
// filtra por domain se quiser:
const filtered = cookies.filter(c => c.domain.includes("anthropic.com"));
console.log(JSON.stringify(filtered.map(c => ({
  name: c.name, value: c.value.slice(0, 20) + "...",
  domain: c.domain, secure: c.secure, httpOnly: c.httpOnly
})), null, 2));
'
```

**Emular dispositivo móvel** (testar responsivo):
```bash
dev-browser --connect "http://localhost:$PORT" <<< '
const p = await browser.getPage((await browser.listPages())[0].id);
// iPhone 15 Pro
await p.sendCommand("Emulation.setDeviceMetricsOverride", {
  width: 393, height: 852, deviceScaleFactor: 3, mobile: true
});
await p.sendCommand("Emulation.setUserAgentOverride", {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
});
await p.sendCommand("Emulation.setTouchEmulationEnabled", { enabled: true });
await p.goto("https://example.com");
'
# Pra resetar pra desktop: setDeviceMetricsOverride com mobile:false + clearDeviceMetricsOverride
```

**Pedir diagnóstico de render** (quando o operador reclamar de qualidade visual):
> "Pode rodar `Cmd+Shift+P → Dev Browser Panel: Show Render Diagnostics` e me colar a tabela? Vou comparar `frame size` vs `canvas size` pra identificar se há mismatch."

A tabela mostra DPR, canvas size (CSS + backing store), último frame size, deviceScaleFactor, format/quality, FPS. Se `frame size` ≠ `canvas backing store`, há um mismatch que causa upscale/borrado.

## Quando usar

- ✅ Validar que uma mudança de UI funciona de verdade no browser
- ✅ Testar fluxo de autenticação (cookies, redirects, OAuth)
- ✅ Scraping / extração de dados
- ✅ Capturar requests/responses pra debug de API
- ✅ Reproduzir bugs reportados que precisam de browser real

## Quando NÃO usar

- ❌ Testes unitários — use vitest/jest direto
- ❌ Verificar tipo / sintaxe — use `tsc --noEmit` / lint
- ❌ Quando o operador só quer ler código — não abra browser por conta própria

## Se o painel não estiver aberto

Não tente subir o Chromium por fora — isso conflitaria com a extensão. Ao invés
disso, peça ao operador (1 frase):

> "Pra esse passo eu preciso do browser: `Cmd+Shift+P → Dev Browser Panel: Open` na janela deste projeto. Me avisa quando estiver."

Depois que ele confirmar, releia o port file e continue.

## Alternativas (mesma CDP, drivers diferentes)

Se o projeto já usa Playwright ou Puppeteer, conecta direto no Chromium da extensão
sem precisar do `dev-browser` CLI:

```ts
// Playwright
import { chromium } from "playwright";
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
const [ctx] = browser.contexts();
const page = ctx.pages()[0];
```

```ts
// Puppeteer
import puppeteer from "puppeteer";
const browser = await puppeteer.connect({ browserURL: `http://localhost:${PORT}` });
const [page] = await browser.pages();
```
