export default {
  fetch(request: Request): Response {
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const pathname = new URL(request.url).pathname;

    if (pathname !== "/health") {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { ...headers, Allow: "GET, HEAD" } },
      );
    }

    return new Response(
      request.method === "HEAD"
        ? null
        : JSON.stringify({ status: "ok", service: "pateat-api", revision: PATEAT_BUILD_REVISION }),
      { headers },
    );
  },
} satisfies ExportedHandler;
