const status = document.querySelector<HTMLOutputElement>("#status")!;
const results = document.querySelector<HTMLPreElement>("#results")!;
let job: { worker: Worker; id: string; timer: ReturnType<typeof setTimeout> } | undefined;

function stop(message: string) {
  const previous = job;
  job = undefined;
  if (previous) {
    clearTimeout(previous.timer);
    previous.worker.terminate();
  }
  status.textContent = message;
}

function start() {
  stop("Loading packaged WASM");
  results.textContent = "";
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  job = { worker, id, timer: setTimeout(() => stop("Timed out"), 30_000) };
  worker.onerror = (event) => {
    event.preventDefault();
    if (job?.id === id) stop("Failed");
  };
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (job?.id !== id || !event.data || typeof event.data !== "object") return;
    const message = event.data as { type?: unknown; results?: unknown };
    if (message.type === "started") status.textContent = "Computing";
    else if (message.type === "complete") {
      results.textContent = JSON.stringify(message.results);
      stop("Complete");
    } else if (message.type === "failed") stop("Failed");
  };
}

document.querySelector("#run-vectors")!.addEventListener("click", start);
window.addEventListener("pagehide", () => stop("Closed"));
