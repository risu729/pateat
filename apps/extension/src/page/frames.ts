// The page's own turns that a wait for its handlers waits on, instead of a timer (ADR 0082).

/**
 * Waits one task, so the page's handlers for a typed character and their microtasks run
 * before the next one. It is no timer, which Chrome throttles on a hidden page to a
 * second or, after five minutes hidden, to a minute.
 */
export function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * How long a shown page's next frame is awaited before the wait goes on without it: a
 * frame Chrome does not render, as an off-screen or `display: none` frame's, sends no
 * animation frame while its document still reads as shown. A bound only; a rendered page
 * answers within a frame (about 16 ms).
 */
const FRAME_BOUND_MS = 100;

/**
 * Waits for the page's next rendered frame, so the page's handlers for what came before,
 * their microtasks and the timers and tasks they queued for now have run, and what they
 * changed is rendered. A hidden page renders no frame: it waits one task
 * ({@link nextTask}), which Chrome does not throttle as it throttles a hidden page's
 * timers. A page hidden while the frame is awaited goes on at once.
 */
export function nextFrame(view: Window = window): Promise<void> {
  const { document } = view;
  if (document.hidden) return nextTask();
  return new Promise<void>((resolve) => {
    let frame: number | undefined;
    let bound: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(bound);
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", done);
      resolve();
    };
    bound = setTimeout(done, FRAME_BOUND_MS);
    document.addEventListener("visibilitychange", done);
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      done();
    });
  });
}
