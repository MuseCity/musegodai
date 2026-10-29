import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const origin = "http://127.0.0.1:5191";
const redirect = await fetch(origin + "/muses/bard", { redirect: "manual" });
assert.equal(redirect.status, 301, "Bard's name reference redirects with 301");
assert.equal(redirect.headers.get("location"), "/muses/1");
const session = "musegod-muses-" + process.pid;
process.env.AGENT_BROWSER_ARGS = "--force-prefers-reduced-motion";
const passed = [];
let opened = false;
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
function ready(condition) {
  evaluate(
    `(async()=>{const end=Date.now()+15000;while(!(${condition})){if(Date.now()>end)throw Error("Muse page did not become ready");await new Promise(r=>setTimeout(r,50));}return true})()`,
  );
}
function noErrors() {
  const errors = browser("errors");
  assert.ok(!errors.errors?.length, JSON.stringify(errors));
}
function keyboardReachable(selector) {
  // SSR cards exist before auth hydration replaces the loading neighborhood.
  // Tag only the stable visitor DOM, as in verify-seo-browser.mjs.
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
  keyboardReachable("#muse-checklist a, #muse-checklist button");
  passed.push(
    "301 name redirect, Bard heading, ten steps, canonical, public Agent post and checklist keyboard access",
  );
  noErrors();
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
  browser("set", "viewport", "375", "812");
  for (const path of ["/muses/1", "/muses", "/muses?filter=mine"]) {
    browser("open", origin + path);
    ready('document.querySelector(".muse-page, .muse-directory")');
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
  writeFileSync(
    ".local/muses-browser-verification.json",
    JSON.stringify(
      { passed, scope: "local browser with synthetic muse services" },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed }));
} finally {
  if (opened) browser("close");
}
