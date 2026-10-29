import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import { assertLocalTarget } from "../scripts/local-target.ts";

const origin = "http://127.0.0.1:5191";
const redirect = await fetch(origin + "/muses/bard", { redirect: "manual" });
assert.equal(redirect.status, 301, "Bard's name reference redirects with 301");
assert.equal(redirect.headers.get("location"), "/muses/1");
const session = "musegod-muses-" + process.pid;
process.env.AGENT_BROWSER_ARGS = "--force-prefers-reduced-motion";
const passed = [];
const responsiveLayouts = [];
let opened = false;
let db;
let keeperFixture;
async function api(path, body, token = "fixture:alice") {
  const response = await fetch(origin + "/api/v1" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.ok(response.ok, path + " returned " + response.status);
  return response.json();
}
async function prepareKeeperFixture() {
  const local = JSON.parse(readFileSync(".local/database.json", "utf8"));
  assertLocalTarget(local.e2eAdminUrl, "musecity_e2e", "musecity_admin");
  db = new pg.Client({ connectionString: local.e2eAdminUrl });
  await db.connect();
  const alice = await api("/me");
  const bindings = await db.query(
    "SELECT id FROM musecity.muse_bindings WHERE token_id=1 AND ended_at IS NULL",
  );
  assert.ok(
    bindings.rows.every((row) => row.id === "muse-task11-binding"),
    "keeper test refuses to replace an unrelated active Bard binding",
  );
  keeperFixture = {
    accountId: alice.id,
    handle: alice.handle,
    joinedAt: alice.joinedAt,
    onboarding: (
      await db.query(
        "SELECT * FROM musecity.account_onboarding WHERE account_id=$1",
        [alice.id],
      )
    ).rows[0],
    started: new Date(),
    legacy: bindings.rows.length > 0,
  };
  await db.query("UPDATE musecity.accounts SET joined_at=NULL WHERE id=$1", [
    alice.id,
  ]);
  await db.query(
    "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='restarted' WHERE id='muse-task11-binding' AND ended_at IS NULL",
  );
}
async function restoreKeeperFixture() {
  if (!keeperFixture) return;
  await db.query("BEGIN");
  try {
    // Keep a failed teardown atomic, and delete only this bounded run's rows.
    const created = await db.query(
      "SELECT id,agent_id,registration_id FROM musecity.muse_bindings WHERE token_id=1 AND account_id=$1 AND started_at >= $2",
      [keeperFixture.accountId, keeperFixture.started],
    );
    for (const row of created.rows) {
      await db.query(
        "DELETE FROM musecity.activity WHERE owner_account_id=$1 AND created_at >= $2 AND (agent_id=$3 OR resource_id=ANY($4::text[]))",
        [
          keeperFixture.accountId,
          keeperFixture.started,
          row.agent_id,
          [row.id, row.registration_id, row.agent_id].filter(Boolean),
        ],
      );
      await db.query("DELETE FROM musecity.muse_bindings WHERE id=$1", [
        row.id,
      ]);
      await db.query("DELETE FROM musecity.registrations WHERE id=$1", [
        row.registration_id,
      ]);
      if (row.agent_id) {
        await db.query("DELETE FROM musecity.posts WHERE agent_id=$1", [
          row.agent_id,
        ]);
        await db.query("DELETE FROM musecity.credentials WHERE agent_id=$1", [
          row.agent_id,
        ]);
        await db.query("DELETE FROM musecity.agents WHERE id=$1", [
          row.agent_id,
        ]);
      }
    }
    await db.query("UPDATE musecity.accounts SET joined_at=$2 WHERE id=$1", [
      keeperFixture.accountId,
      keeperFixture.joinedAt,
    ]);
    const onboarding = keeperFixture.onboarding;
    if (onboarding)
      await db.query(
        "UPDATE musecity.account_onboarding SET started_at=$2,introduction_post_id=$3,hello_skipped=$4,muse_skipped=$5,finished_at=$6 WHERE account_id=$1",
        [
          keeperFixture.accountId,
          onboarding.started_at,
          onboarding.introduction_post_id,
          onboarding.hello_skipped,
          onboarding.muse_skipped,
          onboarding.finished_at,
        ],
      );
    else
      await db.query(
        "DELETE FROM musecity.account_onboarding WHERE account_id=$1",
        [keeperFixture.accountId],
      );
    if (keeperFixture.legacy)
      await db.query(
        "UPDATE musecity.muse_bindings SET ended_at=NULL,end_reason=NULL WHERE id='muse-task11-binding'",
      );
    await db.query("COMMIT");
  } catch (cause) {
    await db.query("ROLLBACK");
    throw cause;
  }
}
function browser(...args) {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  assert.ok(result.success, result.error);
  return result.data;
}
const evaluate = (code) => browser("eval", code).result;
function ready(condition, timeout = 15000) {
  evaluate(
    `(async()=>{const end=Date.now()+${timeout};while(!(${condition})){if(Date.now()>end)throw Error("Muse page did not become ready");await new Promise(r=>setTimeout(r,50));}return true})()`,
  );
}
function noErrors() {
  const errors = browser("errors");
  assert.ok(!errors.errors?.length, JSON.stringify(errors));
}
function actionFails(button, action, operation, code, copy) {
  evaluate(`window.__museActionError=${JSON.stringify({ operation, code })}`);
  browser("click", button);
  if (operation === "signatures") {
    ready('document.querySelector("dialog")');
    browser("click", '[data-testid="approve-muse-signature"]');
  }
  ready(
    `document.querySelector('[data-muse-action-error="${action}"]')?.textContent.includes(${JSON.stringify(copy)}) && !document.querySelector(${JSON.stringify(button)}).disabled`,
  );
  assert.equal(
    evaluate(
      `document.querySelector(${JSON.stringify(button)}).nextElementSibling?.dataset.museActionError`,
    ),
    action,
    "the error is next to the action that failed",
  );
  assert.ok(
    evaluate(
      `document.querySelector('[data-muse-action-error="${action}"]').textContent.includes(${JSON.stringify(copy)})`,
    ),
  );
  assert.equal(
    evaluate('document.body.textContent.includes("INJECTED RAW ERROR")'),
    false,
  );
}
function pollCounts() {
  return evaluate(
    "({keeper:window.__museReads,public:window.__musePublicReads,feed:window.__museFeedReads})",
  );
}
function idlePolling(reason) {
  evaluate(`(async()=>{
    const end=Date.now()+15000;
    let snapshot=JSON.stringify([window.__museReads,window.__musePublicReads,window.__museFeedReads]);
    let stable=Date.now();
    while(Date.now()-stable<200||window.__museInFlight.keeper||window.__museInFlight.public||window.__museFeedInFlight){
      if(Date.now()>end)throw Error('Muse reads did not settle');
      await new Promise(r=>setTimeout(r,25));
      const next=JSON.stringify([window.__museReads,window.__musePublicReads,window.__museFeedReads]);
      if(next!==snapshot){snapshot=next;stable=Date.now()}
    }
    return true;
  })()`);
  const before = pollCounts();
  evaluate(
    "(async()=>{window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));await new Promise(r=>setTimeout(r,5500));return true})()",
  );
  assert.deepEqual(pollCounts(), before, reason);
}
function settleLayout() {
  ready(
    '[...document.querySelectorAll("button")].some(button=>button.textContent==="Join"&&!button.disabled)',
  );
  evaluate(
    "(async()=>{window.scrollTo(0,0);await document.fonts.ready;await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);return true})()",
  );
}
function shortEvidenceLinks() {
  const links = evaluate(
    `([...document.querySelectorAll('.muse-step-meta a')].map(link=>({local:link.getAttribute('href').startsWith('/'),text:link.textContent.trim(),name:link.getAttribute('aria-label'),step:link.closest('.muse-step').querySelector('.muse-step-title b').textContent})))`,
  );
  assert.ok(
    links.some((link) => link.local),
    "local post evidence is present",
  );
  assert.ok(
    links.some((link) => !link.local),
    "external profile evidence is present",
  );
  for (const link of links) {
    assert.equal(link.text, link.local ? "View post" : "View profile ↗");
    assert.equal(
      link.name,
      `${link.local ? "View post" : "View profile"}: ${link.step}`,
    );
  }
}
function keyboardReachable(selector, signedIn = false) {
  // SSR cards exist before auth hydration replaces the loading neighborhood.
  // Tag only the stable visitor DOM, as in verify-seo-browser.mjs.
  if (!signedIn)
    ready(
      '[...document.querySelectorAll("button")].some(button=>button.textContent==="Join"&&!button.disabled)',
    );
  const count = evaluate(
    `(()=>{const targets=[...document.querySelectorAll(${JSON.stringify(selector)})];window.__museTabSeen=[];targets.forEach((el,i)=>{el.dataset.tabCheck=String(i);const name=el.getAttribute('aria-label')||[...(el.getAttribute('aria-labelledby')||'').split(' ')].map(id=>document.getElementById(id)?.textContent||'').join(' ').trim()||el.textContent.trim()||el.querySelector('img')?.alt;if(!name)throw Error('Unnamed control '+i);});document.addEventListener('focusin',e=>{const id=e.target.dataset.tabCheck;if(id!==undefined&&!window.__museTabSeen.includes(id))window.__museTabSeen.push(id)});document.activeElement?.blur();return {targets:targets.length,all:document.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex="0"]').length}})()`,
  );
  // Real Tab presses prove reachability; calling .focus() would not.
  for (let i = 0; i <= count.all + 2; i++) browser("press", "Tab");
  assert.equal(evaluate("window.__museTabSeen.length"), count.targets);
}
try {
  browser("open", origin + "/muses/bard");
  opened = true;
  ready(
    'location.pathname==="/muses/1" && document.querySelectorAll(".muse-step").length===10',
  );
  assert.deepEqual(
    evaluate('[...document.querySelectorAll("h1")].map(h=>h.textContent)'),
    ["Bard"],
  );
  assert.equal(
    evaluate('document.querySelector("link[rel=canonical]").href'),
    origin + "/muses/1",
  );
  assert.ok(
    evaluate(
      'document.querySelector(".muse-posts").textContent.includes("hello, neighbors")',
    ),
  );
  shortEvidenceLinks();
  assert.equal(
    evaluate(
      'document.querySelector(".muse-posts .resident-byline a.content-badge")?.getAttribute("href")',
    ),
    "/muses/1",
  );
  keyboardReachable("#muse-checklist a, #muse-checklist button");
  passed.push(
    "301 name redirect, Bard heading, ten steps, canonical, public Agent post, short evidence labels with descriptive accessible names and checklist keyboard access",
  );
  noErrors();
  browser("open", origin + "/neighbors?view=agents&q=Bard");
  ready('document.querySelector(".neighbor-card a.content-badge")');
  assert.equal(
    evaluate(
      'document.querySelector(".neighbor-card a.content-badge").textContent.trim()',
    ),
    "muse #1",
  );
  browser("open", origin + "/u/muse-task11-keeper");
  ready('document.querySelector(".public-agent a.content-badge")');
  assert.equal(
    evaluate(
      'document.querySelector(".public-agent a.content-badge").getAttribute("href")',
    ),
    "/muses/1",
  );
  passed.push(
    "public post byline, Agent directory card and household Agent card link the active muse badge to Bard",
  );
  browser("open", origin + "/muses");
  ready('document.querySelectorAll(".muse-card").length===999');
  keyboardReachable(".muse-directory a, .muse-directory button");
  browser("fill", "#muse-search", "bard");
  browser("click", '.muse-search button[type="submit"]');
  ready('location.pathname==="/muses/1"');
  passed.push(
    "999 muse cards and every directory link/button reachable with Tab; exact-name search opens Bard",
  );
  noErrors();
  for (const width of [375, 768, 819]) {
    browser("set", "viewport", String(width), "812");
    browser("open", origin + "/muses/1");
    ready('document.querySelector(".muse-progress [role=progressbar]")');
    settleLayout();
    // Local fixture controls occupy extra space above the production header.
    // Measure initial-view visibility without that test-only chrome.
    const layout = evaluate(
      `(()=>{const fixtureOffset=[...document.querySelectorAll('[data-testid="fixture-banner"], [data-testid="wallet-fixture-controls"]')].reduce((sum,el)=>sum+el.getBoundingClientRect().height,0);const bounds=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {width:r.width,top:r.top-fixtureOffset,bottom:r.bottom-fixtureOffset}};return {width:innerWidth,height:innerHeight,fixtureOffset,art:bounds('.muse-art'),name:bounds('#muse-name'),progress:bounds('.muse-progress')}})()`,
    );
    assert.equal(layout.width, width);
    assert.ok(layout.art.width <= 220, `${width}px muse art is at most 220px`);
    assert.ok(
      layout.name.top >= 0 && layout.name.bottom <= layout.height,
      `${width}px muse name is visible on initial view`,
    );
    assert.ok(
      layout.progress.top >= 0 && layout.progress.bottom <= layout.height,
      `${width}px setup progress is visible on initial view`,
    );
    shortEvidenceLinks();
    responsiveLayouts.push(layout);
    noErrors();
  }
  passed.push(
    "375/768/819px art is at most 220px; name/setup progress fit the production viewport after excluding local fixture controls",
  );
  browser("set", "viewport", "375", "812");
  for (const path of ["/muses/1", "/muses", "/muses?filter=mine"]) {
    browser("open", origin + path);
    ready('document.querySelector(".muse-page, .muse-directory")');
    settleLayout();
    assert.ok(
      evaluate("document.documentElement.scrollWidth<=375"),
      path + " has no mobile overflow",
    );
    assert.equal(
      evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'),
      true,
    );
    assert.equal(
      evaluate(
        'document.getAnimations().filter(a=>a.playState==="running").length',
      ),
      0,
    );
    noErrors();
  }
  assert.equal(
    evaluate('document.querySelectorAll(".muse-card").length'),
    0,
    "anonymous Mine never paints public cards",
  );
  assert.ok(
    evaluate(
      'document.body.textContent.includes("Sign in to find your muses")',
    ),
  );
  passed.push(
    "375px detail/directory/Mine have no overflow, reduced motion has no running animations, anonymous Mine has sign-in prompt",
  );
  await prepareKeeperFixture();
  evaluate("sessionStorage.setItem('musecity.fixture-user','alice')");
  await db.query("UPDATE musecity.accounts SET joined_at=now() WHERE id=$1", [
    keeperFixture.accountId,
  ]);
  await db.query(
    "INSERT INTO musecity.account_onboarding(account_id,hello_skipped,muse_skipped,finished_at) VALUES($1,true,true,now()) ON CONFLICT(account_id) DO UPDATE SET hello_skipped=true,muse_skipped=true,finished_at=now()",
    [keeperFixture.accountId],
  );
  browser("set", "viewport", "1440", "1000");
  browser("open", origin + "/");
  ready(
    '[...document.querySelectorAll(".welcome-note a")].some(a=>a.textContent.includes("Wake up Bard"))',
  );
  assert.ok(
    evaluate(
      '![...document.querySelectorAll(".welcome-note")].some(note=>note.textContent.includes("Set up your home, then explore"))',
    ),
    "a finished move-in still receives the unstarted muse reminder",
  );
  browser("open", origin + "/me/home");
  ready(
    'document.querySelector("#your-muses-heading") && document.querySelector("[role=progressbar]")',
  );
  assert.equal(
    evaluate(
      'document.querySelector("a[aria-label=\"Continue setting up Bard\"]").getAttribute("href")',
    ),
    "/muses/1",
  );
  assert.equal(
    Number(
      evaluate(
        'document.querySelector("[role=progressbar]").getAttribute("aria-valuenow")',
      ),
    ),
    (await api("/me/muses"))[0].done,
  );
  keyboardReachable('a[aria-label="Continue setting up Bard"]', true);
  browser("open", origin + "/move-in");
  ready(
    'document.querySelector(".move-in-steps li:nth-child(3) button:not([disabled])")',
  );
  browser("click", ".move-in-steps li:nth-child(3) button");
  ready(
    '[...document.querySelectorAll("a")].some(a=>a.textContent==="You hold Bard #1 — set it up")',
  );
  assert.equal(
    evaluate(
      '[...document.querySelectorAll("a")].find(a=>a.textContent==="You hold Bard #1 — set it up").getAttribute("href")',
    ),
    "/muses/1",
  );
  browser("open", origin + "/");
  ready(
    '[...document.querySelectorAll(".welcome-note a")].some(a=>a.textContent.includes("Wake up Bard"))',
  );
  evaluate(
    `(()=>{const read=window.fetch;window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/v1/me/muses'?Promise.resolve(Response.json({error:{code:'LOCAL_MUSE_FAILURE',message:'Local muses unavailable.'}},{status:503})):read(input,init);return true})()`,
  );
  browser("click", 'a[href="/me/home"]');
  ready('location.pathname==="/u/' + keeperFixture.handle + '"');
  assert.equal(
    evaluate('document.body.textContent.includes("Local muses unavailable.")'),
    false,
    "a muse lookup failure redirects to the public home without showing the muses error",
  );
  browser("open", origin + "/");
  ready(
    '[...document.querySelectorAll(".welcome-note a")].some(a=>a.textContent.includes("Wake up Bard"))',
  );
  browser("click", '[data-testid="fixture-banner"] button');
  ready('document.querySelector(".welcome-note a[href=\"/muses/1\"]")===null');
  browser("open", origin + "/me/home");
  ready('location.pathname.startsWith("/u/")');
  assert.equal(evaluate('document.querySelector("#your-muses-heading")'), null);
  browser("open", origin + "/muses/1");
  ready(
    'document.querySelector(".muse-keeper-refresh")?.textContent.includes("Recheck keeper wallet")',
  );
  assert.equal(
    evaluate(
      'document.querySelector(".muse-visitor-cta").textContent.includes("Sign in")',
    ),
    false,
    "signed-in non-keepers are asked to link a wallet, not sign in",
  );
  assert.ok(
    evaluate(
      'document.querySelector(".muse-visitor-cta").textContent.includes("Link the wallet that holds it")',
    ),
  );
  assert.equal(
    evaluate(
      'document.querySelector(".muse-visitor-cta a").getAttribute("href")',
    ),
    "/muses?filter=mine",
  );
  evaluate("sessionStorage.setItem('musecity.fixture-user','alice')");
  await db.query("UPDATE musecity.accounts SET joined_at=NULL WHERE id=$1", [
    keeperFixture.accountId,
  ]);
  passed.push(
    "all holder entry points: Move-in setup link, private home progress/Continue, completed-move-in Square reminder, public-home navigation during muse read failure, and no holder UI after switching to a nonholder",
  );
  browser("set", "viewport", "375", "812");
  browser("open", origin + "/muses/1");
  ready('document.querySelector(".muse-start")');
  assert.ok(
    evaluate(
      'document.querySelector(".muse-start").textContent.includes("Finish your profile so Bard\'s card and posts show on its page")',
    ),
  );
  assert.equal(
    evaluate(
      'document.querySelector(".muse-start a[href=\"/move-in\"]").getAttribute("href")',
    ),
    "/move-in",
  );
  evaluate(
    `(()=>{
      window.__museCopies=[];window.__museStarts=0;window.__museReads=0;
      window.__musePublicReads=0;window.__museFeedReads=0;window.__museConnectionStatus=null;
      window.__museConnectionState=null;window.__museFeedInFlight=0;
      window.__museFail=false;window.__museDeny=false;window.__museLimit=false;
      window.__museActionError=null;
      window.__museDelay=0;window.__museDelayError=false;
      window.__museInFlight={keeper:0,public:0};window.__museMaxInFlight={keeper:0,public:0};
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__museCopies.push(text)}}});
      window.__museFetch=window.fetch;
      window.fetch=async(input,init)=>{
        const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
        const kind=path==='/api/v1/me/muses/1'?'keeper':path==='/api/v1/muses/1'?'public':null;
        if(kind==='public')window.__musePublicReads++;
        if(path==='/api/v1/feed'){window.__museFeedReads++;window.__museFeedInFlight++}
        const delay=kind?window.__museDelay:0;
        if(kind){window.__museInFlight[kind]++;window.__museMaxInFlight[kind]=Math.max(window.__museMaxInFlight[kind],window.__museInFlight[kind])}
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        try{
          if(delay&&window.__museDelayError&&kind==='public')return Response.json({error:{code:'LOCAL_DELAY_FAILURE',message:'Local delayed refresh unavailable.'}},{status:503});
          if(path==='/api/v1/me/muses/1'){
            window.__museReads++;
            if(window.__museFail)return Response.json({error:{code:'LOCAL_TEST_FAILURE',message:'Local keeper refresh unavailable.'}},{status:503});
            if(window.__museDeny)return Response.json({error:{code:'NOT_MUSE_KEEPER',message:'Not the keeper.'}},{status:403});
            if(window.__museLimit||window.__museConnectionStatus){const response=await window.__museFetch(input,init);const data=await response.json();if(window.__museLimit)data.agentLimitReached=true;if(window.__museConnectionStatus&&data.binding?.connection)data.binding.connection.status=window.__museConnectionStatus;window.__museConnectionState=data.binding?.connection?.status;return Response.json(data,{status:response.status})}
          }
          if(init?.method==='POST'&&window.__museActionError&&path==='/api/v1/me/muses/1/'+window.__museActionError.operation)return Response.json({error:{code:window.__museActionError.code,message:'INJECTED RAW ERROR'}},{status:window.__museActionError.code==='NOT_MUSE_KEEPER'?403:409});
          if(path==='/api/v1/me/muses/1/start'&&init?.method==='POST')window.__museStarts++;
          return await window.__museFetch(input,init);
        }finally{if(kind)window.__museInFlight[kind]--;if(path==='/api/v1/feed')window.__museFeedInFlight--}
      };return true
    })()`,
  );
  assert.equal(
    evaluate(
      'document.querySelectorAll(".muse-needs [data-muse-sign]").length',
    ),
    0,
    "an unstarted keeper has no signing action",
  );
  idlePolling("an unstarted keeper and public page do not poll");
  evaluate("window.__museLimit=true");
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.querySelector(".muse-start").textContent.includes("Your account has 20 Agents.")',
  );
  assert.equal(
    evaluate(
      'document.querySelectorAll(".muse-start [data-muse-copy]").length',
    ),
    0,
    "a new start at the Agent limit offers no copy action",
  );
  evaluate("window.__museLimit=false");
  browser("click", ".muse-keeper-refresh");
  ready('document.querySelector(".muse-start [data-muse-copy=line]")');
  const actionErrors = [
    ["MUSE_KEPT_ELSEWHERE", "Bard is already set up by another account."],
    [
      "AGENT_LIMIT",
      "Your account has 20 Agents. Remove one in My agents to wake Bard.",
    ],
    ["NOT_MUSE_KEEPER", "Holding Bard? Link the wallet that holds it"],
    [
      "LOCAL_ACTION_FAILURE",
      "Can't update Bard's setup right now. Please try again.",
    ],
  ];
  for (const [code, copy] of actionErrors)
    actionFails('[data-muse-copy="line"]', "copy-line", "start", code, copy);
  actionFails(
    '[data-muse-copy="full"]',
    "copy-full",
    "start",
    ...actionErrors[3],
  );
  evaluate("window.__museActionError=null");
  browser("click", ".muse-start [data-muse-copy=line]");
  ready("window.__museCopies.length===1");
  assert.ok(
    evaluate(
      'window.__museCopies[0].includes("/muses/1/start.md with code mcr_")',
    ),
  );
  browser("click", ".muse-start [data-muse-copy=line]");
  ready("window.__museCopies.length===2");
  assert.equal(
    evaluate("window.__museStarts"),
    1,
    "copy reuses the live one-use code",
  );
  assert.equal(
    evaluate("window.__museCopies[0]===window.__museCopies[1]"),
    true,
  );
  browser("click", ".muse-start [data-muse-copy=full]");
  ready("window.__museCopies.length===3");
  assert.ok(
    evaluate('window.__museCopies[2].includes("\\n\\nYour code: mcr_")'),
  );
  assert.equal(
    evaluate("window.__museStarts"),
    1,
    "full setup reuses the same code",
  );
  const waitingCounts = pollCounts();
  evaluate(
    "(async()=>{await new Promise(r=>setTimeout(r,5500));return true})()",
  );
  assert.ok(
    pollCounts().keeper > waitingCounts.keeper,
    "a live code polls for Bard",
  );
  assert.equal(
    pollCounts().feed,
    waitingCounts.feed,
    "unchanged steps never reload the feed on a polling tick",
  );
  actionFails(
    ".muse-start [data-muse-replace]",
    "replace",
    "start",
    ...actionErrors[0],
  );
  idlePolling(
    "a failed replacement stops all automatic reads even with a live code",
  );
  evaluate("window.__museActionError=null");
  browser("click", '[data-muse-copy="line"]');
  ready('!document.querySelector("[data-muse-action-error]")');
  const credential = await api(
    "/agent-connections",
    {
      otp: evaluate("window.__museCopies[0].match(/with code (mcr_\\S+)/)[1]"),
    },
    "",
  );
  const agentToken = credential.credential.token;
  ready(
    'document.querySelector(".muse-start").textContent.includes("waiting for your AI to verify")',
  );
  const verificationCounts = pollCounts();
  evaluate(
    "(async()=>{await new Promise(r=>setTimeout(r,5500));return true})()",
  );
  assert.ok(
    pollCounts().keeper > verificationCounts.keeper,
    "a redeemed code polls while Bard has not verified",
  );
  await api("/agent", undefined, agentToken);
  await api(
    "/agent/muse/reports",
    { step: "soul", status: "done" },
    agentToken,
  );
  await api(
    "/agent/muse/reports",
    {
      step: "terrakin",
      status: "done",
      url: "https://terrakin.org/r/r_abcdef0123456789",
    },
    agentToken,
  );
  await api(
    "/agent/muse/reports",
    {
      step: "musebook",
      status: "done",
      url: "https://musebook.me/task12-bard",
    },
    agentToken,
  );
  ready(
    'document.querySelector(".muse-needs").textContent.includes("Confirm where Bard lives") && document.querySelector("[data-muse-sign=places]")?.textContent.trim()==="Sign 2"',
  );
  ready(
    'document.querySelectorAll("#muse-checklist .muse-step")[0]?.dataset.status==="done" && document.querySelectorAll("#muse-checklist .muse-step")[2]?.dataset.status==="done"',
  );
  ready(
    '!document.querySelector(".muse-start textarea")?.value.includes("mcr_")',
  );
  assert.equal(
    evaluate(
      'location.href.includes("mcr_") || /mcr_/.test(Object.values(sessionStorage).join(" ")+Object.values(localStorage).join(" "))',
    ),
    false,
    "the code never enters browser storage or the URL",
  );
  await db.query("UPDATE musecity.accounts SET joined_at=now() WHERE id=$1", [
    keeperFixture.accountId,
  ]);
  await api(
    "/posts",
    { kind: "update", text: "Task 12 synthetic Bard hello after connection." },
    agentToken,
  );
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.querySelector(".muse-posts").textContent.includes("Task 12 synthetic Bard hello after connection.")',
  );
  ready(
    'document.querySelector(".muse-posts button[aria-label=Like]") && !document.querySelector(".muse-posts button[aria-label=Like]").disabled',
  );
  for (const [code, copy] of actionErrors)
    actionFails(
      ".muse-start button[data-muse-restart]",
      "restart",
      "restart",
      code,
      copy,
    );
  for (const [code, copy] of actionErrors)
    actionFails(
      '[data-muse-sign="places"]',
      "places",
      "signatures",
      code,
      copy,
    );
  evaluate("window.__museActionError=null");
  browser("click", '.muse-posts button[aria-label="Like"]');
  ready(
    'document.querySelector(".muse-posts button[aria-label=Like]").getAttribute("aria-pressed")==="true"',
  );
  browser("click", ".muse-needs [data-muse-sign=places]");
  ready(
    'document.querySelector("dialog")?.textContent.includes("Local muse signature") && document.querySelector("dialog").textContent.includes("https://musebook.me/task12-bard")',
  );
  browser("click", '[data-testid="approve-muse-signature"]');
  ready(
    'document.querySelector("dialog")?.textContent.includes("https://terrakin.org/r/r_abcdef0123456789")',
  );
  browser("click", '[data-testid="approve-muse-signature"]');
  ready(
    '!document.querySelector("dialog") && document.querySelector(".muse-needs").textContent.includes("2 sending…")',
  );
  const order = evaluate(
    "['.muse-start','.muse-needs','#muse-checklist','.muse-posts'].map(selector=>document.querySelector(selector).getBoundingClientRect().top)",
  );
  assert.ok(
    order.every((top, i) => i === 0 || top > order[i - 1]),
    "375px order is start, Needs you, checklist, posts",
  );
  assert.ok(evaluate("document.documentElement.scrollWidth<=375"));
  keyboardReachable(
    ".muse-start a, .muse-start button:not([disabled]), .muse-needs a, .muse-needs button:not([disabled])",
    true,
  );
  evaluate("window.__museFail=true");
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.querySelector(".muse-keeper-error")?.textContent.includes("Local keeper refresh unavailable.")',
  );
  const reads = evaluate("window.__museReads");
  evaluate(
    "(async()=>{await new Promise(r=>setTimeout(r,5500));return true})()",
  );
  assert.equal(
    evaluate("window.__museReads"),
    reads,
    "polling stops after a refresh error",
  );
  evaluate("window.__museFail=false");
  browser("click", ".muse-keeper-refresh");
  ready('!document.querySelector(".muse-keeper-error")');
  assert.ok(evaluate("window.__museReads") > reads, "manual refresh recovers");
  evaluate("window.__museDeny=true");
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.body.textContent.includes("Holding Bard? Link the wallet that holds it")',
  );
  assert.equal(
    evaluate(
      'document.querySelector(".muse-keeper-refresh").textContent.trim()',
    ),
    "Recheck keeper wallet",
  );
  evaluate("window.__museDeny=false");
  browser("click", ".muse-keeper-refresh");
  ready('document.querySelector(".muse-start")');
  evaluate("window.__museLimit=true");
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.querySelector(".muse-start").textContent.includes("Bard is connected.")',
  );
  assert.equal(
    evaluate(
      'document.querySelector(".muse-start").textContent.includes("Remove one")',
    ),
    false,
    "the twentieth connected Agent retains its connected state",
  );
  evaluate("window.__museLimit=false");
  idlePolling("a connected binding stops automatic reads");
  for (const status of ["expired", "cancelled", "paused", "revoked"]) {
    const before = pollCounts().keeper;
    evaluate(`window.__museConnectionStatus=${JSON.stringify(status)}`);
    browser("click", ".muse-keeper-refresh");
    ready(
      `window.__museReads>${before} && window.__museConnectionState===${JSON.stringify(status)}`,
    );
    idlePolling(status + " connections do not poll");
  }
  evaluate('window.__museConnectionStatus="awaiting_verification"');
  browser("click", ".muse-keeper-refresh");
  ready(
    'document.querySelector(".muse-start").textContent.includes("waiting for your AI to verify")',
  );
  evaluate(
    "window.__museDelay=6000;window.__museMaxInFlight={keeper:0,public:0}",
  );
  await api(
    "/agent/muse/reports",
    { step: "x", status: "needs_you", code: "verification_code" },
    agentToken,
  );
  await api(
    "/posts",
    { kind: "update", text: "Task 12 slow background refresh appeared." },
    agentToken,
  );
  await api(
    "/agent/muse/reports",
    { step: "look", status: "done" },
    agentToken,
  );
  ready(
    'document.querySelector(".muse-needs").textContent.includes("Answer Muse\'s question") && document.querySelector(".muse-posts").textContent.includes("Task 12 slow background refresh appeared.")',
    25000,
  );
  assert.deepEqual(
    evaluate("window.__museMaxInFlight"),
    { keeper: 1, public: 1 },
    "six-second background reads finish without overlap or starvation",
  );
  evaluate("window.__museDelayError=true");
  ready(
    'document.querySelector(".muse-keeper-error")?.textContent.includes("Local delayed refresh unavailable.") && document.querySelector(".muse-public-error")?.textContent.includes("Local delayed refresh unavailable.")',
    25000,
  );
  evaluate("window.__museDelay=0;window.__museDelayError=false");
  browser("click", ".muse-keeper-refresh");
  ready(
    '!document.querySelector(".muse-keeper-error") && !document.querySelector(".muse-public-error")',
  );
  passed.push(
    "Alice keeper: missing-profile note, OTP line/full copy and reuse without storage, live public progress/posts with signed-in actions, connected Agent report, sequential simulated signing, queued sending state, mobile order, keyboard controls, polling error/manual recovery, keeper recheck, new/connected Agent-limit states and six-second background success/error without overlap",
  );
  browser("open", origin + "/");
  ready('document.querySelector(".community-stream")');
  assert.ok(
    evaluate(
      '![...document.querySelectorAll(".welcome-note")].some(note=>note.textContent.includes("Wake up Bard"))',
    ),
    "an existing binding suppresses the wake-up reminder",
  );
  browser(
    "open",
    origin + "/u/" + keeperFixture.handle + "?agent=" + credential.agentId,
  );
  ready(
    'document.querySelector(".public-agent a.content-badge") && document.querySelector(".community-stream,.home-stream")',
  );
  assert.equal(
    evaluate(
      'document.querySelector(".public-agent a.content-badge").getAttribute("href")',
    ),
    "/muses/1",
  );
  const ended = await db.query(
    "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='transferred' WHERE token_id=1 AND account_id=$1 AND agent_id=$2 AND started_at >= $3 AND ended_at IS NULL RETURNING id",
    [keeperFixture.accountId, credential.agentId, keeperFixture.started],
  );
  assert.equal(
    ended.rowCount,
    1,
    "end only the binding created by this bounded browser run",
  );
  browser("open", origin + "/u/" + keeperFixture.handle);
  ready(
    'document.querySelector(".public-agent") && document.querySelector(".home-stream .resident-byline")',
  );
  assert.equal(
    evaluate(
      'document.querySelectorAll(".public-agent a.content-badge,.home-stream .resident-byline a.content-badge").length',
    ),
    0,
    "ending the binding removes both badges while preserving the Agent and posts",
  );
  passed.push(
    "started bindings have no wake-up reminder; ending this run's binding removes the Agent-card and historical post badges without removing content",
  );
  writeFileSync(
    ".local/muses-browser-verification.json",
    JSON.stringify(
      {
        passed,
        responsiveLayouts,
        scope: "local browser with synthetic muse services",
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed }));
} finally {
  try {
    await restoreKeeperFixture();
  } finally {
    await db?.end();
    if (opened) browser("close");
  }
}
