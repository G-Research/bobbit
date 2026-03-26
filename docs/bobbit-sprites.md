# Bobbit Iconography & Animation System

## 1. Overview

The **Bobbit** is a squishy green pixel-art blob — think Stardew Valley slime — that serves as the app's mascot and living status indicator. It appears in three UI contexts:

- **Sidebar** — a tiny 1.6× scale sprite next to each session, showing status at a glance
- **Chat blob** — a larger 3.5× scale animated character in the `StreamingMessageContainer`, expressing the agent's activity state through Disney-style animations
- **Role page** — inline blobs at arbitrary sizes inside role cards and the accessory picker

The bobbit is drawn entirely with CSS `box-shadow` — no images, no SVGs. Each pixel is a 1px box-shadow at integer coordinates, scaled up via `transform: scale()`. Accessories (crown, bandana, magnifying glass, etc.) are separate overlay `<div>`s with their own box-shadow pixel art, counter-hue-rotated to maintain color stability across session identities.

---

## 2. Pixel Art System

### The box-shadow grid technique

Every bobbit sprite is a `1px × 1px` element with `overflow: visible` whose visual appearance comes entirely from CSS `box-shadow`. Each shadow entry places one "pixel":

```css
/* Format: Xpx Ypx 0 COLOR */
3px 0px 0 #000,       /* pixel at column 3, row 0 — black outline */
3px 1px 0 #8ec63f,    /* pixel at column 3, row 1 — green body */
```

The native sprite grid is **10 columns × 9 rows** (coordinates 0–9 horizontal, 0–8 vertical). The body spans from roughly (0,3) to (9,8) with a rounded top from (3,0) to (7,0). Eyes sit at rows 4–5 as dark `#1a3010` pixels.

### Scale factors

| Context | Scale | Display size | CSS |
|---------|-------|-------------|-----|
| Sidebar | 1.6× | ~16×14px | `transform: scale(1.6)` |
| Chat blob | 4× | ~40×36px | `transform: scale(4)` |
| Role page inline | Variable | Arbitrary via outer container | Viewport wrapper with `transform: scale(size/66)` |

### image-rendering: pixelated

All sprite elements use `image-rendering: pixelated` to prevent the browser from anti-aliasing the box-shadow edges. This keeps the pixel art crisp at all scales.

### Transform origin

- **Sidebar**: `transform-origin: 0 0` (top-left)
- **Chat blob**: `transform-origin: 5px 8px` (center-bottom of the 10×9 grid) — this anchor point is critical because all bounce/squash animations pivot around the bobbit's "feet"

---

## 3. Color & Identity

### The Aurora Borealis palette

`BOBBIT_HUE_ROTATIONS` in `session-colors.ts` defines 20 curated hue-rotation offsets from the canonical green (hue ~90°):

```typescript
export const BOBBIT_HUE_ROTATIONS = [
  0, 25, 50, 75, 100, 125, 150, 175, 200, 225,
  -135, -110, -85, -60, -35, -10, 15, 40, 65, 250,
];
```

These flow from greens → teals → blues → purples → pinks and back, creating a smooth aurora-like spectrum.

### Session color assignment

Each session gets a unique color via `sessionHueRotation(sessionId)`:

1. Check `sessionColorMap` for an existing assignment
2. If none, find the first unused palette index
3. Persist the assignment server-side via `patchSession(sessionId, { colorIndex })`

The CSS variable `--bobbit-hue-rotate` is set on `document.documentElement` when a session is activated:

```typescript
document.documentElement.style.setProperty(
  "--bobbit-hue-rotate", `${sessionHueRotation(sessionId)}deg`
);
```

The `.bobbit-blob` container applies this via:

```css
.bobbit-blob {
  filter: hue-rotate(var(--bobbit-hue-rotate, 0deg));
}
```

### Counter-hue-rotate on accessories

Since accessories sit inside the hue-rotated blob container, they would inherit the session's color. To keep accessories at their intended colors (gold crown, red bandana, blue magnifier, etc.), each accessory overlay applies a **counter-hue-rotate**:

```css
filter: hue-rotate(calc(-1 * var(--bobbit-hue-rotate, 0deg)));
```

**Exception: Flask** — The flask intentionally does NOT counter-rotate. Its blue liquid shifts with the session hue, creating a "magical potion" effect where each session's flask appears to contain a different-colored liquid.

### Status-based colors (sidebar only)

The sidebar `statusBobbit()` function uses hardcoded color palettes instead of hue-rotate for special states:

| Status | Main | Light | Dark | Eye |
|--------|------|-------|------|-----|
| Normal | `#8ec63f` | `#b5d98a` | `#6b9930` | `#1a3010` |
| Starting | `#eab308` | `#fde047` | `#ca8a04` | `#2d2006` |
| Terminated | `#ef4444` | `#fca5a5` | `#dc2626` | `#2c0b0e` |

---

## 4. Accessories

### Registry

All accessories are defined in the `ACCESSORIES` record in `session-colors.ts`. Each entry has:

```typescript
interface AccessoryDefinition {
  id: string;        // e.g. "crown", "bandana"
  label: string;     // Human-readable name
  shadow: string;    // CSS box-shadow pixel art at 1px scale
  yOffset: number;   // Vertical positioning offset
  addsHeight: boolean; // Whether it extends above the sprite
}
```

### Complete accessory catalog

| ID | Label | Category | addsHeight | Visual Description | Special Behavior |
|----|-------|----------|------------|-------------------|------------------|
| `none` | None | — | false | No accessory | — |
| `crown` | Crown | Head-worn | **true** | Gold crown with three points and a red jewel. Yellow (`#fef08a`, `#fde047`) and gold (`#ca8a04`, `#eab308`) tones. | Adds 4px top padding to blob container; `translateX(-0.5px)` nudge in sidebar |
| `bandana` | Bandana | Head-worn | false | Red headband (`#ef4444`, `#dc2626`, `#b91c1c`) with a trailing knot/tail on the right side. | Tail hides when facing right; shifts up (`translate: 0 -1.75px`) to sit on forehead; has dedicated `blob-bandana-shadow` keyframes that sync tail visibility with eye direction |
| `magnifier` | Magnifying Glass | Hand-held | false | Circular glass lens (light blue `#87ceeb`, `#b0e0f0`, `#e0f4ff`) with brown handle (`#8b4513`). | Uses `magnifier-depth-busy/idle` z-index keyframes to go behind body when facing right |
| `palette` | Paint Palette | Hand-held | false | Brown wooden palette (`#a16207`) with three paint dots: red, green, blue. | Depth keyframes; `translate(-0.5px, -0.5px)` offset |
| `pencil` | Pencil | Hand-held | false | Yellow pencil body (`#fde047`, `#fbbf24`) with pink eraser (`#f9a8d4`, `#ec4899`), silver ferrule (`#9ca3af`, `#d1d5db`), wood section (`#f4a460`, `#cd853f`), and graphite tip (`#4b5563`). | Depth keyframes |
| `shield` | Shield | Hand-held | false | Pointed shield in silver/grey (`#9ca3af`, `#d1d5db`, `#f3f4f6`) with a red cross emblem (`#ef4444`). | Depth keyframes |
| `set-square` | Set Square | Hand-held | false | Right-angle triangle ruler in blue (`#93c5fd`, `#bfdbfe`) with a cutout hole in the center. | Depth keyframes |
| `flask` | Flask | Hand-held | false | Erlenmeyer flask with brown cork (`#8b4513`), blue liquid gradient (light `#7dd3fc` → dark `#082f49`), dark edges (`#1e3a5f`). | **No counter-hue-rotate** — intentionally shifts color with session. Has `::before`/`::after` pseudo-element bubble animations (`flask-bubbles` keyframes). Depth keyframes. |

### Head-worn vs hand-held

- **Head-worn** (crown, bandana): Positioned on top of/around the bobbit's head. Follow the body transform directly. The bandana has special box-shadow keyframes to hide its trailing tail when the bobbit faces right.
- **Hand-held** (magnifier, palette, pencil, shield, set-square, flask): Positioned on the right side of the bobbit body. Use **depth keyframes** (`magnifier-depth-busy`, `magnifier-depth-idle`) to toggle `z-index` between `1` (in front) and `-1` (behind) when the bobbit faces right, creating the illusion of the item being held on the far side.

### addsHeight behavior

Only the crown sets `addsHeight: true`. When active:

- The blob container gets `padding-top: 6px` to prevent the crown tips from clipping
- The inner sprite content shifts down by the `yOffset` (2px for crown → 4px display)
- The container height increases from 15px to 19px (sidebar)

---

## 5. Animation System

### Chat blob animation states

The `StreamingMessageContainer` manages a state machine with these blob states:

| State | CSS class | Trigger | Duration | Description |
|-------|-----------|---------|----------|-------------|
| `hidden` | — | Initial | — | Blob not rendered |
| `active` | `bobbit-blob` | `isStreaming = true` | Infinite loop | Full busy animation cycle |
| `idle` | `bobbit-blob--idle` | `isStreaming = false` (settled) | Infinite loop | Stationary, eyes looking around |
| `entering` | `bobbit-blob--enter` or `bobbit-blob--enter-roll` | Transition idle→active | 700ms / 900ms | Hop or barrel-roll from idle position to center |
| `exiting` | `bobbit-blob--exit` or `bobbit-blob--exit-roll` | Transition active→idle | 700ms / 900ms | Hop or barrel-roll from center to idle position |
| `compact-shake` | `bobbit-blob--compact-shake` | `startCompacting()` | 800ms | Increasingly frantic vibration |
| `compacting` | `bobbit-blob--compacting` | After shake | 3s loop | Progressive squash (hydraulic press) |
| `compact-pop` | `bobbit-blob--compact-pop` | `endCompacting()` | 600ms | Spring back to normal size |

Entry/exit variants are randomly chosen (50/50 hop vs roll) each time.

### Busy animation (`blob-busy-move`, 10s cycle)

The core busy animation is a 10-second Disney 12-principles choreography:

| Phase | Time | Description |
|-------|------|-------------|
| Bounce 1 "Oh!" | 0–19% | Big surprised bounce — deep squat (scaleY 0.72), high peak (-6px), Disney hang, satisfying land |
| Bounce 2 "Let's go!" | 19–33% | Smaller confirming bounce — shallower squat, lower peak (-3.5px), breezy settle |
| Anticipation crouch | 33–38% | Held crouch building tension before hops, leans forward (rotate 4deg) |
| Hop right (eager) | 38–57% | Two hops rightward (+6px total) with strong forward lean, escalating excitement |
| Look around | 57–70% | Arrival bounce, lean left then right, curious micro-movements |
| Hop back (relaxed) | 70–87% | Two gentle hops back to origin — lower arcs, less lean, wider spacing |
| Settle | 87–95% | Asymmetric follow-through — overshoot, counter-correct, damp |
| Moving hold | 95–100% | Never fully static — subtle breathing micro-wobble |

### Eye animation (`blob-busy-eyes`, 10s cycle, `steps(1)`)

Eyes lead body direction by 2–4% (anticipation principle). Implemented as box-shadow keyframes that redraw the entire sprite with moved eye pixels:

| Time | Eye state | Purpose |
|------|-----------|---------|
| 0–16% | Center | During bounce 1 |
| 16–18% | Blink | Between bounces |
| 34–36% | Right | Leading the rightward hops |
| 36–37% | Blink | Anticipation beat |
| 37–54% | Right | During hops |
| 60–64% | Up | Looking at chat |
| 65–68% | Left | Looking back |
| 92–94% | Blink | Satisfied "ahhh" |
| 96–98% | Right | Micro "checking in" glance |

Eye directions are achieved by shifting the 2×2 dark pixel blocks (`#1a3010`):
- **Center**: columns 3,6 at rows 4,5
- **Right**: columns 4,7 at rows 4,5
- **Left**: columns 2,5 at rows 4,5
- **Up**: columns 4,7 at rows 3,4 (shifted up one row)
- **Blink**: Only bottom row of eyes visible (squished to one row)

### Shimmer (`blob-shimmer`, 8s cycle)

A subtle pearlescent skin shift applied to the sprite via filter animation:

```css
@keyframes blob-shimmer {
  0%, 100% { filter: hue-rotate(0deg) brightness(1) saturate(1); opacity: 0.94; }
  32%      { filter: hue-rotate(35deg) brightness(1.1) saturate(1.18); opacity: 0.89; }
  /* ... asymmetric wave pattern ... */
}
```

The shimmer delay is randomized via `--bobbit-shimmer-delay` to prevent multiple blobs from shimmering in sync.

### Idle animation (`blob-idle-eyes`, 10s cycle)

When idle, the bobbit sits offset left (`translateX(-7px)`) and only its eyes animate:

| Time | Action |
|------|--------|
| 0–10% | Center eyes |
| 10–22% | Look left (at user) |
| 22–25% | Blink (left position) |
| 25–45% | Look up-right (at chat history) |
| 45–55% | Center eyes |
| 55–67% | Look right (at chat area) |
| 67–70% | Blink (right position) |
| 70–85% | Look up-right again |
| 85–93% | Center eyes |
| 93–96% | Blink (center) |
| 96–100% | Center eyes |

Blinks squish pupils to a single row in the current gaze direction. Timing is irregular (22%, 67%, 93%) to feel natural.

### Entry/exit animations

| Keyframe | Duration | Easing | Description |
|----------|----------|--------|-------------|
| `blob-enter` | 700ms | cubic-bezier(0.34, 1.56, 0.64, 1) | Squat at idle position → launch right → land at center with squash → settle |
| `blob-enter-roll` | 900ms | cubic-bezier(0.22, 1, 0.36, 1) | Squat → barrel roll arc through the air → land at center |
| `blob-exit` | 700ms | cubic-bezier(0.34, 1.56, 0.64, 1) | Squish → wiggle → hop left → settle at idle position |
| `blob-exit-roll` | 900ms | cubic-bezier(0.22, 1, 0.36, 1) | Squat → barrel roll arc → land at idle position |

All transitions move between `translateX(0)` (active center) and `translateX(-7px)` (idle left).

### Compaction animations

Three sequential phases for context compaction:

1. **Shake** (`blob-compact-shake`, 800ms): Increasingly frantic horizontal vibration (0.3px → 1.2px amplitude) with vertical scaleY oscillation. Ends in a crouched anticipation pose.

2. **Squash** (`blob-compact-squash`, 3s loop): Three progressively deeper squash-and-release cycles:
   - Slam (scaleX 1.2, scaleY 0.7)
   - Second press (scaleX 1.25, scaleY 0.6)
   - Third press (scaleX 1.35, scaleY 0.5)
   - Slowly eases back up to loop

3. **Pop** (`blob-compact-pop`, 600ms): Spring back — overshoot tall (scaleX 0.8, scaleY 1.3), then settle to normal.

Shadow is hidden during shake, squash, and pop (the non-uniform scaling makes the shadow track incorrectly).

### Rigid keyframe variants

Every animation that uses `scaleX`/`scaleY` squash-and-stretch has a **rigid variant** (e.g. `blob-busy-move-rigid`, `blob-exit-rigid`, `blob-compact-shake-rigid`). These contain the same `translateX`, `translateY`, and `rotate` values but **strip all scaleX/scaleY** transforms.

**Why**: Accessories (magnifier, shield, etc.) should move and rotate with the bobbit body but should NOT warp/squash. A magnifying glass that gets squished looks wrong. So the sprite div uses the full squash animation while accessory divs use the rigid variant to track position without deformation.

### Depth keyframes (hand-held accessories)

Hand-held accessories on the right side need to appear behind the bobbit when it faces right:

```css
@keyframes magnifier-depth-busy {
  0%, 33%    { z-index: 1; }    /* Front — facing left/center */
  34%        { z-index: -1; }   /* Behind — eyes right (hops) */
  57%        { z-index: -1; }
  58%, 95%   { z-index: 1; }    /* Front again */
  96%        { z-index: -1; }   /* Behind — micro-glance right */
  98%        { z-index: -1; }
  99%, 100%  { z-index: 1; }
}
```

The idle variant (`magnifier-depth-idle`) syncs with the idle eye cycle instead.

All hand-held accessories reuse these same keyframes (`magnifier-depth-busy`/`magnifier-depth-idle`).

### Shadow animation

The ground shadow (`bobbit-blob__shadow`) is a separate element with its own box-shadow pixel art (semi-transparent blacks at row 9). It tracks the sprite's horizontal position:

- **Busy**: `blob-busy-shadow` follows the sprite's `translateX` across hops
- **Idle**: Static at `translateX(-7px)`
- **Entry/exit**: Dedicated shadow transition keyframes (`blob-shadow-enter`, `blob-shadow-exit`, etc.)
- **Compaction**: Hidden (`display: none`)
- **Dark mode**: A `::after` pseudo-element duplicates the shadow to double the alpha for better visibility

### Flask bubble animations

The flask accessory has two pseudo-elements (`::before`, `::after`) that animate tiny bubble pixels rising from the flask neck:

```css
@keyframes flask-bubbles {
  0%, 100% { opacity: 0; transform: translateY(0); }
  20%      { opacity: 1; transform: translateY(-0.5px); }
  80%      { opacity: 0.5; transform: translateY(-2px); }
}
```

The second bubble is offset by 1s delay for a staggered effect.

### Sidebar animations (`src/app/app.css`)

| Keyframe | Duration | Description |
|----------|----------|-------------|
| `bobbit-bob` | 1.8s | Gentle vertical bounce for streaming sessions — subtle scaleY compression |
| `bobbit-breathe` | 4s | Slow scaleY pulse (1 → 1.06) for idle sessions |
| `bobbit-cancel-fade` | 1.2s | Opacity pulse (1 → 0.35) during abort |
| `bobbit-squish` | 1.5s | ScaleX/scaleY oscillation during compaction |
| `bobbit-eyes` | 6s | Blink + look right cycle for selected sessions |
| `bobbit-eyes-squash` | 6s | Same as above but with squash transform for compacting state |
| `blob-shimmer` | 8s | Reused from chat blob for streaming sidebar bobbits |

---

## 6. Rendering Contexts

### Sidebar — `statusBobbit()`

**File**: `src/app/session-colors.ts`

The `statusBobbit()` function generates a self-contained `html` template literal with inline styles. No external CSS classes — everything is inline for simplicity.

**Structure**:
```
<span container>          ← flex container, filter (hue-rotate + saturation), bob/breathe/cancel animation
  <span sprite>           ← box-shadow pixel art, base transform, shimmer animation
  <span eyeLayer?>        ← separate eye overlay for selected sessions (enables independent eye animation)
  <span accessoryLayer?>  ← counter-hue-rotated accessory overlay
</span>
```

**Key behaviors**:
- Scale: 1.6× via `transform: scale(1.6)`
- Idle sessions: `saturate(0.4)` filter + `bobbit-breathe` animation
- Streaming sessions: `bobbit-bob` animation + `blob-shimmer`
- Compacting: `bobbit-squish` animation with squash transform
- Selected session: Eye layer shown with `bobbit-eyes` animation (blink + look right)
- Aborting: `saturate(0.3)` + `bobbit-cancel-fade` opacity pulse
- Status colors: Yellow for starting, red for terminated (applied via different box-shadow colors, not hue-rotate)

### Chat blob — `StreamingMessageContainer`

**File**: `src/ui/components/StreamingMessageContainer.ts`

A Lit web component that manages the blob animation state machine.

**DOM structure**:
```html
<div class="bobbit-blob [state-class]">
  <div class="bobbit-blob__sprite"></div>
  <div class="bobbit-blob__crown"></div>
  <div class="bobbit-blob__bandana"></div>
  <div class="bobbit-blob__magnifier"></div>
  <div class="bobbit-blob__palette"></div>
  <div class="bobbit-blob__pencil"></div>
  <div class="bobbit-blob__shield"></div>
  <div class="bobbit-blob__set-square"></div>
  <div class="bobbit-blob__flask"></div>
  <div class="bobbit-blob__shadow"></div>
</div>
```

All accessory divs are always present in the DOM but hidden by default (`display: none`). They are shown via document-level CSS class selectors (see section 7).

**State machine transitions**:
- `idle` → `entering` → `active` (on `isStreaming = true`)
- `active` → `exiting` → `idle` (on `isStreaming = false`)
- `idle` → `entering` → `compact-shake` → `compacting` (on `startCompacting()`)
- `compacting` → `compact-pop` → `exiting` → `idle` (on `endCompacting()`)

Compaction has a minimum duration of 3.5s and a safety timeout of 10 minutes.

**Sprite CSS** (from `src/ui/app.css`):
- `margin: 8px 18px 28px 18px` — provides bounce space
- `transform-origin: 5px 8px` — pivot at bottom center
- Three simultaneous animations during busy: `blob-busy-move` (body), `blob-busy-eyes` (eyes), `blob-shimmer` (skin)

### Role page — `idleBlob()`

**File**: `src/app/role-manager-page.ts`

The `idleBlob()` helper renders a bobbit at arbitrary sizes for use in role cards and the accessory picker:

```typescript
function idleBlob(accId: string, size = 40, hueIndex = 0): TemplateResult
```

**Approach**: Instead of trying to restyle the blob's deeply coupled CSS, it renders the full-size blob inside a viewport container and scales the whole thing down:

1. Inner container: `66×66px` (natural size with overflow space for accessories)
2. Blob rendered at full 3.5× scale with normal margins
3. Outer container: `size × size` px with `transform: scale(size/66)`

**CSS class**: `.bobbit-blob--inline` resets chat-specific layout:
- `margin-bottom: 0` (instead of -24px)
- `position: absolute` with `left: 24px; bottom: 2px`
- Shadow hidden (`display: none`)
- Document-level accessory classes blocked; only blob-level classes apply

The accessory class is placed directly on the blob `<div>` (e.g. `bobbit-blob--inline bobbit-crowned`) instead of on `<html>`, allowing multiple inline blobs with different accessories on the same page.

---

## 7. Accessory Toggle Mechanism

### Document-level CSS classes

The active session's accessory is applied via a CSS class on `document.documentElement` (`<html>`). This is managed in `session-manager.ts` during `connectToSession()`:

```typescript
// Remove all accessory classes
const accClasses = [
  "bobbit-crowned", "bobbit-bandana", "bobbit-magnifier",
  "bobbit-palette", "bobbit-pencil", "bobbit-shield",
  "bobbit-set-square", "bobbit-flask"
];
accClasses.forEach((c) => document.documentElement.classList.remove(c));

// Add the active one
if (accId && accId !== "none") {
  const cls = accId === "crown" ? "bobbit-crowned" : `bobbit-${accId}`;
  document.documentElement.classList.add(cls);
}
```

**Note**: Crown uses `bobbit-crowned` (not `bobbit-crown`) for backward compatibility.

### CSS selector pattern

Each accessory div is hidden by default and shown when its class is on `<html>`:

```css
.bobbit-blob__magnifier { display: none; }
.bobbit-magnifier .bobbit-blob__magnifier {
  display: block;
  /* ... positioning, pixel art, animations ... */
}
```

This means only the chat blob (which is a descendant of `<html>`) shows the accessory. Inline blobs on the role page use a different mechanism (class on the blob div itself, with `!important` overrides — see `.bobbit-blob--inline` in `role-manager.css`).

---

## 8. Adding a New Accessory

### Step-by-step guide

#### 1. Registry entry (`src/app/session-colors.ts`)

Add to the `ACCESSORIES` record:

```typescript
"your-item": {
  id: "your-item",
  label: "Your Item",
  shadow: `
    /* CSS box-shadow pixel art at 1px scale */
    8px 3px 0 #000, 9px 3px 0 #color, ...
  `,
  yOffset: 0,        // Non-zero only if the item extends above the sprite
  addsHeight: false,  // true only for items that sit above the head
},
```

Position hand-held items on the right side (x ≥ 6) so they work with depth keyframes. Head-worn items should cover rows 2–4 across the body width.

#### 2. Chat blob CSS (`src/ui/app.css`)

Add the accessory overlay class with all 9 state animations:

```css
.bobbit-blob__your-item { display: none; }
.bobbit-your-item .bobbit-blob__your-item {
  display: block;
  position: absolute;
  width: 1px; height: 1px;
  overflow: visible;
  transform-origin: 5px 8px;
  transform: scale(3.5);
  margin: 8px 18px 28px 18px;
  image-rendering: pixelated;
  filter: hue-rotate(calc(-1 * var(--bobbit-hue-rotate, 0deg)));
  box-shadow: /* ... your pixel art ... */;
  animation:
    blob-busy-move-rigid 10s cubic-bezier(0.34, 1, 0.64, 1) infinite,
    magnifier-depth-busy 10s steps(1) infinite;  /* For hand-held items */
}
```

Then add idle, exit, exit-roll, enter, enter-roll, compact-shake, compacting, and compact-pop states following the pattern of existing accessories (use `-rigid` keyframe variants).

#### 3. DOM structure (`src/ui/components/StreamingMessageContainer.ts`)

Add the div to both render paths (no-message and assistant-message):

```html
<div class="bobbit-blob__your-item"></div>
```

#### 4. Toggle class (`src/app/session-manager.ts`)

Add `"bobbit-your-item"` to the `accClasses` array in `connectToSession()`.

#### 5. Inline blob support (`src/app/role-manager-page.ts` + `src/app/role-manager.css`)

In `idleBlob()`, the div is already rendered because it's in the chat blob DOM. Add to `role-manager.css`:

```css
.bobbit-blob--inline .bobbit-blob__your-item { display: none !important; }
.bobbit-blob--inline.bobbit-your-item .bobbit-blob__your-item { display: block !important; }
```

#### 6. Sidebar support (`src/app/session-colors.ts`)

The sidebar `statusBobbit()` function automatically resolves accessories via `getAccessory(id)` and renders the box-shadow. No additional code needed unless the accessory requires special positioning logic (check the bandana/crown handling for reference).

#### 7. Role assistant description (`src/server/agent/role-assistant.ts`)

Add the new accessory to the role assistant's system prompt so it knows the accessory exists and can suggest it.

---

## 9. Design Constraints

### No images or SVGs

All pixel art is pure CSS `box-shadow`. This ensures:
- No network requests for sprite assets
- Perfect scaling via `transform: scale()`
- Easy color manipulation via `filter: hue-rotate()`
- Works in any CSS context without asset loading

### Counter-hue-rotate requirement

Every accessory **must** apply `filter: hue-rotate(calc(-1 * var(--bobbit-hue-rotate, 0deg)))` unless the color shift is intentionally part of the design (like the flask).

### Sub-pixel positioning

Some accessories use fractional pixel offsets via `translateX`/`translateY` or the CSS `translate` property to achieve half-pixel positioning at the scaled-up size. Examples:
- Bandana: `translate: 0 -1.75px` (half a bobbit pixel at 3.5× scale: 0.5 × 3.5 = 1.75)
- Crown: `translateX(-0.5px)` nudge in sidebar
- Palette: `translate(-0.5px, -0.5px)` offset

### Split-pane margin-left nudge

When the chat panel shares space with a goal side panel, the bobbit gets a `margin-left: 7px` nudge:

```css
.goal-chat-panel .bobbit-blob {
  margin-left: 7px;
}
```

This prevents the bobbit from looking off-center in the narrower chat area.

### Mobile adjustments

On screens ≤ 639px:
- Chat blob gets `margin-left: 16px` to avoid hugging the screen edge (where container padding is tighter)
- This is applied via margin rather than changing `translateX` to avoid breaking the entry/exit animation transitions
