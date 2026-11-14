import {
  publicEventUpdateSchema,
  type PublicEventUpdate,
} from "@weekbox/shared";

export class EventHub {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      let payload: unknown;
      try {
        payload = await request.json();
      } catch {
        return new Response("Invalid JSON", { status: 400 });
      }
      await this.publish(payload);
      return new Response(null, { status: 204 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async publish(input: unknown): Promise<void> {
    const notification = publicEventUpdateSchema.safeParse(input);
    if (!notification.success) {
      throw new Error("Invalid public event update notification");
    }

    const payload = JSON.stringify(
      notification.data satisfies PublicEventUpdate,
    );
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(payload);
      } catch {
        continue;
      }
    }
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    let type: string | undefined;
    try {
      const parsed = JSON.parse(
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message),
      ) as { type?: string };
      type = parsed.type;
    } catch {
      type = undefined;
    }
    if (type === "ping") {
      socket.send(
        JSON.stringify({ type: "pong", at: new Date().toISOString() }),
      );
      return;
    }
    socket.close(1008, "Only ping messages are supported");
  }
}
