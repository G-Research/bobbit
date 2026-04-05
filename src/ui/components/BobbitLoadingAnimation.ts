import { html, TemplateResult } from 'lit';

export function bobbitLoadingAnimation(): TemplateResult {
  return html`
    <style>
      .bobbit-loading-scene-wrap {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        background: var(--background);
      }
      .bobbit-loading-camera {
        animation: bobbit-loading-camera-lag 1.95s cubic-bezier(0.37, 0, 0.63, 1) infinite;
        position: relative;
      }
      .bobbit-loading-scene {
        position: relative;
        width: 340px;
        height: 200px;
      }
      .bobbit-loading-anchor {
        position: absolute;
        bottom: 66px;
        left: 54%;
        z-index: 10;
        animation: bobbit-loading-bounce 0.75s cubic-bezier(0.45, 0, 0.55, 1) infinite;
      }
      .bobbit-loading-pixel {
        width: 1px;
        height: 1px;
        image-rendering: pixelated;
        transform: scale(4);
        transform-origin: center bottom;
        box-shadow:
          3px 0 0 #000, 4px 0 0 #000, 5px 0 0 #000, 6px 0 0 #000, 7px 0 0 #000,
          2px 1px 0 #000, 3px 1px 0 #8ec63f, 4px 1px 0 #8ec63f, 5px 1px 0 #8ec63f, 6px 1px 0 #b5d98a, 7px 1px 0 #b5d98a, 8px 1px 0 #000,
          1px 2px 0 #000, 2px 2px 0 #8ec63f, 3px 2px 0 #8ec63f, 4px 2px 0 #8ec63f, 5px 2px 0 #8ec63f, 6px 2px 0 #8ec63f, 7px 2px 0 #b5d98a, 8px 2px 0 #8ec63f, 9px 2px 0 #000,
          0px 3px 0 #000, 1px 3px 0 #8ec63f, 2px 3px 0 #8ec63f, 3px 3px 0 #8ec63f, 4px 3px 0 #8ec63f, 5px 3px 0 #8ec63f, 6px 3px 0 #8ec63f, 7px 3px 0 #8ec63f, 8px 3px 0 #8ec63f, 9px 3px 0 #000,
          0px 4px 0 #000, 1px 4px 0 #8ec63f, 2px 4px 0 #8ec63f, 3px 4px 0 #8ec63f,
          4px 4px 0 #1a3010, 5px 4px 0 #8ec63f, 6px 4px 0 #8ec63f,
          7px 4px 0 #1a3010, 8px 4px 0 #8ec63f, 9px 4px 0 #000,
          0px 5px 0 #000, 1px 5px 0 #8ec63f, 2px 5px 0 #8ec63f, 3px 5px 0 #8ec63f,
          4px 5px 0 #1a3010, 5px 5px 0 #8ec63f, 6px 5px 0 #8ec63f,
          7px 5px 0 #1a3010, 8px 5px 0 #8ec63f, 9px 5px 0 #000,
          0px 6px 0 #000, 1px 6px 0 #6b9930, 2px 6px 0 #8ec63f, 3px 6px 0 #8ec63f, 4px 6px 0 #8ec63f, 5px 6px 0 #8ec63f, 6px 6px 0 #8ec63f, 7px 6px 0 #8ec63f, 8px 6px 0 #8ec63f, 9px 6px 0 #000,
          1px 7px 0 #000, 2px 7px 0 #6b9930, 3px 7px 0 #8ec63f, 4px 7px 0 #8ec63f, 5px 7px 0 #8ec63f, 6px 7px 0 #8ec63f, 7px 7px 0 #8ec63f, 8px 7px 0 #000,
          2px 8px 0 #000, 3px 8px 0 #000, 4px 8px 0 #000, 5px 8px 0 #000, 6px 8px 0 #000, 7px 8px 0 #000;
        animation: bobbit-loading-squash 0.75s cubic-bezier(0.45, 0, 0.55, 1) infinite;
      }
      .bobbit-loading-shadow {
        position: absolute;
        bottom: 58px;
        left: calc(54% + 4px);
        width: 1px;
        height: 1px;
        image-rendering: pixelated;
        transform: scale(4);
        transform-origin: top left;
        animation: bobbit-loading-shadow-anim 0.75s cubic-bezier(0.45, 0, 0.55, 1) infinite;
        z-index: 1;
      }
      .bobbit-loading-sweat {
        position: absolute;
        z-index: 11;
        animation: bobbit-loading-bounce 0.75s cubic-bezier(0.45, 0, 0.55, 1) infinite;
        bottom: 66px;
        left: calc(54% - 4px);
      }
      .bobbit-loading-sweat-drop {
        position: absolute;
        width: 4px;
        height: 4px;
        background: #7dd3fc;
        image-rendering: pixelated;
        opacity: 0;
      }
      .bobbit-loading-sweat-drop:nth-child(1) { animation: bobbit-loading-sweat-fly1 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
      .bobbit-loading-sweat-drop:nth-child(2) { animation: bobbit-loading-sweat-fly2 1.5s cubic-bezier(0.4, 0, 0.2, 1) infinite; animation-delay: 0.75s; }
      .bobbit-loading-dust {
        position: absolute;
        bottom: 60px;
        left: 54%;
        z-index: 5;
      }
      .bobbit-loading-dust-px {
        position: absolute;
        width: 4px;
        height: 4px;
        background: rgba(142, 198, 63, 0.45);
        image-rendering: pixelated;
        opacity: 0;
      }
      .bobbit-loading-dust-px:nth-child(1) { animation: bobbit-loading-dust1 0.75s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
      .bobbit-loading-dust-px:nth-child(2) { animation: bobbit-loading-dust2 0.75s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
      .bobbit-loading-dust-px:nth-child(3) { animation: bobbit-loading-dust3 0.75s cubic-bezier(0.4, 0, 0.2, 1) infinite; }

      @keyframes bobbit-loading-camera-lag {
        0%   { transform: translate(0, 0); }
        8%   { transform: translate(-0.8px, 0.3px); }
        18%  { transform: translate(-2.2px, 0.7px); }
        30%  { transform: translate(-0.5px, 0.2px); }
        42%  { transform: translate(1.5px, -0.3px); }
        55%  { transform: translate(0.3px, 0.1px); }
        65%  { transform: translate(-1px, 0.4px); }
        78%  { transform: translate(1.8px, -0.4px); }
        90%  { transform: translate(0.5px, -0.1px); }
        100% { transform: translate(0, 0); }
      }
      @keyframes bobbit-loading-bounce {
        0%   { transform: translateY(0); }
        2%   { transform: translateY(1px); }
        5%   { transform: translateY(3px); }
        8%   { transform: translateY(2px); }
        12%  { transform: translateY(-4px); }
        17%  { transform: translateY(-12px); }
        22%  { transform: translateY(-20px); }
        28%  { transform: translateY(-28px); }
        34%  { transform: translateY(-34px); }
        39%  { transform: translateY(-37px); }
        43%  { transform: translateY(-38px); }
        47%  { transform: translateY(-38.5px); }
        50%  { transform: translateY(-38.5px); }
        53%  { transform: translateY(-38px); }
        57%  { transform: translateY(-37px); }
        62%  { transform: translateY(-34px); }
        67%  { transform: translateY(-28px); }
        73%  { transform: translateY(-20px); }
        79%  { transform: translateY(-12px); }
        84%  { transform: translateY(-6px); }
        89%  { transform: translateY(-2px); }
        93%  { transform: translateY(0px); }
        96%  { transform: translateY(1.5px); }
        98%  { transform: translateY(1px); }
        100% { transform: translateY(0); }
      }
      @keyframes bobbit-loading-squash {
        0%   { transform: scale(4) scaleX(1.28) scaleY(0.68) rotate(1.8deg); }
        2%   { transform: scale(4) scaleX(1.30) scaleY(0.65) rotate(2deg); }
        5%   { transform: scale(4) scaleX(1.32) scaleY(0.62) rotate(2.2deg); }
        8%   { transform: scale(4) scaleX(1.22) scaleY(0.75) rotate(1.5deg); }
        12%  { transform: scale(4) scaleX(1.0)  scaleY(1.0)  rotate(0deg); }
        17%  { transform: scale(4) scaleX(0.85) scaleY(1.18) rotate(-1deg); }
        22%  { transform: scale(4) scaleX(0.78) scaleY(1.26) rotate(-1.8deg); }
        28%  { transform: scale(4) scaleX(0.74) scaleY(1.32) rotate(-2.2deg); }
        34%  { transform: scale(4) scaleX(0.72) scaleY(1.34) rotate(-2deg); }
        39%  { transform: scale(4) scaleX(0.78) scaleY(1.24) rotate(-1.2deg); }
        43%  { transform: scale(4) scaleX(0.84) scaleY(1.17) rotate(-0.6deg); }
        47%  { transform: scale(4) scaleX(0.88) scaleY(1.12) rotate(-0.2deg); }
        50%  { transform: scale(4) scaleX(0.90) scaleY(1.10) rotate(0deg); }
        53%  { transform: scale(4) scaleX(0.88) scaleY(1.12) rotate(0.2deg); }
        57%  { transform: scale(4) scaleX(0.84) scaleY(1.17) rotate(0.5deg); }
        62%  { transform: scale(4) scaleX(0.78) scaleY(1.26) rotate(1deg); }
        67%  { transform: scale(4) scaleX(0.74) scaleY(1.32) rotate(1.5deg); }
        73%  { transform: scale(4) scaleX(0.80) scaleY(1.22) rotate(1.8deg); }
        79%  { transform: scale(4) scaleX(0.90) scaleY(1.08) rotate(2deg); }
        84%  { transform: scale(4) scaleX(1.02) scaleY(0.94) rotate(2deg); }
        89%  { transform: scale(4) scaleX(1.12) scaleY(0.84) rotate(2deg); }
        93%  { transform: scale(4) scaleX(1.22) scaleY(0.74) rotate(1.8deg); }
        96%  { transform: scale(4) scaleX(1.28) scaleY(0.68) rotate(1.8deg); }
        98%  { transform: scale(4) scaleX(1.28) scaleY(0.68) rotate(1.8deg); }
        100% { transform: scale(4) scaleX(1.28) scaleY(0.68) rotate(1.8deg); }
      }
      @keyframes bobbit-loading-shadow-anim {
        0%   { box-shadow:
          1px 0 0 rgba(0,0,0,0.16), 2px 0 0 rgba(0,0,0,0.24), 3px 0 0 rgba(0,0,0,0.30),
          4px 0 0 rgba(0,0,0,0.34), 5px 0 0 rgba(0,0,0,0.30), 6px 0 0 rgba(0,0,0,0.24),
          7px 0 0 rgba(0,0,0,0.16); }
        5%   { box-shadow:
          1px 0 0 rgba(0,0,0,0.18), 2px 0 0 rgba(0,0,0,0.27), 3px 0 0 rgba(0,0,0,0.34),
          4px 0 0 rgba(0,0,0,0.38), 5px 0 0 rgba(0,0,0,0.34), 6px 0 0 rgba(0,0,0,0.27),
          7px 0 0 rgba(0,0,0,0.18); }
        12%  { box-shadow:
          1px 0 0 rgba(0,0,0,0.14), 2px 0 0 rgba(0,0,0,0.20), 3px 0 0 rgba(0,0,0,0.26),
          4px 0 0 rgba(0,0,0,0.28), 5px 0 0 rgba(0,0,0,0.26), 6px 0 0 rgba(0,0,0,0.20),
          7px 0 0 rgba(0,0,0,0.14); }
        28%  { box-shadow:
          3px 0 0 rgba(0,0,0,0.06), 4px 0 0 rgba(0,0,0,0.10), 5px 0 0 rgba(0,0,0,0.06); }
        40%  { box-shadow:
          3px 0 0 rgba(0,0,0,0.03), 4px 0 0 rgba(0,0,0,0.05), 5px 0 0 rgba(0,0,0,0.03); }
        47%  { box-shadow:
          4px 0 0 rgba(0,0,0,0.02), 5px 0 0 rgba(0,0,0,0.03); }
        50%  { box-shadow:
          4px 0 0 rgba(0,0,0,0.02), 5px 0 0 rgba(0,0,0,0.02); }
        53%  { box-shadow:
          4px 0 0 rgba(0,0,0,0.02), 5px 0 0 rgba(0,0,0,0.03); }
        62%  { box-shadow:
          3px 0 0 rgba(0,0,0,0.04), 4px 0 0 rgba(0,0,0,0.07), 5px 0 0 rgba(0,0,0,0.04); }
        75%  { box-shadow:
          2px 0 0 rgba(0,0,0,0.10), 3px 0 0 rgba(0,0,0,0.16), 4px 0 0 rgba(0,0,0,0.20),
          5px 0 0 rgba(0,0,0,0.16), 6px 0 0 rgba(0,0,0,0.10); }
        90%  { box-shadow:
          1px 0 0 rgba(0,0,0,0.14), 2px 0 0 rgba(0,0,0,0.22), 3px 0 0 rgba(0,0,0,0.28),
          4px 0 0 rgba(0,0,0,0.32), 5px 0 0 rgba(0,0,0,0.28), 6px 0 0 rgba(0,0,0,0.22),
          7px 0 0 rgba(0,0,0,0.14); }
        100% { box-shadow:
          1px 0 0 rgba(0,0,0,0.16), 2px 0 0 rgba(0,0,0,0.24), 3px 0 0 rgba(0,0,0,0.30),
          4px 0 0 rgba(0,0,0,0.34), 5px 0 0 rgba(0,0,0,0.30), 6px 0 0 rgba(0,0,0,0.24),
          7px 0 0 rgba(0,0,0,0.16); }
      }
      @keyframes bobbit-loading-sweat-fly1 {
        0%   { opacity: 0;    transform: translate(0, 0); }
        2%   { opacity: 0.5;  transform: translate(-1px, -1px); }
        6%   { opacity: 0.75; transform: translate(-4px, -5px); }
        15%  { opacity: 0.6;  transform: translate(-10px, -14px); }
        30%  { opacity: 0.4;  transform: translate(-18px, -22px); }
        50%  { opacity: 0.2;  transform: translate(-26px, -18px); }
        75%  { opacity: 0.08; transform: translate(-32px, -4px); }
        100% { opacity: 0;    transform: translate(-36px, 6px); }
      }
      @keyframes bobbit-loading-sweat-fly2 {
        0%   { opacity: 0;    transform: translate(4px, -6px); }
        2%   { opacity: 0.4;  transform: translate(3px, -7px); }
        6%   { opacity: 0.65; transform: translate(0px, -10px); }
        15%  { opacity: 0.5;  transform: translate(-6px, -18px); }
        30%  { opacity: 0.35; transform: translate(-12px, -26px); }
        50%  { opacity: 0.18; transform: translate(-20px, -20px); }
        75%  { opacity: 0.06; transform: translate(-26px, -6px); }
        100% { opacity: 0;    transform: translate(-30px, 4px); }
      }
      @keyframes bobbit-loading-dust1 {
        0%, 90%  { opacity: 0; transform: translate(0, 0); }
        92%      { opacity: 0.15; transform: translate(-2px, -1px); }
        94%      { opacity: 0.4;  transform: translate(-6px, -3px); }
        96%      { opacity: 0.3;  transform: translate(-10px, -5px); }
        98%      { opacity: 0.15; transform: translate(-15px, -8px); }
        100%     { opacity: 0;    transform: translate(-18px, -9px); }
      }
      @keyframes bobbit-loading-dust2 {
        0%, 91%  { opacity: 0; transform: translate(0, 0); }
        93%      { opacity: 0.12; transform: translate(-3px, -2px); }
        95%      { opacity: 0.35; transform: translate(-8px, -5px); }
        97%      { opacity: 0.2;  transform: translate(-14px, -9px); }
        99%      { opacity: 0.08; transform: translate(-20px, -12px); }
        100%     { opacity: 0;    transform: translate(-22px, -13px); }
      }
      @keyframes bobbit-loading-dust3 {
        0%, 91.5% { opacity: 0; transform: translate(0, 0); }
        93.5%     { opacity: 0.1;  transform: translate(-1px, 0px); }
        95.5%     { opacity: 0.28; transform: translate(-4px, -1px); }
        97.5%     { opacity: 0.15; transform: translate(-8px, -2px); }
        99.5%     { opacity: 0.05; transform: translate(-13px, -3px); }
        100%      { opacity: 0;    transform: translate(-14px, -3px); }
      }
    </style>
    <div class="bobbit-loading-scene-wrap">
      <div class="bobbit-loading-camera">
        <div class="bobbit-loading-scene">
          <div class="bobbit-loading-sweat">
            <div class="bobbit-loading-sweat-drop"></div>
            <div class="bobbit-loading-sweat-drop"></div>
          </div>
          <div class="bobbit-loading-anchor">
            <div class="bobbit-loading-pixel"></div>
          </div>
          <div class="bobbit-loading-dust">
            <div class="bobbit-loading-dust-px"></div>
            <div class="bobbit-loading-dust-px"></div>
            <div class="bobbit-loading-dust-px"></div>
          </div>
          <div class="bobbit-loading-shadow"></div>
        </div>
      </div>
    </div>
  `;
}
