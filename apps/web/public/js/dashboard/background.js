import { asObject } from "./utils.js";

export function createBackgroundAnimator({ canvas, ctx }) {
  const nodes = [];
  let canvasWidth = 0;
  let canvasHeight = 0;
  let animationFrameId = 0;
  let activityTarget = 0.12;
  let activityCurrent = 0.12;
  let lastFrameTime = performance.now();

  function setActivityTargetValue(nextTarget) {
    const normalized = Number(nextTarget);
    if (!Number.isFinite(normalized)) {
      return;
    }
    activityTarget = Math.max(0.05, Math.min(1.5, normalized));
  }

  function setActivityFromData(orchestrator, runner) {
    const items = Object.values(asObject(orchestrator?.items));
    const activeItemStatuses = new Set(["Ready", "In Progress", "In Review", "Needs Human Approval", "Blocked"]);

    const hasActiveQueueItems = items.some((item) => activeItemStatuses.has(String(item?.last_seen_status ?? "")));

    const runs = Object.values(asObject(runner));
    const hasRunningRun = runs.some((run) => String(run?.status ?? "").toLowerCase() === "running");

    setActivityTargetValue(hasActiveQueueItems || hasRunningRun ? 1 : 0.12);
  }

  function resize() {
    if (!canvas || !ctx) {
      return;
    }

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvasWidth = window.innerWidth;
    canvasHeight = window.innerHeight;
    canvas.width = Math.floor(canvasWidth * dpr);
    canvas.height = Math.floor(canvasHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const targetCount = Math.min(140, Math.max(55, Math.floor((canvasWidth * canvasHeight) / 22000)));

    if (nodes.length > targetCount) {
      nodes.length = targetCount;
    }

    while (nodes.length < targetCount) {
      nodes.push({
        x: Math.random() * canvasWidth,
        y: Math.random() * canvasHeight,
        vx: (Math.random() * 2 - 1) * 0.35,
        vy: (Math.random() * 2 - 1) * 0.35,
        size: Math.random() * 1.5 + 0.6,
      });
    }
  }

  function animate(now) {
    if (!canvas || !ctx) {
      return;
    }

    const dt = Math.min(0.05, (now - lastFrameTime) / 1000 || 0.016);
    lastFrameTime = now;

    activityCurrent += (activityTarget - activityCurrent) * 0.04;

    const speedScale = 0.18 + activityCurrent * 1.9;
    const connectionDistance = 95 + activityCurrent * 90;
    const connectionDistanceSquared = connectionDistance * connectionDistance;
    const lineBaseAlpha = 0.03 + activityCurrent * 0.24;
    const nodeAlpha = 0.2 + activityCurrent * 0.6;

    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];

      node.x += node.vx * speedScale * (dt * 60);
      node.y += node.vy * speedScale * (dt * 60);

      if (node.x < -20) node.x = canvasWidth + 20;
      if (node.x > canvasWidth + 20) node.x = -20;
      if (node.y < -20) node.y = canvasHeight + 20;
      if (node.y > canvasHeight + 20) node.y = -20;
    }

    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > connectionDistanceSquared) {
          continue;
        }

        const distance = Math.sqrt(distanceSquared);
        const t = 1 - distance / connectionDistance;
        ctx.strokeStyle = `rgba(255,255,255,${(lineBaseAlpha * t).toFixed(4)})`;
        ctx.lineWidth = 0.5 + t * 0.9;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    for (const node of nodes) {
      ctx.fillStyle = `rgba(255,255,255,${(nodeAlpha * 0.7).toFixed(4)})`;
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.size, 0, Math.PI * 2);
      ctx.fill();
    }

    animationFrameId = window.requestAnimationFrame(animate);
  }

  function start() {
    if (!canvas || !ctx) {
      return;
    }
    if (animationFrameId) {
      return;
    }
    lastFrameTime = performance.now();
    animationFrameId = window.requestAnimationFrame(animate);
  }

  function stop() {
    if (!animationFrameId) {
      return;
    }
    window.cancelAnimationFrame(animationFrameId);
    animationFrameId = 0;
  }

  return {
    resize,
    start,
    stop,
    setActivityFromData,
    setActivityTarget: setActivityTargetValue,
  };
}
