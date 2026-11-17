import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { readFrontendSource } from './helpers/read-frontend-source.mjs';

const html = readFrontendSource();
const mailboxTestHtml = readFileSync(new URL('../public/mailbox-alignment-test.html', import.meta.url), 'utf8');

test('mailbox alignment test page isolates the three visual layers', () => {
  assert.match(mailboxTestHtml, /assets\/counseling-room\.png/);
  assert.match(mailboxTestHtml, /assets\/mailbox-layered\.png/);
  assert.match(mailboxTestHtml, /id="mailboxHotspotTest"/);
  assert.match(mailboxTestHtml, /class="hotspot"/);
  assert.match(mailboxTestHtml, /background:transparent/);
  assert.doesNotMatch(mailboxTestHtml, /border:2px dashed rgba\(255,70,70/);
  assert.doesNotMatch(mailboxTestHtml, /background:rgba\(255,0,0,/);
  assert.doesNotMatch(mailboxTestHtml, />hotspot<\/span>/);
});

test('V2 consultation flow screens are present', () => {
  for (const id of [
    'landingScreen',
    'welcomeScreen',
    'roomScreen',
    'chatScreen',
    'summaryScreen',
    'historyScreen',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('final room exposes the mailbox and wall-art modal artwork', () => {
  assert.match(html, /id="mailboxHotspot"/);
  assert.match(html, /assets\/mailbox\.png/);
  assert.match(html, /aria-label="查看信箱"/);
  assert.match(html, /class="mailbox-hotspot"/);
  assert.match(html, /mailbox-hotspot:hover::after/);
  assert.match(html, /brightness\(1\.12\)/);
  assert.match(html, /room-coordinate-layer\{[^}]*z-index:20/);
  assert.match(html, /mailbox-artwork\{[^}]*z-index:21/);
  assert.match(html, /id="roomArtworkModal"/);
  assert.match(html, /data-room-modal-state="closed"/);
  assert.match(html, /assets\/mailbox-letters-ui\.png/);
  assert.match(html, /assets\/wall-art-reflection-ui\.png/);
  assert.doesNotMatch(html, /信件素材待接入/);
});

test('the first mailbox entry contains the approved pioneer letter', () => {
  assert.match(html, /class="mailbox-letter-interface"/);
  assert.match(html, /class="mailbox-letter-entry"[^>]*aria-selected="true"[^>]*>\s*第一封信\s*<\/button>/);
  assert.match(html, /class="mailbox-letter-title">性格不是命运，而是起点<\/h2>/);
  assert.match(html, /我们常常很擅长回答/);
  assert.match(html, /每一种性格，都拥有一条属于自己的成熟之路/);
  assert.match(html, /The Keeper of Your Inner Space/);
  const letterSource=html.match(/<article class="mailbox-letter-paper"[\s\S]*?<\/article>/)?.[0] || '';
  assert.doesNotMatch(letterSource, /这里/);
});

test('the pioneer letter is a mailbox-only readable overlay', () => {
  assert.match(html, /data-room-modal-kind="mailbox"\] \.mailbox-letter-interface\{opacity:1;pointer-events:auto\}/);
  assert.match(html, /\.mailbox-letter-entry\{[^}]*font-family:"STKaiti","KaiTi","Songti SC",serif/);
  assert.match(html, /\.mailbox-letter-paper\{[^}]*overflow-y:auto[^}]*scrollbar-width:none[^}]*font-family:var\(--consultation-dynamic-font\)/);
  assert.match(html, /\.mailbox-letter-paper\{[^}]*color:#000[^}]*font-size:clamp\(11px,1\.05vw,17px\)[^}]*font-weight:500[^}]*text-shadow:none/);
  assert.match(html, /\.mailbox-letter-title\{[^}]*color:#000/);
  assert.match(html, /\.mailbox-letter-question\{[^}]*color:#000/);
  assert.match(html, /\.mailbox-letter-signature\{[^}]*color:#000/);
  assert.match(html, /\.mailbox-letter-paper::-webkit-scrollbar\{display:none\}/);
});

test('room artwork modals contain the complete 3:2 artwork in every viewport', () => {
  assert.match(html, /\.room-modal-canvas\{[^}]*width:min\(100vw,150vh\);height:min\(66\.6667vw,100vh\)/);
  assert.doesNotMatch(html, /\.room-modal-canvas\{[^}]*width:max\(/);
});

test('each modal close glow is centered on the x drawn into its artwork', () => {
  assert.match(html, /data-room-modal-kind="wallArt"\] \.room-modal-close\{left:87\.3%;top:9\.5%\}/);
  assert.match(html, /data-room-modal-kind="mailbox"\] \.room-modal-close\{left:86\.1%;top:9\.8%\}/);
});

test('mailbox hover feedback is explicitly bridged from the hit area to the artwork layer', () => {
  assert.match(html, /data-mailbox-hover/);
  assert.match(html, /mailboxHotspot\.addEventListener\('pointerenter'/);
  assert.match(html, /mailboxHotspot\.addEventListener\('pointerleave'/);
  assert.match(html, /mailbox-hotspot\[data-mailbox-hover="true"\] ~ \.mailbox-artwork/);
  assert.match(html, /mailbox-hotspot\[data-mailbox-hover="true"\] ~ \.mailbox-shadow/);
});

test('V2 counseling copy keeps the product boundary visible', () => {
  assert.match(html, /不替代心理咨询、诊断或医疗建议/);
  assert.match(html, /欢迎回来/);
  assert.match(html, /开始咨询/);
  assert.doesNotMatch(html, /Welcome back\.|Start Consultation|Tell me what has been on your mind recently|Please find a quiet place/);
});

test('entrance reproduces the supplied artwork without redesigning it', () => {
  assert.match(html, /id="landingScreen"[^>]*class="[^"]*artwork-entry-screen/);
  assert.match(html, /id="artworkEntry"[^>]*data-entry-state="ready"/);
  assert.match(html, /id="entryArtwork"[^>]*src="assets\/counseling-entry-poster\.png"/);
  assert.match(html, /id="entryIntroVideo"[^>]*src="assets\/counseling-entry\.mp4"/);
  assert.match(html, /poster="assets\/counseling-entry-poster\.png"/);
  assert.doesNotMatch(html, /class="door-copy"/);
  assert.doesNotMatch(html, /class="door-room-preview"/);
  assert.doesNotMatch(html, /推开这扇门/);
});

test('final room uses the no-mailbox background and a separate mailbox overlay', () => {
  assert.match(html, /assets\/counseling-room-no-mailbox-no-books-no-picture\.png/);
  assert.match(html, /class="mailbox-artwork"[^>]*src="assets\/mailbox\.png"/);
});

test('final room uses the clean background and separate book and wall-art overlays', () => {
  assert.match(html, /assets\/counseling-room-no-mailbox-no-books-no-picture\.png/);
  assert.match(html, /id="bookHotspot"/);
  assert.match(html, /class="[^"]*book-artwork[^"]*"[^>]*src="assets\/book\.png"/);
  assert.match(html, /id="wallArtHotspot"/);
  assert.match(html, /class="[^"]*wall-art-artwork[^"]*"[^>]*src="assets\/wall-art\.png"/);
});

test('the supplied 3:2 consultation UI is fully contained instead of cropped', () => {
  assert.match(html, /\.consultation-ui-canvas\{[^}]*width:min\(100vw,150vh\);height:min\(66\.6667vw,100vh\)/);
  assert.match(html, /\.consultation-ui-canvas img\{[^}]*object-fit:fill/);
  assert.doesNotMatch(html, /\.consultation-ui-layer img\{[^}]*object-fit:cover/);
});

test('closing the consultation UI keeps the final room underneath and never reveals the door poster', () => {
  assert.match(html, /data-scene-state="consultation-closing"\] \.room-static-scene\{opacity:1\}/);
  assert.match(html, /data-scene-state="consultation-closing"\] \.room-poster-layer,[\s\S]*?data-scene-state="consultation-closing"\] \.room-intro-video\{opacity:0\}/);
  assert.match(html, /data-scene-state="consultation-closing"\] \.mailbox-artwork\{opacity:\.94\}/);
  assert.match(html, /data-scene-state="consultation-closing"\] \.room-object-artwork\{opacity:\.96\}/);
  assert.match(html, /data-scene-state="consultation-closing"\] \.room-loading-note\{opacity:0\}/);
});

test('the book opens a real four-section consultation shell with explore selected', () => {
  assert.match(html, /id="consultationUiLayer"[^>]*data-active-section="explore"/);
  for (const section of ['consultation-history', 'report-history', 'explore', 'profile']) {
    assert.match(html, new RegExp(`data-consultation-section="${section}"`));
    assert.match(html, new RegExp(`data-consultation-panel="${section}"`));
  }
  assert.match(html, /data-consultation-section="explore"[^>]*aria-selected="true"/);
  assert.doesNotMatch(html, />返回主页</);
});

test('every consultation section uses the same visible transition contract', () => {
  assert.match(html, /\.consultation-panel\{[^}]*opacity:0[^}]*transform:translateY\(6px\)[^}]*visibility:hidden/);
  assert.match(html, /\.consultation-panel\.is-active\{[^}]*opacity:1[^}]*transform:translateY\(0\)[^}]*visibility:visible/);
  assert.match(html, /@keyframes consultationNavSelect/);
  assert.match(html, /prefers-reduced-motion:reduce[\s\S]*?\.consultation-panel/);
});

test('the real composer reuses the input and send controls baked into the artwork', () => {
  assert.match(html, /\.consultation-composer\{[^}]*position:absolute[^}]*left:2\.9%[^}]*top:90\.5%[^}]*width:81\.8%[^}]*height:9%/);
  assert.match(html, /\.consultation-composer textarea\{[^}]*border:0[^}]*background:transparent[^}]*box-shadow:none/);
  assert.match(html, /\.consultation-send\{[^}]*border:0[^}]*background:transparent[^}]*color:transparent[^}]*box-shadow:none/);
});

test('the artwork-aligned composer has no prompt copy or native scrollbar arrows', () => {
  assert.doesNotMatch(html, /placeholder="最近有什么一直萦绕在你心里？"/);
  assert.match(html, /\.consultation-composer textarea\{[^}]*scrollbar-width:none/);
  assert.match(html, /\.consultation-composer textarea::-webkit-scrollbar\{display:none\}/);
});

test('dynamic consultation text uses a locally hosted LXGW WenKai font', () => {
  assert.match(html, /@import url\("\/assets\/fonts\/lxgw-wenkai\/lxgwwenkai-regular\.css"\)/);
  assert.match(html, /--consultation-dynamic-font:"LXGW WenKai","STKaiti","KaiTi","Songti SC",serif/);
  assert.match(html, /\.consultation-chat-stream,\.consultation-composer\{font-family:var\(--consultation-dynamic-font\)\}/);
  assert.doesNotMatch(html, /\.consultation-nav\{[^}]*font-family:var\(--consultation-dynamic-font\)/);
});

test('the consultation-end modal uses the approved generated artwork instead of CSS-drawn chrome', () => {
  assert.ok(existsSync(new URL('../public/assets/consultation-end-modal.png', import.meta.url)));
  assert.match(html, /<div class="consultation-end-modal-frame">[\s\S]*?<img class="consultation-end-modal-artwork"/);
  assert.match(html, /<img class="consultation-end-modal-artwork" src="assets\/consultation-end-modal\.png" alt="结束本次咨询">/);
  assert.match(html, /id="consultationEndModalCloseButton"[^>]*class="consultation-end-modal-hit-area consultation-end-modal-hit-close"[^>]*aria-label="关闭结束咨询窗口"/);
  assert.match(html, /id="consultationEndContinueButton"[^>]*class="consultation-end-modal-hit-area consultation-end-modal-hit-continue"[^>]*aria-label="继续咨询"/);
  assert.match(html, /id="consultationEndReportButton"[^>]*class="consultation-end-modal-hit-area consultation-end-modal-hit-report"[^>]*aria-label="保存并生成报告"/);
  assert.doesNotMatch(html, /\.consultation-end-modal-card\{/);
  assert.doesNotMatch(html, /\.consultation-end-botanical/);
});

test('the generated consultation-end artwork is reduced and its transparent controls give hover feedback', () => {
  assert.match(html, /\.consultation-end-modal\{[^}]*display:grid;place-items:center/);
  assert.match(html, /\.consultation-end-modal-frame\{[^}]*width:min\(88%,1360px\);aspect-ratio:3\/2/);
  assert.match(html, /\.consultation-end-modal-hit-area:hover,\.consultation-end-modal-hit-area:focus-visible\{[^}]*background:rgba\(235,179,77,\.08\);box-shadow:0 0 18px rgba\(234,178,72,\.24\)/);
  assert.match(html, /\.consultation-end-modal-hit-close\{[^}]*border-radius:50%/);
});

test('the final room reveals only the approved consultation chair interaction', () => {
  assert.match(html, /id="consultationChairHotspot"/);
  assert.match(html, /assets\/consultation-chair-mask\.png/);
  assert.match(html, /class="consultation-chair-label">开始咨询</);
  assert.match(html, /data-entry-state="ended"[^}]*consultation-chair-hotspot/);
  assert.doesNotMatch(html, /consultationChairHotspot\.addEventListener\('click'/);
});

test('existing chat is presented inside a bright counseling-room shell', () => {
  assert.match(html, /class="consulting-room-background"/);
  assert.match(html, /class="[^"]*consultation-desk/);
  assert.match(html, /class="room-window"/);
  assert.match(html, /class="room-chair"/);
  assert.match(html, /backdrop-filter:blur/);
  assert.match(html, /@media\(max-width:820px\)/);
});

test('entrance and API requests do not use an invite code', () => {
  assert.doesNotMatch(html, /\/api\/access/);
  assert.doesNotMatch(html, /x-invite-code/);
  assert.doesNotMatch(html, /TEST_INVITE_CODE/);
  assert.doesNotMatch(html, /id="invite"/);
  assert.doesNotMatch(html, /邀请码/);
});

test('the immersive room screen has no floating back arrow', () => {
  assert.doesNotMatch(html, /class="room-back-button"/);
  assert.doesNotMatch(html, /\.room-back-button\{/);
});

test('finishing the supplied door video hands off to the final room', () => {
  assert.match(html, /function finishArtworkEntry\(\)[\s\S]*?showScreen\('roomScreen'/);
});
