/**
 * A small self-contained confetti burst.
 *
 * Written rather than pulled from a library so the module has no dependency
 * beyond socketlib, and so the burst can be aimed at the wheel's centre instead
 * of the viewport's.
 */

const COLOURS = ["#f2c14e", "#e0912f", "#4a90d9", "#a765d0", "#4caf6a", "#f5f0e6", "#c0563a"];
const GRAVITY = 0.28;
const DRAG = 0.995;
const FADE_AFTER = 0.62; // fraction of life before alpha starts dropping

/**
 * Fire confetti from a point on screen.
 *
 * @param {HTMLCanvasElement} canvas  Canvas sized to its own client box.
 * @param {object} [options]
 * @param {number} [options.originX=0.5]  Burst origin, 0–1 across the canvas.
 * @param {number} [options.originY=0.5]  Burst origin, 0–1 down the canvas.
 * @param {number} [options.count=160]    Particles.
 * @returns {() => void}  Call to stop early and release the frame loop.
 */
export function burst(canvas, {originX = 0.5, originY = 0.5, count = 160} = {}) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  ctx.scale(dpr, dpr);

  const cx = width * originX;
  const cy = height * originY;

  const particles = Array.from({length: count}, () => {
    // Bias upward so the burst arcs rather than spraying evenly in all directions.
    const angle = (Math.random() * Math.PI * 2);
    const speed = 4 + Math.random() * 11;
    return {
      x: cx,
      y: cy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 5,
      w: 5 + Math.random() * 6,
      h: 8 + Math.random() * 8,
      spin: (Math.random() - 0.5) * 0.4,
      rot: Math.random() * Math.PI * 2,
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
      life: 0,
      maxLife: 110 + Math.random() * 70
    };
  });

  let frame = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    ctx.clearRect(0, 0, width, height);

    let alive = 0;
    for (const p of particles) {
      p.life++;
      if (p.life > p.maxLife) continue;
      alive++;

      p.vy += GRAVITY;
      p.vx *= DRAG;
      p.vy *= DRAG;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.spin;

      const progress = p.life / p.maxLife;
      ctx.globalAlpha = progress < FADE_AFTER ? 1 : 1 - ((progress - FADE_AFTER) / (1 - FADE_AFTER));
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.colour;
      // Squash width by the spin phase so pieces read as tumbling foil.
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w * Math.abs(Math.cos(p.rot)), p.h);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    if (alive) frame = requestAnimationFrame(tick);
    else ctx.clearRect(0, 0, width, height);
  }

  frame = requestAnimationFrame(tick);

  return () => {
    stopped = true;
    if (frame) cancelAnimationFrame(frame);
    ctx.clearRect(0, 0, width, height);
  };
}
