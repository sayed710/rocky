# Launch Preparation D03 — production Lighthouse verification (2026-10-05)

**D03 is closed by current, bounded production-web evidence. No production code changed. Fable + Astra engineering remediation remains closed. Public launch is not approved by this result.**

## Baseline and measured path

The provided isolated worktree was clean at `c8df3e08e8d81999178742f3f5256b4bbf7b0154` (owner-merged PR #95). Required status/worktree/branch/fetch preflight and a subsequent fetch confirmed that exact `origin/main`. The canonical checkout was untouched. The historical closure, original audit and pinned remediation ledger are unchanged.

The actual `Dockerfile.web` was built with `VITE_GIT_SHA=c8df3e08e8d81999178742f3f5256b4bbf7b0154`, tagged `rocky-d03-web:c8df3e0`. Local image ID: `sha256:e704c9216d3cb988be3eca06cf5a34aec924d219e41557bfc0e53a6564fcdba4` (a local build, not a published image claim). Builder base: `node:22-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`; runtime base: `nginxinc/nginx-unprivileged:alpine@sha256:a6c3ec0c0d249d68b0682df854d4a9e222b90fb607dc3fcf2f1d2fcbc85d347e`. Runtime Nginx: **1.31.3**.

The image entrypoint rendered the repository's unchanged `docker/web/nginx.conf.template`. `nginx -t` passed. Lighthouse navigated to `/` at `http://127.0.0.1:8080/` inside a shared, task-owned container network namespace; host access was restricted to `127.0.0.1:14380`. Nginx served its image's `/usr/share/nginx/html`, with its real static locations, headers, compression, SPA fallback and proxy directives.

Only the two intended upstream environment variables were overridden: `API_UPSTREAM=127.0.0.1:4174`, `GATEWAY_UPSTREAM=127.0.0.1:4175`. They point to the current repository's in-memory e2e harness, running unchanged alongside Vite preview. No Nginx template was rewritten or mounted over the production image. Shared loopback also preserves localhost browser secure-context behavior. This is production **web delivery** with a bounded acceptance backend, not the full durable Compose stack. The proxied `/v1/health` returned the Gambit API health response.

## Comparable measurements and audit inspection

All fresh runs used **Lighthouse 11.4.0**, **Playwright 1.61.1 / Chromium 149.0.7827.55 (revision 1228)**, accessibility only, desktop preset, 1350×940/DPR1, simulated desktop throttling (40 ms RTT, 10,240 Kbps, CPU multiplier 1), default storage reset and `--no-sandbox --headless=new --disable-gpu --disable-dev-shm-usage`. Installed axe-core reported **4.13.0**, matching the current CI artifact. Tools ran on Linux amd64/Debian bookworm in Docker Desktop 29.8.1 on Windows; Node **22.23.3**. The CI runner is Ubuntu 24.04.5/Node22, so OS/font packages and compute are comparable, not identical. No custom audit exclusions were added.

| Measurement | Built assets / backend | Accessibility | Failed audits | Warnings / runtime error |
|---|---|---:|---|---|
| Production Nginx `/`, 8080 | Actual web image; healthy current harness | **1.00** | None | None / absent |
| Fresh M6-style Vite preview `/`, 4173 | `npm ci && npm run build`, revision unset as in CI; same healthy harness | **1.00** | None | None / absent |
| Vite preview `/`, 4177 | Exact files copied from production image; same healthy harness | **1.00** | None | None / absent |
| Exact-main CI [37300745500](https://github.com/sayed710/rocky/actions/runs/37300745500/job/111732659706) | Vite preview `/`, 4173; API connection refused during Lighthouse step | **0.96** | `color-contrast` on `#lobby-error` | None / absent |

The production and fresh-preview reports each contain 22 passing binary accessibility audits, 39 not-applicable audits and 10 manual checks. Manual checks are **not certified**. Browser preflight confirmed HTTP200, delivered JS/CSS with proper MIME types, visible real lobby/auth, one main landmark, Rookzen title, empty lobby error and no page exceptions. Captures were visually inspected; the production page is the Rookzen lobby/sign-in shell, not an Nginx error or fallback-only page. The final fail-closed reproduction procedure was executed again: production **1.00**, preview **1.00**, no failed audits.

The exact-main CI artifact (`fetchTime=2026-10-05T11:09:52.756Z`) uses the same Lighthouse/category/preset/browser-major/axe versions. Its sole failure is the rendered `HTTP 500` lobby alert: foreground `#e5484d`, background `#242224`, 14px normal text, contrast **4.03:1**, expected **4.5:1**. CI logs at 11:09:52Z explicitly report `ECONNREFUSED 127.0.0.1:4174`. The Lighthouse workflow starts preview after Playwright's managed backend has stopped; it does not restart the backend for this step. This explains the current CI/local healthy-shell difference. The error-state contrast failure is retained as a limitation; it is not a sub-0.95 production-path regression, and no palette change is authorized or made here. CI's API failure is not credited as healthy production acceptance.

The fresh default preview bundle differs from the production bundle because production embeds the source revision while CI leaves it unset. The exact-image-files preview control removes that difference: production and matched preview delivered identical asset paths, lengths and SHA256 values (JS MIME differs: Nginx `application/javascript`, Vite `text/javascript`, both executable). There is no measured accessibility discrepancy attributable to web delivery.

| Production asset | Bytes | SHA256 |
|---|---:|---|
| `/assets/index-BqLL7Hht.js` | 420627 | `c36c0660b24ed21168ddee0da432082b4be8312dad7684dc7efa13d9ed8741c7` |
| `/assets/index-BNUlepaa.css` | 31064 | `b5adb73869da98f9ab29dc263a95dbeb7974b634ed14c95c703ea0a4c5ee49b5` |

Report fingerprints (original JSON bytes): production `f441d4709f7f7a3fd89fdab2d807910cda4990556ef47012b5d2c02d53967fe4`; fresh preview `057522951f1a09cca1bb07be4efdd56e88c116bc62356306d090a3f8e8acdd86`; matched preview `ea04047b22c50e78049409c386f0f65ca390a6b433e9483f6e624d684232b345`; downloaded CI `350a9f2a7d3e538714698249979ac81596fcc26b884915cf41f2755b251ed9c0`. The [immutable public evidence snapshot](https://gist.github.com/edwardnewgate710/2e6fb9a75077bd5e5052ab4cb4136af4/9bcfdc4d9378385744a5dc31e41cd79bccddabfd) contains the primary JSON/HTML reports, exact-main CI JSON, original summaries, all three shell captures in `shell-captures.html`, the final stricter reproduction runner and its new JSON/HTML reports/summary. All 16 published files were downloaded and SHA256-verified against local originals. Original CI logs remain accessible through the linked GitHub job above. Local working copies remain at `C:/Users/hp/AppData/Local/Temp/rocky-d03-evidence-20261005`; reviewers need no access to that directory. The procedure below regenerates reviewable reports.

The original audit documents Lighthouse11.4.0 with mobile-like simulated throttling (150 ms RTT, 1.6 Mbps, 4× CPU), older application assets and a historical Compose score0.93; its original individual failed audits are not present in the repository. The cause of that historical score remains unproven. It cannot establish a current defect against this new production-path report. Closure means the current shell clears the repository's ≥0.95 gate under explicitly comparable M6 settings; it does not reconstruct the old result or certify every route/state/preset.

## Fail-closed reproduction

Use the pinned source above in an isolated checkout. Create the following three scratch files outside tracked paths. Commands below use POSIX shell on a Docker host; use an absolute host directory for `EVIDENCE` and LF line endings for `start.sh`. Image base tags are mutable; the tested digests are recorded above. Before accepting results, require successful image builds/startup, `nginx -t`, the browser preflight, zero Lighthouse command exit, a newly created report, correct final URL/version, no runtime/audit error and a numeric score≥0.95. No stale report is reused. The stricter reproduction also requires zero run warnings and zero failed accessibility audits to reproduce the clean healthy-shell observations in the table; merely clearing the numeric repository gate is insufficient for this procedure.

`Dockerfile.audit` (scratch image only; no production changes):

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/ ./packages/
COPY scripts/ ./scripts/
RUN npm ci && npm run build
RUN npm install --prefix /audit lighthouse@11.4.0
RUN npx playwright install --with-deps chromium
ENV E2E_API_URL=http://127.0.0.1:4174 E2E_WS_URL=ws://127.0.0.1:4175
CMD ["sleep", "infinity"]
```

`start.sh`:

```sh
set -eu
node /app/packages/e2e-harness/dist/main.js > /evidence/harness.log 2>&1 &
printf '%s' "$!" > /evidence/harness.pid
cd /app/packages/web
/app/node_modules/.bin/vite preview --port 4173 --host 127.0.0.1 --strictPort > /evidence/preview.log 2>&1 &
printf '%s' "$!" > /evidence/preview.pid
wait
```

`reproduce.mjs`:

```js
import { chromium } from '/app/node_modules/playwright/index.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const out='/evidence/final-reproduction';
fs.mkdirSync(out,{recursive:true});
const metadata={node:process.version,browserExecutable:chromium.executablePath(),runs:[]};
for(const [name,url] of [['production','http://127.0.0.1:8080/'],['preview','http://127.0.0.1:4173/']]) {
  const response=await fetch(url);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.ok(html.includes('id="lobby"') && html.includes('id="auth"'));
  const assets=[...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m=>m[1]);
  assert.ok(assets.some(a=>a.endsWith('.js')) && assets.some(a=>a.endsWith('.css')));
  const delivered=[];
  for(const path of assets){ const r=await fetch(new URL(path,url)); assert.equal(r.status,200); const bytes=Buffer.from(await r.arrayBuffer()); delivered.push({path,sha256:crypto.createHash('sha256').update(bytes).digest('hex'),length:bytes.length,contentType:r.headers.get('content-type')}); }
  const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:1350,height:940}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url,{waitUntil:'networkidle'});
  await page.locator('#lobby').waitFor({state:'visible'});
  await page.locator('#auth').waitFor({state:'visible'});
  assert.equal(await page.locator('main').count(),1);
  assert.match(await page.title(),/Rookzen/);
  assert.equal((await page.locator('#lobby-error').innerText()).trim(),'');
  assert.equal(errors.length,0,errors.join('\n'));
  await page.screenshot({path:`${out}/${name}.png`,fullPage:true});
  const shell={title:await page.title(),bodyText:(await page.locator('body').innerText()).slice(0,1600),pageErrors:errors,browserVersion:browser.version()};
  await browser.close();
  const prefix=`${out}/${name}`;
  for(const extension of ['report.json','report.html']) fs.rmSync(prefix+'.'+extension,{force:true});
  const result=spawnSync('/audit/node_modules/.bin/lighthouse',[url,'--output=json','--output=html',`--output-path=${prefix}`,'--chrome-flags=--no-sandbox --headless=new --disable-gpu --disable-dev-shm-usage','--only-categories=accessibility','--preset=desktop','--quiet'],{env:{...process.env,CHROME_PATH:chromium.executablePath()},encoding:'utf8',timeout:120000});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(fs.readFileSync(`${prefix}.report.json`,'utf8'));
  assert.ok(!report.runtimeError,JSON.stringify(report.runtimeError));
  assert.equal(report.finalUrl,url);
  assert.equal(report.lighthouseVersion,'11.4.0');
  const score=report.categories?.accessibility?.score;
  assert.equal(typeof score,'number');
  const audits=report.categories.accessibility.auditRefs.map(ref=>({id:ref.id,weight:ref.weight,score:report.audits[ref.id].score,mode:report.audits[ref.id].scoreDisplayMode,details:report.audits[ref.id].details}));
  assert.ok(!audits.some(a=>a.mode==='error'),'audit error');
  assert.equal(report.runWarnings.length,0,'Lighthouse warnings');
  assert.equal(audits.filter(a=>a.score!==null && a.score<1).length,0,'failed accessibility audits');
  metadata.runs.push({name,url,score,shell,delivered,lighthouseVersion:report.lighthouseVersion,environment:report.environment,configSettings:report.configSettings,runWarnings:report.runWarnings,failedAudits:audits.filter(a=>a.score!==null && a.score<1),reportSHA256:crypto.createHash('sha256').update(fs.readFileSync(`${prefix}.report.json`)).digest('hex')});
  console.log(name,score,metadata.runs.at(-1).failedAudits.map(a=>a.id));
}
fs.writeFileSync(`${out}/summary.json`,JSON.stringify(metadata,null,2));
assert.ok(metadata.runs.every(r=>r.score>=0.95),'below acceptance threshold');
```

Run from the pinned isolated checkout, using unused task-owned container names and ports:

```sh
set -eu
EVIDENCE=/absolute/path/to/scratch
REV=c8df3e08e8d81999178742f3f5256b4bbf7b0154
docker build -f Dockerfile.web --build-arg VITE_GIT_SHA="$REV" -t rocky-d03-web:c8df3e0 .
docker build -f "$EVIDENCE/Dockerfile.audit" -t rocky-d03-audit:c8df3e0 .
docker run -d --name rocky-d03-audit \
  --mount "type=bind,source=$EVIDENCE,target=/evidence" \
  -p 127.0.0.1:14380:8080 -p 127.0.0.1:14373:4173 \
  rocky-d03-audit:c8df3e0 sh /evidence/start.sh
# Require the backend and preview to respond before proceeding (bounded 30 seconds).
docker exec rocky-d03-audit node --input-type=module -e '
for (const url of ["http://127.0.0.1:4174/v1/health", "http://127.0.0.1:4173/"]) {
  let ready=false;
  for(let i=0;i<30;i++) {
    try { if((await fetch(url)).ok) {ready=true;break;} } catch {}
    await new Promise(r=>setTimeout(r,1000));
  }
  if(!ready) throw new Error("Startup failed: "+url);
}'
docker run -d --name rocky-d03-web --network container:rocky-d03-audit \
  -e API_UPSTREAM=127.0.0.1:4174 -e GATEWAY_UPSTREAM=127.0.0.1:4175 rocky-d03-web:c8df3e0
docker exec rocky-d03-web nginx -t
docker exec rocky-d03-audit node /evidence/reproduce.mjs
# Optional exact-asset control: copy image files, preview them, change the runner's
# cases to only ["preview-matched","http://127.0.0.1:4177/"] and use a separate out path.
docker cp rocky-d03-web:/usr/share/nginx/html "$EVIDENCE/production-dist"
docker cp "$EVIDENCE/production-dist" rocky-d03-audit:/production-dist
docker exec -d -w /app/packages/web rocky-d03-audit /app/node_modules/.bin/vite \
  preview --outDir /production-dist --port 4177 --host 127.0.0.1 --strictPort
# After reports have been copied/inspected, remove only these task-owned containers.
docker rm -f rocky-d03-web rocky-d03-audit
```

Infrastructure-negative control: changing the production URL to unused `127.0.0.1:65534` returned nonzero `ECONNREFUSED` before any report/summary; it receives no accessibility credit. A separate missing-report control replaced Lighthouse with `/bin/true` in scratch tooling: even with command exit0, reading the newly required report failed `ENOENT`, with no accepted summary. Earlier stopped Docker, CRLF shell startup and an invalid guest-board preflight assertion were corrected as setup-only failures; none was treated as RED accessibility or a passing run. No tests were skipped or counted through missing reports.

## Scope and remaining evidence

This closes only D03's historical production-web versus M6 accessibility discrepancy on the pinned source. No visual redesign, CSS change, performance work, accessibility expansion or historical-ledger rewrite occurred. A06 (manual screen-reader/RTL reading order/low vision/200% zoom), A07 (physical mobile/orientation/Firefox/Safari), O06 (deployment/cluster/TLS/email/passkeys) and O09 (full deployed gameplay journey) remain open evidence boundaries. Anonymous English default-theme `/` with an empty healthy lobby is the measured state; other locales/themes/auth/game routes and full durable upstreams are not certified.

Documentation-only changes follow CI's Markdown path exclusions; no unrelated heavy suite is required or claimed for this evidence PR. Exact-head Qodo/Greptile and PR-state acceptance are recorded in the PR handoff after they actually complete. The owner alone merges.

Greptile review correction: the first published head kept primary reports only locally and allowed nonempty warning/failed-audit lists when score≥0.95. The public snapshot now exposes the actual evidence, and the stricter runner enforces the clean observation. Its fresh production/preview pair passed **1.00/1.00**, zero failed audits/warnings/runtime errors. This changes only documented evidence/reproduction; no production behavior changed.
