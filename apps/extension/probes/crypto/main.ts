const status = document.querySelector<HTMLOutputElement>("#status")!;
const results = document.querySelector<HTMLPreElement>("#results")!;
const cancelButton = document.querySelector<HTMLButtonElement>("#cancel")!;
let job: { worker: Worker; id: string; timer: ReturnType<typeof setTimeout> } | undefined;

function stop(message: string) {
  const previous = job;
  job = undefined;
  if (previous) {
    clearTimeout(previous.timer);
    previous.worker.terminate();
  }
  cancelButton.disabled = true;
  status.textContent = message;
}

function start(operation: "vectors" | "kdf") {
  stop("Loading packaged WASM");
  results.textContent = "";
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const id = crypto.randomUUID();
  job = { worker, id, timer: setTimeout(() => stop("Timed out"), 30_000) };
  cancelButton.disabled = false;
  worker.onerror = (event) => {
    event.preventDefault();
    if (job?.id === id) stop("Failed");
  };
  worker.onmessage = (event: MessageEvent<unknown>) => {
    if (job?.id !== id || !event.data || typeof event.data !== "object") return;
    const message = event.data as { id?: unknown; type?: unknown; results?: unknown };
    if (message.id !== id) return;
    if (message.type === "started") status.textContent = "Computing";
    else if (message.type === "complete") {
      results.textContent = JSON.stringify(message.results);
      stop("Complete");
    } else if (message.type === "failed") stop("Failed");
  };
  worker.postMessage({ id, operation });
}

document.querySelector("#run-vectors")!.addEventListener("click", () => start("vectors"));
document.querySelector("#run-kdf")!.addEventListener("click", () => start("kdf"));
cancelButton.addEventListener("click", () => stop("Cancelled"));
window.addEventListener("pagehide", () => stop("Closed"));
