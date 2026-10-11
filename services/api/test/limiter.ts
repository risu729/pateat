/**
 * The local limiter counts in wall-clock minutes, so a loop that crosses a minute
 * boundary would start a fresh count; start the loop at least 10 s before one.
 */
export async function awaitRoomInMinute() {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}
