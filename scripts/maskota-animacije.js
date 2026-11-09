'use strict';

// Generator za animacije maskote (SVG + CSS, bez video fajlova).
// Pokretanje: node scripts/maskota-animacije.js [putanja-za-pregled.html]
// Izlaz: public/img/maskota-animacije/<naziv>.svg (svaka datuma samostalna, u petlji).
// Jednom (bez petlje): <img src="…/servis.svg#jednom">. „Manje pokreta“ (prefers-reduced-motion): mirna slika.
// Aplikacija ovu skriptu ne koristi – samo za izradu grafika.

const fs = require('node:fs');
const path = require('node:path');

const NAVY = '#11304c';
const GREEN = '#7fbf35';
const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'maskota-animacije');
const VIEWBOX = '0 -64 380 344';
const VIEWBOX_V2 = '0 -64 380 360'; // duže noge – malo više mjesta dolje

// Mala teniska loptica (crta se oko 0,0 i pomjera se CSS-om).
const smallBall = (cls) => `
  <g class="${cls}">
    <circle r="10" fill="#d4e83a" stroke="${NAVY}" stroke-width="2.5"/>
    <path d="M-7 -6 C-2 -2 -2 4 -7 7 M7 -6 C2 -2 2 4 7 7" stroke="#ffffff" stroke-width="2" fill="none" stroke-linecap="round"/>
  </g>`;

// Maskota iz pokretnih dijelova. Animirani elementi nemaju statičke transform-atribute na precima,
// tako da se tačke okretanja (transform-origin) zadaju direktno u koordinatama crteža.
// Return-pozicija (čeka lopticu): koljena savijena, reket objema rukama ispred tijela.
const READY_LEGS = `<path d="M96 214 L82 231 L90 246 M142 216 L158 231 L150 246" stroke="${NAVY}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
const READY_HANDS_V1 = `
      <circle cx="146" cy="236" r="9" fill="#ffffff" stroke="${NAVY}" stroke-width="4"/>
      <circle cx="127" cy="234" r="9" fill="#ffffff" stroke="${NAVY}" stroke-width="4"/>`;
const READY_FRONT = `
    <g class="ready-arms">
      <g transform="translate(150 238) rotate(-80) scale(0.62) translate(-214 -138)">
        <rect x="208" y="96" width="12" height="44" rx="5" fill="${NAVY}"/>
        <rect x="208" y="122" width="12" height="18" rx="5" fill="${GREEN}"/>
        <path d="M214 98 L204 82 M214 98 L224 82" stroke="${NAVY}" stroke-width="5" stroke-linecap="round"/>
        <ellipse cx="214" cy="50" rx="30" ry="38" fill="#ffffff" fill-opacity="0.9" stroke="${NAVY}" stroke-width="7"/>
        <g stroke="${GREEN}" stroke-width="2" opacity="0.9">
          <path d="M196 30 V70 M205 18 V82 M214 14 V86 M223 18 V82 M232 30 V70"/>
          <path d="M188 34 H240 M186 44 H242 M186 54 H242 M188 64 H240 M194 74 H234"/>
        </g>
      </g>
      <path d="M190 144 C206 184 184 228 148 236 M48 156 C40 198 90 236 128 234" stroke="${NAVY}" stroke-width="7" stroke-linecap="round" fill="none"/>
${READY_HANDS_V1}
    </g>`;

// ---------------------------------------------------------------- Dizajn 2 (kapa naopako, rukavice, patike)
const NAVY_LIGHT = '#2a5378';
const SHADE = '#7da21c';
// Bijela strip-rukavica (crta se oko 0,0; manžeta pokazuje prema ruci – ugao u stepenima).
const glove = (x, y, angle) => `
      <g transform="translate(${x} ${y}) rotate(${angle})">
        <rect x="-8" y="6" width="16" height="7" rx="3" fill="#ffffff" stroke="${NAVY}" stroke-width="3"/>
        <path d="M-10 2 C-13 -6 -8 -13 0 -13 C8 -13 13 -6 10 2 C9 7 -9 7 -10 2 Z" fill="#ffffff" stroke="${NAVY}" stroke-width="3.2"/>
        <path d="M-10 -1 C-15 -3 -16 4 -11 5" fill="#ffffff" stroke="${NAVY}" stroke-width="3"/>
        <path d="M-3 -9 V-3 M2 -9 V-3 M7 -7 V-2" stroke="${NAVY}" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>
        <path d="M4 -10 C7 -10 9 -8 9 -5" stroke="#d9e2ea" stroke-width="2" fill="none" stroke-linecap="round"/>
      </g>`;
// Znojnica (zelena traka na zglobu).
const wristband = (x1, y1, x2, y2) => `
      <path d="M${x1} ${y1} L${x2} ${y2}" stroke="${NAVY}" stroke-width="13" stroke-linecap="round"/>
      <path d="M${x1} ${y1} L${x2} ${y2}" stroke="${GREEN}" stroke-width="9" stroke-linecap="round"/>
      <path d="M${x1} ${y1} L${x2} ${y2}" stroke="#ffffff" stroke-width="2" stroke-linecap="round" opacity="0.8"/>`;
// Patike u bojama logotipa (tamnoplave, bijeli đon, zelena linija, bijele pertle).
const SNEAKERS_V2 = `
      <g stroke="${NAVY}" stroke-width="4" stroke-linejoin="round" fill="${NAVY}">
        <path d="M64 258 C64 245 75 238 92 238 C101 238 105 243 107 250 L109 258 Z"/>
        <path d="M133 258 L135 250 C137 243 141 238 150 238 C167 238 178 245 178 258 Z"/>
      </g>
      <path d="M66 257 H107 M135 257 H176" stroke="#ffffff" stroke-width="4" stroke-linecap="round"/>
      <path d="M70 250 C80 245 92 247 102 243 M140 243 C150 247 162 245 172 250" stroke="${GREEN}" stroke-width="4" stroke-linecap="round" fill="none"/>
      <path d="M84 241 l4 4 M90 240 l4 4 M146 240 l-4 4 M152 241 l-4 4" stroke="#ffffff" stroke-width="2" stroke-linecap="round"/>
      <ellipse cx="80" cy="246" rx="6" ry="2.5" fill="#ffffff" opacity="0.25"/><ellipse cx="160" cy="245" rx="6" ry="2.5" fill="#ffffff" opacity="0.25"/>`;
// Kapa naopako: štitnik pozadi, otvor s kopčom naprijed, „BT“ na kapi.
const CAP_BRIM_V2 = `
      <path d="M150 76 C168 60 200 54 224 58 C226 66 214 76 196 84 C186 88 174 92 166 94 Z" fill="${GREEN}" stroke="${NAVY}" stroke-width="4" stroke-linejoin="round"/>
      <path d="M160 74 C178 64 200 60 218 62" stroke="#ffffff" stroke-width="2.5" fill="none" opacity="0.5" stroke-linecap="round"/>
      <path d="M170 92 C188 86 208 78 222 66" stroke="#5e9b21" stroke-width="3" fill="none" stroke-linecap="round"/>`;
const CAP_V2 = `
      <path d="M36 128 C32 30 204 30 200 128 C164 112 72 112 36 128 Z" fill="${NAVY}" stroke="${NAVY}" stroke-width="4" stroke-linejoin="round"/>
      <path d="M118 56 C102 72 96 96 98 116 M118 56 C134 72 140 96 138 116" stroke="${NAVY_LIGHT}" stroke-width="2.5" fill="none"/>
      <path d="M58 96 C70 74 92 62 110 60" stroke="#ffffff" stroke-width="6" fill="none" opacity="0.18" stroke-linecap="round"/>
      <path d="M38 126 C74 110 162 110 198 126" stroke="${GREEN}" stroke-width="4" fill="none"/>
      <path d="M100 121 C100 104 136 104 136 121 C126 116 110 116 100 121 Z" fill="#d4e83a" stroke="${NAVY}" stroke-width="3"/>
      <path d="M103 117 H133" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
      <rect x="114" y="113" width="8" height="6" rx="1.5" fill="#c9d3dc" stroke="${NAVY}" stroke-width="1.5"/>
      <circle cx="118" cy="54" r="5" fill="${GREEN}" stroke="${NAVY}" stroke-width="2.5"/>
      <text x="118" y="97" text-anchor="middle" font-family="Arial Black, Arial, Helvetica, sans-serif" font-size="21" font-weight="900" letter-spacing="1"><tspan fill="#ffffff">B</tspan><tspan fill="${GREEN}">T</tspan></text>`;
const READY_V2_HANDS = `${wristband(158, 236, 165, 236)}${glove(146, 236, -90)}${glove(127, 234, 90)}`;
// Dizajn 2: deblje ruke i noge, duže noge (patike i sjena niže za LEG_V2).
const LIMB_V2 = 10;
const LEG_V2 = 16;
const LEGS_V2 = `<path d="M96 210 L90 ${244 + LEG_V2} M142 212 L150 ${244 + LEG_V2}" stroke="${NAVY}" stroke-width="${LIMB_V2}" stroke-linecap="round" fill="none"/>`;
const READY_LEGS_V2 = `<path d="M96 214 L80 ${238} L90 ${246 + LEG_V2} M142 216 L160 ${238} L150 ${246 + LEG_V2}" stroke="${NAVY}" stroke-width="${LIMB_V2}" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`;
// Oči dizajna 2: oba oka otvorena (mirno stanje); namigivanje je poseban izraz za animacije.
const EYES_V2 = `<g class="eyes">
        <ellipse cx="88" cy="150" rx="15" ry="18" fill="#ffffff" stroke="${NAVY}" stroke-width="3.5"/>
        <ellipse cx="144" cy="148" rx="15" ry="18" fill="#ffffff" stroke="${NAVY}" stroke-width="3.5"/>
        <path d="M77 158 C82 166 94 167 100 160 M133 156 C138 164 150 165 156 158" stroke="#d9e2ea" stroke-width="3" fill="none" stroke-linecap="round"/>
        <g class="pupils">
          <circle cx="91" cy="153" r="8.5" fill="${NAVY}"/>
          <circle cx="147" cy="151" r="8.5" fill="${NAVY}"/>
          <circle cx="94" cy="149" r="3.2" fill="#ffffff"/><circle cx="150" cy="147" r="3.2" fill="#ffffff"/>
          <circle cx="88" cy="157" r="1.5" fill="#ffffff"/><circle cx="144" cy="155" r="1.5" fill="#ffffff"/>
        </g>
      </g>
      <g class="eyes-wink alt">
        <path d="M74 154 Q88 164 102 152" stroke="${NAVY}" stroke-width="5" stroke-linecap="round" fill="none"/>
        <path d="M76 150 l-5 -3 M100 149 l4 -4" stroke="${NAVY}" stroke-width="3" stroke-linecap="round"/>
        <ellipse cx="144" cy="148" rx="15" ry="18" fill="#ffffff" stroke="${NAVY}" stroke-width="3.5"/>
        <path d="M133 156 C138 164 150 165 156 158" stroke="#d9e2ea" stroke-width="3" fill="none" stroke-linecap="round"/>
        <circle cx="147" cy="151" r="8.5" fill="${NAVY}"/>
        <circle cx="150" cy="147" r="3.2" fill="#ffffff"/>
        <circle cx="144" cy="155" r="1.5" fill="#ffffff"/>
      </g>`;

function mascot(id, { ballBehind = '', pose = 'default', design = 1 } = {}) {
  const ready = pose === 'ready';
  const v2 = design === 2;
  return `
  <ellipse class="shadow" cx="122" cy="${v2 ? 266 + LEG_V2 : 266}" rx="70" ry="8" fill="${NAVY}" opacity="0.12"/>
  ${ballBehind}
  <g class="fig">
    <g class="legs">
      ${v2 ? (ready ? READY_LEGS_V2 : LEGS_V2) : ready ? READY_LEGS : `<path d="M96 210 L90 244 M142 212 L150 244" stroke="${NAVY}" stroke-width="7" stroke-linecap="round" fill="none"/>`}
      ${v2 ? `<g transform="translate(0 ${LEG_V2})">${SNEAKERS_V2}</g>` : `<g stroke="${NAVY}" stroke-width="4" stroke-linejoin="round" fill="#ffffff">
        <path d="M66 258 C66 246 76 240 92 240 C100 240 104 244 106 250 L108 258 Z"/>
        <path d="M134 258 L136 250 C138 244 142 240 150 240 C166 240 176 246 176 258 Z"/>
      </g>
      <path d="M68 258 H108 M134 258 H176" stroke="${NAVY}" stroke-width="5" stroke-linecap="round"/>
      <path d="M74 251 C82 247 92 249 100 246 M142 246 C150 249 160 247 168 251" stroke="${GREEN}" stroke-width="4" stroke-linecap="round" fill="none"/>`}
    </g>
    ${ready ? '' : `<g class="arm-l">
      <path d="M48 150 C30 140 24 122 30 104" stroke="${NAVY}" stroke-width="${v2 ? LIMB_V2 : 7}" stroke-linecap="round" fill="none"/>
      ${v2 ? glove(30, 98, 12) : `<circle cx="30" cy="100" r="9" fill="#ffffff" stroke="${NAVY}" stroke-width="4"/>`}
    </g>
    <g class="arm-r">
      <g transform="translate(217 108) rotate(22) scale(0.86) translate(-214 -138)">
        <rect x="208" y="96" width="12" height="44" rx="5" fill="${NAVY}"/>
        <rect x="208" y="122" width="12" height="18" rx="5" fill="${GREEN}"/>
        <path d="M214 98 L204 82 M214 98 L224 82" stroke="${NAVY}" stroke-width="5" stroke-linecap="round"/>
        <ellipse cx="214" cy="50" rx="30" ry="38" fill="#ffffff" fill-opacity="0.85" stroke="${NAVY}" stroke-width="7"/>
        <g stroke="${GREEN}" stroke-width="2" opacity="0.9">
          <path d="M196 30 V70 M205 18 V82 M214 14 V86 M223 18 V82 M232 30 V70"/>
          <path d="M188 34 H240 M186 44 H242 M186 54 H242 M188 64 H240 M194 74 H234"/>
        </g>
      </g>
      <path d="M190 138 C204 132 212 122 216 110" stroke="${NAVY}" stroke-width="${v2 ? LIMB_V2 : 7}" stroke-linecap="round" fill="none"/>
      ${v2 ? `${wristband(212, 121, 214, 115)}${glove(217, 104, 18)}` : `<circle cx="217" cy="106" r="9" fill="#ffffff" stroke="${NAVY}" stroke-width="4"/>`}
    </g>`}
    <g class="body"${ready ? ' transform="translate(0 6)"' : ''}>
      ${v2 ? CAP_BRIM_V2 : ''}
      <circle cx="118" cy="142" r="76" fill="url(#${id}-ball)" stroke="${NAVY}" stroke-width="5"/>
      <g clip-path="url(#${id}-clip)" fill="none" stroke="#ffffff" stroke-width="6" stroke-linecap="round" opacity="0.95">
        <path d="M50 96 C82 120 84 168 54 196"/>
        <path d="M186 92 C156 116 152 168 184 196"/>
      </g>
      ${v2 ? `<g clip-path="url(#${id}-clip)">
        <circle cx="96" cy="118" r="82" fill="none" stroke="${SHADE}" stroke-width="44" opacity="0.32"/>
        <ellipse cx="62" cy="152" rx="6" ry="16" fill="#ffffff" opacity="0.35"/>
      </g>
      <circle cx="118" cy="142" r="76" fill="none" stroke="${NAVY}" stroke-width="5"/>
      ${CAP_V2}` : `<path d="M50 108 C84 86 154 86 188 108 L184 124 C152 104 86 104 54 124 Z" fill="${NAVY}"/>
      <path d="M54 115 C88 96 150 96 186 115" stroke="${GREEN}" stroke-width="4" fill="none"/>
      <path d="M186 108 C198 100 206 104 208 112 C200 112 194 116 190 120 Z" fill="${NAVY}"/>
      <path d="M188 116 C200 120 204 128 200 136 C194 130 188 128 184 124 Z" fill="${NAVY}"/>`}
      <g class="brows" stroke="${NAVY}" stroke-width="5" stroke-linecap="round" fill="none">
        ${v2 ? '<path d="M74 132 C82 127 92 127 100 131"/><path d="M130 124 C138 116 150 116 160 122"/>'
    : '<path d="M74 132 C82 126 92 126 100 130"/><path d="M130 126 C138 120 150 120 158 126"/>'}
      </g>
      ${v2 ? EYES_V2 : `<g class="eyes">
        <ellipse cx="88" cy="150" rx="15" ry="18" fill="#ffffff" stroke="${NAVY}" stroke-width="3.5"/>
        <ellipse cx="144" cy="148" rx="15" ry="18" fill="#ffffff" stroke="${NAVY}" stroke-width="3.5"/>
        <g class="pupils">
          <circle cx="92" cy="154" r="8" fill="${NAVY}"/>
          <circle cx="148" cy="152" r="8" fill="${NAVY}"/>
          <circle cx="95" cy="150" r="3" fill="#ffffff"/>
          <circle cx="151" cy="148" r="3" fill="#ffffff"/>
        </g>
      </g>`}
      <g class="eyes-happy alt" stroke="${NAVY}" stroke-width="5" stroke-linecap="round" fill="none">
        <path d="M74 156 Q88 138 102 156"/>
        <path d="M130 154 Q144 136 158 154"/>
      </g>
      <g class="eyes-dizzy alt" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round" fill="none">
        <ellipse cx="88" cy="150" rx="15" ry="18" fill="#ffffff"/>
        <ellipse cx="144" cy="148" rx="15" ry="18" fill="#ffffff"/>
        <path d="M88 150 m-9 0 a9 9 0 1 1 9 9 a6 6 0 1 1 -6 -6 a3 3 0 1 1 3 3"/>
        <path d="M144 148 m-9 0 a9 9 0 1 1 9 9 a6 6 0 1 1 -6 -6 a3 3 0 1 1 3 3"/>
      </g>
      <ellipse cx="68" cy="176" rx="9" ry="6" fill="#f2957a" opacity="0.55"/>
      <ellipse cx="166" cy="174" rx="9" ry="6" fill="#f2957a" opacity="0.55"/>
      ${v2 ? `<g class="mouth">
        <path d="M74 170 C82 214 152 216 166 166 C136 178 104 180 74 170 Z" fill="${NAVY}" stroke="${NAVY}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M81 174 C104 183 138 182 159 172 L157 180 C136 189 104 190 83 182 Z" fill="#ffffff"/>
        <path d="M100 200 C110 190 134 190 144 198 C134 206 110 207 100 200 Z" fill="#f26b6b"/>
        <path d="M70 168 C72 164 76 163 79 166 M161 163 C164 160 168 161 169 165" stroke="${NAVY}" stroke-width="3.5" stroke-linecap="round" fill="none"/>
      </g>` : `<g class="mouth">
        <path d="M80 174 C92 204 142 206 158 172 C138 182 102 184 80 174 Z" fill="${NAVY}" stroke="${NAVY}" stroke-width="3" stroke-linejoin="round"/>
        <path d="M86 177 C104 184 136 183 152 176 L150 181 C134 187 104 188 88 182 Z" fill="#ffffff"/>
        <path d="M104 194 C112 188 128 188 134 194 C126 199 112 199 104 194 Z" fill="#f26b6b"/>
      </g>`}
      <g class="mouth-o alt">
        <ellipse cx="120" cy="184" rx="10" ry="12" fill="${NAVY}"/>
        <ellipse cx="120" cy="189" rx="6" ry="4" fill="#f26b6b"/>
      </g>
      <path class="mouth-wavy alt" d="M92 184 q7 -7 14 0 t14 0 t14 0 t14 0" stroke="${NAVY}" stroke-width="5" stroke-linecap="round" fill="none"/>
    </g>
    ${ready ? (v2 ? READY_FRONT.replace(READY_HANDS_V1, READY_V2_HANDS).replace('stroke-width="7" stroke-linecap="round" fill="none"/>', `stroke-width="${LIMB_V2}" stroke-linecap="round" fill="none"/>`) : READY_FRONT) : ''}
  </g>`;
}

const defs = (id) => `
  <defs>
    <radialGradient id="${id}-ball" cx="38%" cy="32%" r="75%">
      <stop offset="0" stop-color="#f3f86a"/><stop offset="0.55" stop-color="#d4e83a"/><stop offset="1" stop-color="#9cc22c"/>
    </radialGradient>
    <clipPath id="${id}-clip"><circle cx="118" cy="142" r="76"/></clipPath>
  </defs>`;

// Zajednički CSS: tačke okretanja, skriveni dodaci, petlja / jednom, „manje pokreta“.
function baseCss(id, dur, design = 1) {
  const legDy = design === 2 ? LEG_V2 : 0;
  const s = `#${id}`;
  return `
    ${s} .arm-r { transform-origin: 190px 138px; }
    ${s} .arm-l { transform-origin: 48px 150px; }
    ${s} .fig { transform-origin: 122px ${262 + legDy}px; }
    ${s} .body { transform-origin: 118px 142px; }
    ${s} .shadow { transform-origin: 122px ${266 + legDy}px; }
    ${s} .alt, ${s} .fx, ${s} .tb { opacity: 0; }
    ${s} .anim { animation-duration: ${dur}s; animation-iteration-count: infinite; animation-timing-function: ease-in-out; animation-fill-mode: both; }
    ${s}.jednom .anim, #jednom:target ~ .scene .anim { animation-iteration-count: 1; }
    @media (prefers-reduced-motion: reduce) {
      ${s} *, ${s} .anim { animation: none !important; }
    }`;
}

// Pomoćno: keyframes iz liste [postotak, vrijednost].
const kf = (name, prop, frames) => `@keyframes ${name} { ${frames.map(([p, v]) => `${p}% { ${prop}: ${v}; }`).join(' ')} }`;
const tr = (x, y) => `translate(${x}px, ${y}px)`;
const rot = (d) => `rotate(${d}deg)`;
// Opacity za alternativne dijelove (lica, efekti): uključeno između od–do.
const showBetween = (name, from, to) => kf(name, 'opacity', [[0, 0], [Math.max(0, from - 0.5), 0], [from, 1], [to, 1], [Math.min(100, to + 0.5), 0], [100, 0]]);
const hideBetween = (name, from, to) => kf(name, 'opacity', [[0, 1], [Math.max(0, from - 0.5), 1], [from, 0], [to, 0], [Math.min(100, to + 0.5), 1], [100, 1]]);

// Return-pozicija: lagano njihanje u petlji (između animacija).
const READY = {
  file: 'spremni', title: 'Return-pozicija', label: 'Maskota čeka lopticu u return-poziciji', dur: 1.8, pose: 'ready',
  extra: () => '',
  css: (id) => {
    const s = `#${id}`;
    return `
      ${s} .fig { animation-name: ${id}-sway; }
      ${s} .pupils { animation-name: ${id}-look; animation-duration: 5.4s; }
      ${kf(`${id}-sway`, 'transform', [[0, `${tr(-3, 0)} rotate(-2deg)`], [25, `${tr(0, 2)} rotate(0deg)`], [50, `${tr(3, 0)} rotate(2deg)`], [75, `${tr(0, 2)} rotate(0deg)`], [100, `${tr(-3, 0)} rotate(-2deg)`]])}
      ${kf(`${id}-look`, 'transform', [[0, 'none'], [30, 'none'], [36, tr(3, 0)], [56, tr(3, 0)], [62, tr(-2, 0)], [80, tr(-2, 0)], [86, 'none'], [100, 'none']])}`;
  },
};

const SCENES = [
  {
    file: 'servis', title: 'Servis', label: 'Maskota baca lopticu i servira', dur: 3,
    extra: (id) => `
      <path class="fx swoosh" d="M70 30 C100 -24 176 -30 214 8" stroke="${GREEN}" stroke-width="7" stroke-linecap="round" fill="none"/>
      ${smallBall('tb')}`,
    css: (id, design) => {
      const s = `#${id}`;
      return `
      ${s} .arm-r { animation-name: ${id}-armr; }
      ${s} .arm-l { animation-name: ${id}-arml; }
      ${s} .tb { animation-name: ${id}-tb; animation-timing-function: linear; }
      ${s} .swoosh { animation-name: ${id}-swoosh; }
      ${s} .fig { animation-name: ${id}-fig; }
      ${s} .shadow { animation-name: ${id}-shadow; }
      ${s} .pupils { animation-name: ${id}-pupils; }
      ${kf(`${id}-armr`, 'transform', [[0, rot(0)], [15, rot(35)], [42, rot(42)], [50, rot(-60)], [58, rot(-98)], [74, rot(-30)], [100, rot(0)]])}
      ${kf(`${id}-arml`, 'transform', [[0, rot(0)], [10, rot(-15)], [24, rot(22)], [40, rot(18)], [60, rot(0)], [100, rot(0)]])}
      ${kf(`${id}-tb`, 'transform', [[0, tr(18, 96)], [10, tr(18, 96)], [24, tr(48, 86)], [30, tr(70, 32)], [36, tr(90, 4)], [42, tr(110, -14)], [46, tr(120, -4)], [50, tr(128, 30)], [56, tr(240, 6)], [62, tr(400, -30)], [100, tr(400, -30)]])}
      ${kf(`${id}-tb-o`, 'opacity', [[0, 0], [9, 0], [10, 1], [60, 1], [61, 0], [100, 0]])}
      ${s} .tb { animation-name: ${id}-tb, ${id}-tb-o; }
      ${showBetween(`${id}-swoosh`, 49, 58)}
      ${kf(`${id}-fig`, 'transform', [[0, 'none'], [40, 'scale(1.02, 0.97)'], [50, `${tr(0, -10)} scale(0.98, 1.03)`], [60, 'none'], [100, 'none']])}
      ${kf(`${id}-shadow`, 'transform', [[0, 'none'], [50, 'scale(0.85)'], [60, 'none'], [100, 'none']])}
      ${kf(`${id}-pupils`, 'transform', [[0, 'none'], [24, 'none'], [32, tr(2, -5)], [50, tr(3, -6)], [56, tr(5, -2)], [70, 'none'], [100, 'none']])}`;
    },
  },
  {
    file: 'forhend', title: 'Forhend', label: 'Maskota udara forhend', dur: 2.6,
    extra: (id) => `
      <path class="fx swoosh" d="M312 150 C334 96 300 24 214 8" stroke="${GREEN}" stroke-width="7" stroke-linecap="round" fill="none"/>
      <path class="fx swoosh2" d="M296 160 C314 116 290 56 236 34" stroke="${GREEN}" stroke-width="4" stroke-linecap="round" fill="none" opacity="0.7"/>
      ${smallBall('tb')}`,
    css: (id) => {
      const s = `#${id}`;
      return `
      ${s} .arm-r { animation-name: ${id}-armr; }
      ${s} .body { animation-name: ${id}-body; }
      ${s} .tb { animation-name: ${id}-tb, ${id}-tb-o; animation-timing-function: linear; }
      ${s} .swoosh, ${s} .swoosh2 { animation-name: ${id}-swoosh; }
      ${s} .pupils { animation-name: ${id}-pupils; }
      ${kf(`${id}-armr`, 'transform', [[0, rot(0)], [30, rot(58)], [40, rot(60)], [47, rot(20)], [53, rot(-40)], [60, rot(-88)], [76, rot(-60)], [100, rot(0)]])}
      ${kf(`${id}-body`, 'transform', [[0, 'none'], [32, rot(-4)], [52, rot(5)], [70, rot(2)], [100, 'none']])}
      ${kf(`${id}-tb`, 'transform', [[0, tr(400, 30)], [18, tr(400, 30)], [28, tr(350, 34)], [38, tr(306, 52)], [47, tr(280, 64)], [54, tr(330, 14)], [62, tr(420, -40)], [100, tr(420, -40)]])}
      ${kf(`${id}-tb-o`, 'opacity', [[0, 0], [18, 0], [19, 1], [61, 1], [62, 0], [100, 0]])}
      ${showBetween(`${id}-swoosh`, 47, 60)}
      ${kf(`${id}-pupils`, 'transform', [[0, 'none'], [20, tr(5, -1)], [47, tr(6, -3)], [56, tr(5, -6)], [70, 'none'], [100, 'none']])}`;
    },
  },
  {
    file: 'promasaj', title: 'Promašaj', label: 'Maskota promaši lopticu, zbuni se i počeše se reketom', dur: 4,
    ballBehind: smallBall('tb'),
    extra: (id) => `
      <path class="fx swoosh" d="M300 170 C320 110 290 40 200 20" stroke="${GREEN}" stroke-width="6" stroke-linecap="round" fill="none"/>
      <text class="fx question" x="196" y="44" font-family="Arial, Helvetica, sans-serif" font-size="46" font-weight="700" fill="${NAVY}">?</text>`,
    css: (id) => {
      const s = `#${id}`;
      return `
      ${s} .arm-r { animation-name: ${id}-armr; }
      ${s} .body { animation-name: ${id}-body; }
      ${s} .tb { animation-name: ${id}-tb, ${id}-tb-o; animation-timing-function: linear; }
      ${s} .swoosh { animation-name: ${id}-swoosh; }
      ${s} .question { animation-name: ${id}-q, ${id}-q-o; transform-origin: 210px 30px; }
      ${s} .pupils { animation-name: ${id}-pupils; }
      ${s} .mouth { animation-name: ${id}-mouth; }
      ${s} .mouth-o { animation-name: ${id}-mouth-o; }
      ${s} .brows { animation-name: ${id}-brows; transform-origin: 118px 128px; }
      ${kf(`${id}-armr`, 'transform', [[0, rot(0)], [18, rot(52)], [24, rot(55)], [30, rot(-70)], [36, rot(-62)], [46, rot(-10)], [56, rot(-72)], [60, rot(-84)], [64, rot(-72)], [68, rot(-84)], [72, rot(-72)], [76, rot(-84)], [80, rot(-72)], [88, rot(-60)], [100, rot(0)]])}
      ${kf(`${id}-body`, 'transform', [[0, 'none'], [30, rot(4)], [40, 'none'], [50, rot(-5)], [86, rot(-5)], [96, 'none'], [100, 'none']])}
      ${kf(`${id}-tb`, 'transform', [[0, tr(400, 40)], [10, tr(400, 40)], [20, tr(320, 120)], [28, tr(250, 190)], [34, tr(170, 226)], [46, tr(-40, 250)], [100, tr(-40, 250)]])}
      ${kf(`${id}-tb-o`, 'opacity', [[0, 0], [10, 0], [11, 1], [45, 1], [46, 0], [100, 0]])}
      ${showBetween(`${id}-swoosh`, 28, 36)}
      ${kf(`${id}-q`, 'transform', [[0, 'scale(0.4)'], [44, 'scale(0.4)'], [50, 'scale(1.1)'], [54, 'scale(1)'], [70, 'rotate(10deg)'], [86, 'rotate(-6deg)'], [100, 'scale(0.4)']])}
      ${showBetween(`${id}-q-o`, 46, 88)}
      ${kf(`${id}-pupils`, 'transform', [[0, 'none'], [16, tr(5, -2)], [30, tr(1, 4)], [40, tr(-6, 3)], [50, tr(-4, -5)], [88, tr(-4, -5)], [96, 'none'], [100, 'none']])}
      ${hideBetween(`${id}-mouth`, 44, 90)}
      ${showBetween(`${id}-mouth-o`, 44, 90)}
      ${kf(`${id}-brows`, 'transform', [[0, 'none'], [44, 'none'], [50, `${tr(0, -6)} rotate(-4deg)`], [88, `${tr(0, -6)} rotate(-4deg)`], [96, 'none'], [100, 'none']])}`;
    },
  },
  {
    file: 'poen', title: 'Poen!', label: 'Maskota osvoji poen, skoči i raduje se', dur: 3.2,
    extra: (id) => `
      ${smallBall('tb')}
      <g class="fx cheer">
        <text x="232" y="64" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="800" fill="${GREEN}" stroke="${NAVY}" stroke-width="1.5">Poen!</text>
        <path d="M44 40 l4 9 9 1 -7 6 2 9 -8 -5 -8 5 2 -9 -7 -6 9 -1 Z" fill="${GREEN}"/>
        <path d="M200 6 l3 7 7 1 -5 5 1 7 -6 -4 -6 4 1 -7 -5 -5 7 -1 Z" fill="#f3c623"/>
        <circle cx="30" cy="80" r="4" fill="#f3c623"/><circle cx="214" cy="56" r="4" fill="${GREEN}"/><circle cx="76" cy="18" r="3" fill="${NAVY}"/>
      </g>`,
    css: (id, design) => {
      const s = `#${id}`;
      return `
      ${s} .arm-r { animation-name: ${id}-armr; }
      ${s} .arm-l { animation-name: ${id}-arml; }
      ${s} .fig { animation-name: ${id}-fig; }
      ${s} .shadow { animation-name: ${id}-shadow; }
      ${s} .tb { animation-name: ${id}-tb, ${id}-tb-o; animation-timing-function: linear; }
      ${s} .eyes { animation-name: ${id}-eyes; }
      ${s} .eyes-happy { animation-name: ${id}-happy; }
      ${s} .cheer { animation-name: ${id}-cheer, ${id}-cheer-o; transform-origin: 160px 50px; }
      ${kf(`${id}-armr`, 'transform', [[0, rot(40)], [12, rot(46)], [18, rot(20)], [24, rot(-40)], [30, rot(-50)], [36, rot(-38)], [44, rot(-48)], [52, rot(-34)], [60, rot(-48)], [70, rot(-40)], [86, rot(0)], [100, rot(40)]])}
      ${kf(`${id}-arml`, 'transform', [[0, rot(0)], [30, rot(0)], [40, rot(24)], [48, rot(8)], [56, rot(26)], [64, rot(8)], [74, rot(20)], [88, rot(0)], [100, rot(0)]])}
      ${kf(`${id}-fig`, 'transform', [[0, 'none'], [28, 'none'], [34, 'scale(1.05, 0.92)'], [44, `${tr(0, -40)} scale(0.97, 1.04)`], [54, tr(0, -44)], [64, tr(0, -16)], [70, 'scale(1.04, 0.94)'], [76, 'none'], [100, 'none']])}
      ${kf(`${id}-shadow`, 'transform', [[0, 'none'], [30, 'none'], [44, 'scale(0.6)'], [56, 'scale(0.55)'], [70, 'none'], [100, 'none']])}
      ${kf(`${id}-tb`, 'transform', [[0, tr(400, 50)], [4, tr(360, 58)], [12, tr(300, 64)], [18, tr(276, 66)], [24, tr(330, 10)], [30, tr(420, -50)], [100, tr(420, -50)]])}
      ${kf(`${id}-tb-o`, 'opacity', [[0, 1], [29, 1], [30, 0], [99, 0], [100, 1]])}
      ${hideBetween(`${id}-eyes`, 34, 86)}
      ${design === 2 ? `${showBetween(`${id}-happy`, 34, 64)} ${s} .eyes-wink { animation-name: ${id}-wink; } ${showBetween(`${id}-wink`, 64, 86)}`
    : showBetween(`${id}-happy`, 34, 86)}
      ${kf(`${id}-cheer`, 'transform', [[0, 'scale(0.3)'], [38, 'scale(0.3)'], [46, 'scale(1.12)'], [52, 'scale(1)'], [84, `${tr(0, -6)} scale(1)`], [100, 'scale(0.3)']])}
      ${showBetween(`${id}-cheer-o`, 40, 86)}`;
    },
  },
  {
    file: 'pogodjen', title: 'Pogođen', label: 'Maskotu pogodi loptica i malo mu se zavrti u glavi', dur: 3.6,
    extra: (id) => `
      ${smallBall('tb')}
      <path class="fx bang" d="M176 86 l6 -14 2 14 13 -8 -7 13 15 2 -14 6 9 11 -14 -4 -2 15 -6 -13 -10 10 2 -14 -14 -1 13 -7 -9 -11 Z" fill="#f3c623" stroke="${NAVY}" stroke-width="2.5" stroke-linejoin="round"/>
      <g class="fx stars">
        ${[0, 1, 2].map((i) => `<path class="star star-${i}" d="M0 -9 l2.6 6 6.4 .6 -4.8 4.2 1.4 6.3 -5.6 -3.3 -5.6 3.3 1.4 -6.3 -4.8 -4.2 6.4 -.6 Z" fill="#f3c623" stroke="${NAVY}" stroke-width="1.8" stroke-linejoin="round"/>`).join('')}
      </g>`,
    css: (id) => {
      const s = `#${id}`;
      // Zvjezdice kruže u elipsi iznad glave (centar 118,50).
      const orbit = [0, 45, 90, 135, 180, 225, 270, 315, 360].map((deg, i) => {
        const rad = (deg * Math.PI) / 180;
        return [Math.round((i / 8) * 1000) / 10, tr(Math.round(118 + 50 * Math.cos(rad)), Math.round(48 + 14 * Math.sin(rad)))];
      });
      return `
      ${s} .fig { animation-name: ${id}-fig; }
      ${s} .tb { animation-name: ${id}-tb, ${id}-tb-o; animation-timing-function: linear; }
      ${s} .bang { animation-name: ${id}-bang, ${id}-bang-o; transform-origin: 184px 92px; }
      ${s} .eyes { animation-name: ${id}-eyes; }
      ${s} .eyes-dizzy { animation-name: ${id}-dizzy; }
      ${s} .mouth { animation-name: ${id}-mouth; }
      ${s} .mouth-wavy { animation-name: ${id}-wavy; }
      ${s} .arm-r { animation-name: ${id}-armr; }
      ${s} .arm-l { animation-name: ${id}-arml; }
      ${s} .stars { animation-name: ${id}-stars; }
      ${s} .star { animation: ${id}-orbit 1.1s linear infinite; }
      ${s} .star-1 { animation-delay: -0.367s; }
      ${s} .star-2 { animation-delay: -0.733s; }
      ${kf(`${id}-orbit`, 'transform', orbit)}
      ${kf(`${id}-tb`, 'transform', [[0, tr(400, 20)], [6, tr(400, 20)], [14, tr(300, 52)], [22, tr(184, 90)], [28, tr(240, 20)], [34, tr(300, -30)], [40, tr(360, -80)], [100, tr(360, -80)]])}
      ${kf(`${id}-tb-o`, 'opacity', [[0, 0], [6, 0], [7, 1], [39, 1], [40, 0], [100, 0]])}
      ${kf(`${id}-bang`, 'transform', [[0, 'scale(0.2)'], [21, 'scale(0.2)'], [24, 'scale(1.2)'], [30, 'scale(0.9)'], [100, 'scale(0.9)']])}
      ${showBetween(`${id}-bang-o`, 22, 30)}
      ${kf(`${id}-fig`, 'transform', [[0, 'none'], [21, 'none'], [24, rot(-7)], [28, rot(5)], [32, rot(-4)], [36, 'none'], [44, rot(3)], [52, rot(-3)], [60, rot(3)], [68, rot(-3)], [76, rot(3)], [84, rot(-2)], [92, 'none'], [100, 'none']])}
      ${kf(`${id}-armr`, 'transform', [[0, rot(0)], [22, rot(0)], [26, rot(30)], [40, rot(40)], [86, rot(36)], [96, rot(0)], [100, rot(0)]])}
      ${kf(`${id}-arml`, 'transform', [[0, rot(0)], [22, rot(0)], [26, rot(-16)], [40, rot(-20)], [86, rot(-18)], [96, rot(0)], [100, rot(0)]])}
      ${hideBetween(`${id}-eyes`, 23, 90)}
      ${showBetween(`${id}-dizzy`, 23, 90)}
      ${hideBetween(`${id}-mouth`, 23, 90)}
      ${showBetween(`${id}-wavy`, 23, 90)}
      ${showBetween(`${id}-stars`, 30, 90)}`;
    },
  },
];

function sceneSvg(scene, { standalone = true, design = 1 } = {}) {
  const id = `bt-maskota${design === 2 ? '2' : ''}-${scene.file}`;
  const css = `${baseCss(id, scene.dur, design)}
    ${scene.css(id, design)}`
    // svi animirani dijelovi dobijaju zajedničke postavke (trajanje, petlja)
    .replace(/\n\s*\n/g, '\n');
  const animated = ['arm-r', 'arm-l', 'fig', 'body', 'shadow', 'tb', 'swoosh', 'swoosh2', 'pupils', 'question', 'mouth', 'mouth-o', 'brows',
    'eyes', 'eyes-happy', 'eyes-wink', 'cheer', 'bang', 'eyes-dizzy', 'mouth-wavy', 'stars'];
  let body = `${mascot(id, { ballBehind: scene.ballBehind || '', pose: scene.pose, design })}${scene.extra(id)}`;
  for (const cls of animated) {
    body = body.replace(new RegExp(`class="([^"]*\\b)${cls}(\\b[^"]*)"`, 'g'), (m, a, b) => (m.includes(' anim') ? m : `class="${a}${cls}${b} anim"`));
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="${design === 2 ? VIEWBOX_V2 : VIEWBOX}" width="380" height="${design === 2 ? 360 : 344}" role="img" aria-label="${scene.label}">
  <title>${scene.label}</title>
  <style>${css}
  </style>${defs(id)}
  ${standalone ? '<g id="jednom"></g>' : ''}
  <g class="scene">${body}
  </g>
</svg>
`;
}

function previewHtml() {
  const cards = [READY, ...SCENES].map((sc) => `
      <figure class="card">
        <div class="stage">${sceneSvg(sc, { standalone: false })}</div>
        <figcaption><strong>${sc.title}</strong><span>${sc.dur} s · ${sc.file}.svg</span>
          <button type="button" class="replay">↻ Ponovi</button></figcaption>
      </figure>`).join('');
  return `<!doctype html>
<html lang="bs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>BetterTennis maskota – animacije (pregled)</title>
<style>
  body { margin: 0; font-family: Inter, system-ui, sans-serif; background: #f5f7f4; color: #13263a; }
  header { padding: 18px 20px 6px; display: flex; flex-wrap: wrap; gap: 10px 24px; align-items: baseline; }
  h1 { margin: 0; font-size: 1.3rem; color: #11304c; }
  label { font-size: .95rem; }
  .muted { color: #5b6878; font-size: .85rem; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; padding: 14px 20px 24px; }
  .card { margin: 0; background: #fff; border: 1px solid #dde3e8; border-radius: 14px; overflow: hidden; }
  .stage svg { display: block; width: 100%; height: auto; background: linear-gradient(#ffffff, #eef4e8); }
  figcaption { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap; }
  figcaption span { color: #5b6878; font-size: .8rem; flex: 1; }
  button { font: inherit; font-size: .85rem; border: 1px solid #dde3e8; background: #fff; border-radius: 8px; padding: 4px 10px; cursor: pointer; }
</style></head><body>
<header>
  <h1>BetterTennis maskota – animacije</h1>
  <label><input type="checkbox" id="loop" checked> U petlji</label>
  <p class="muted">Samo pregled – nigdje ugrađeno. Uz „manje pokreta“ (prefers-reduced-motion) prikazuje se mirna slika.</p>
</header>
<main class="grid">${cards}
</main>
<script>
  const loop = document.getElementById('loop');
  const restart = (svg) => { const c = svg.cloneNode(true); svg.replaceWith(c); return c; };
  function applyLoop() {
    document.querySelectorAll('.stage svg').forEach((svg) => { svg.classList.toggle('jednom', !loop.checked); restart(svg); });
  }
  loop.addEventListener('change', applyLoop);
  document.querySelectorAll('.replay').forEach((btn) => btn.addEventListener('click', () => {
    restart(btn.closest('.card').querySelector('.stage svg'));
  }));
</script>
</body></html>
`;
}

// Mirna slika (bez animacije) za dizajn 2.
const STILL = { file: 'maskota', title: 'Mirna slika', label: 'BetterTennis maskota', dur: 1, extra: () => '', css: () => '' };
const OUT_DIR_V2 = path.join(__dirname, '..', 'public', 'img', 'maskota-v2');

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const scene of [READY, ...SCENES]) fs.writeFileSync(path.join(OUT_DIR, `${scene.file}.svg`), sceneSvg(scene));
  // Dizajn 2 (kapa naopako, rukavice, patike) – isti pokreti, zaseban folder
  fs.mkdirSync(OUT_DIR_V2, { recursive: true });
  for (const scene of [STILL, READY, ...SCENES]) fs.writeFileSync(path.join(OUT_DIR_V2, `${scene.file}.svg`), sceneSvg(scene, { design: 2 }));
  if (process.argv[2]) fs.writeFileSync(process.argv[2], previewHtml());
  console.log(`Animacije: ${SCENES.map((s) => `${s.file}.svg`).join(', ')}${process.argv[2] ? ` · pregled: ${process.argv[2]}` : ''}`);
}

module.exports = { READY, SCENES, STILL, sceneSvg, previewHtml };
