import {
  eventIdSchema,
  eventInputSchema,
  modInputSchema,
  pageQuerySchema,
  type PublicEventUpdate,
  type PublicEventUpdateInput,
  adminGrantSchema,
} from "@weekbox/shared";
import { authenticate, canAccessEvent, type AdminUser } from "./auth.js";
import { EventHub } from "./durable-objects/event-hub.js";

export { EventHub };

const json = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  Response.json(body, { status, headers });
const fail = (
  status: number,
  code: string,
  message: string,
  details?: unknown,
) =>
  json({ error: { code, message, ...(details ? { details } : {}) } }, status);
const id = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const now = () => new Date().toISOString();

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin");
  const allowedOrigins = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (origin && allowedOrigins.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
    headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, If-Match, X-WeekBox-Dev-User, Cf-Access-Jwt-Assertion",
    );
  }
  return headers;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
function validationError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}) {
  return fail(
    422,
    "validation_error",
    "Check the highlighted fields and try again",
    error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
}
function pageParams(url: URL) {
  const parsed = pageQuerySchema.safeParse(
    Object.fromEntries(url.searchParams),
  );
  if (!parsed.success) return { error: validationError(parsed.error) };
  return {
    value: {
      ...parsed.data,
      offset: (parsed.data.page - 1) * parsed.data.pageSize,
    },
  };
}

async function adminUser(
  request: Request,
  env: Env,
): Promise<AdminUser | Response> {
  const user = await authenticate(request, env);
  return (
    user ??
    fail(401, "unauthorized", "Sign in with your authorized WeekBox account")
  );
}
function adminOriginError(request: Request, env: Env): Response | null {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (
    String(env.ENVIRONMENT) === "development" &&
    String(env.DEV_AUTH) === "true" &&
    ["http://127.0.0.1:5173", "http://localhost:5173"].includes(origin)
  )
    return null;
  if (origin !== new URL(request.url).origin)
    return fail(
      403,
      "origin_forbidden",
      "Admin requests must come from the WeekBox admin origin",
    );
  return null;
}
async function eventAccess(
  user: AdminUser,
  env: Env,
  eventId: string,
): Promise<Response | null> {
  const allowed = await canAccessEvent(user, env.DB, eventId);
  if (!allowed)
    return fail(403, "forbidden", "You do not have access to this event");
  return null;
}

async function mutateEvent(
  env: Env,
  ctx: ExecutionContext,
  user: AdminUser,
  eventId: string,
  expectedVersion: number,
  action: string,
  entityType: string,
  entityId: string | null,
  statement: (mutationId: string) => D1PreparedStatement,
  notification: PublicEventUpdateInput,
) {
  const mutationId = crypto.randomUUID();
  const changedAt = now();
  const statements = [
    env.DB.prepare(
      "UPDATE event_state_versions SET version = version + 1, last_mutation_id = ?, updated_at = ? WHERE event_id = ? AND version = ?",
    ).bind(mutationId, changedAt, eventId, expectedVersion),
    statement(mutationId),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, actor_user_id, event_id, action, entity_type, entity_id, details_json)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM event_state_versions WHERE event_id = ? AND last_mutation_id = ?)`,
    ).bind(
      id("audit"),
      user.id,
      eventId,
      action,
      entityType,
      entityId,
      "{}",
      eventId,
      mutationId,
    ),
  ];
  const results = await env.DB.batch(statements);
  if (!results[0]?.meta.changes)
    return fail(
      409,
      "version_conflict",
      "This event changed elsewhere. Refresh and retry.",
    );
  const version = expectedVersion + 1;
  const update = { ...notification, eventId, version } as PublicEventUpdate;
  const objectId = env.EVENT_HUB.idFromName(eventId);
  const socket = env.EVENT_HUB.get(objectId);
  ctx.waitUntil(
    socket
      .fetch("https://event-hub/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      })
      .catch((error: unknown) =>
        console.error("event notification failed", error),
      ),
  );
  return json({ data: { version } });
}

async function publicEventById(env: Env, eventId: string) {
  return env.DB.prepare(
    "SELECT id, slug, name, description, banner_url AS bannerUrl, scheduled_starts_at AS startsAt, scheduled_ends_at AS endsAt, status FROM events WHERE id = ? AND is_visible = 1 AND status IN ('upcoming','live','ended')",
  )
    .bind(eventId)
    .first<Record<string, unknown>>();
}

async function handlePublic(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/v1/events") {
    const rows = await env.DB.prepare(
      `SELECT e.id, e.slug, e.name, e.description, e.banner_url AS bannerUrl,
      e.scheduled_starts_at AS startsAt, e.scheduled_ends_at AS endsAt, e.status, COALESCE(v.version, 1) AS version
      FROM events e LEFT JOIN event_state_versions v ON v.event_id=e.id
      WHERE e.is_visible=1 AND e.status IN ('upcoming','live','ended') ORDER BY COALESCE(e.scheduled_starts_at,'9999-12-31T23:59:59Z') LIMIT 100`,
    ).all();
    return json({ data: rows.results }, 200, {
      "Cache-Control":
        "public, max-age=0, s-maxage=15, stale-while-revalidate=15",
    });
  }
  const detail = /^\/api\/v1\/events\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && detail) {
    const eventId = eventIdSchema.safeParse(detail[1]);
    if (!eventId.success)
      return fail(400, "invalid_event_id", "Invalid event ID");
    const event = await publicEventById(env, eventId.data);
    if (!event) return fail(404, "not_found", "Event not found");
    const version = await env.DB.prepare(
      "SELECT version FROM event_state_versions WHERE event_id=?",
    )
      .bind(eventId.data)
      .first<{ version: number }>();
    return json(
      { data: event, meta: { version: version?.version ?? 1 } },
      200,
      {
        "Cache-Control":
          "public, max-age=0, s-maxage=15, stale-while-revalidate=15",
      },
    );
  }
  const child = /^\/api\/v1\/events\/([^/]+)\/(mods|live)$/.exec(url.pathname);
  if (child && request.method === "GET") {
    const parsedId = eventIdSchema.safeParse(child[1]);
    if (!parsedId.success)
      return fail(400, "invalid_event_id", "Invalid event ID");
    const event = await publicEventById(env, parsedId.data);
    if (!event) return fail(404, "not_found", "Event not found");
    if (child[2] === "live") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
        return fail(426, "upgrade_required", "WebSocket required");
      return env.EVENT_HUB.get(env.EVENT_HUB.idFromName(parsedId.data)).fetch(
        request,
      );
    }
    const version = await env.DB.prepare(
      "SELECT version FROM event_state_versions WHERE event_id=?",
    )
      .bind(parsedId.data)
      .first<{ version: number }>();
    const rows = await env.DB.prepare(
      `SELECT id, identifier, title, description, artwork_url AS artworkUrl,
      external_url AS externalUrl, position, revealed_at AS revealedAt FROM event_mods
      WHERE event_id=? AND visibility='revealed' ORDER BY position`,
    )
      .bind(parsedId.data)
      .all();
    return json(
      { data: rows.results, meta: { version: version?.version ?? 1 } },
      200,
      {
        "Cache-Control":
          "public, max-age=0, s-maxage=15, stale-while-revalidate=15",
      },
    );
  }
  return null;
}

async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/v1/admin/")) return null;
  const user = await adminUser(request, env);
  if (user instanceof Response) return user;
  const originError = adminOriginError(request, env);
  if (originError) return originError;
  const path = url.pathname.slice("/api/v1/admin".length);

  if (request.method === "GET" && path === "/me")
    return json({
      data: {
        id: user.id,
        email: user.email,
        name: user.display_name,
        role: user.role,
      },
    });

  if (path === "/events" && request.method === "GET") {
    const page = pageParams(url);
    if (page.error) return page.error;
    const { search, pageSize, offset } = page.value;
    const roleFilter =
      user.role === "owner"
        ? ""
        : " AND EXISTS (SELECT 1 FROM event_permissions ep WHERE ep.event_id=e.id AND ep.user_id=?)";
    const bindings: (string | number)[] = [];
    const where = "WHERE (e.name LIKE ? OR e.slug LIKE ?)" + roleFilter;
    bindings.push(`%${search}%`, `%${search}%`);
    if (user.role !== "owner") bindings.push(user.id);
    const rows = await env.DB.prepare(
      `SELECT e.id,e.slug,e.name,e.description,e.banner_url AS bannerUrl,e.scheduled_starts_at AS startsAt,e.scheduled_ends_at AS endsAt,e.status,e.is_visible AS isVisible,COALESCE(v.version,1) AS version FROM events e LEFT JOIN event_state_versions v ON v.event_id=e.id ${where} ORDER BY e.updated_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, pageSize, offset)
      .all();
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS total FROM events e ${where}`,
    )
      .bind(...bindings)
      .first<{ total: number }>();
    return json({
      data: rows.results,
      meta: { page: page.value.page, pageSize, total: count?.total ?? 0 },
    });
  }
  if (path === "/events" && request.method === "POST") {
    if (user.role !== "owner")
      return fail(403, "forbidden", "Only owners can create events");
    const input = eventInputSchema.safeParse(await readJson(request));
    if (!input.success) return validationError(input.error);
    const eventId = id("event");
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO events (id,slug,name,description,banner_url,starts_at,ends_at,status,is_visible,scheduled_starts_at,scheduled_ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        ).bind(
          eventId,
          input.data.slug,
          input.data.name,
          input.data.description,
          input.data.bannerUrl ?? null,
          input.data.startsAt ?? "0001-01-01T00:00:00.000Z",
          input.data.endsAt ?? "0001-01-02T00:00:00.000Z",
          input.data.status,
          input.data.isVisible ? 1 : 0,
          input.data.startsAt,
          input.data.endsAt,
        ),
        env.DB.prepare(
          "INSERT INTO event_state_versions (event_id,version) VALUES (?,1)",
        ).bind(eventId),
        env.DB.prepare(
          "INSERT INTO audit_logs (id,actor_user_id,event_id,action,entity_type,entity_id) VALUES (?,?,?,'created','event',?)",
        ).bind(id("audit"), user.id, eventId, eventId),
      ]);
    } catch (error) {
      const existing = await env.DB.prepare("SELECT 1 FROM events WHERE slug=?")
        .bind(input.data.slug)
        .first();
      if (existing)
        return fail(
          409,
          "event_conflict",
          "An event with that slug already exists",
        );
      throw error;
    }
    return json({ data: { id: eventId, ...input.data, version: 1 } }, 201);
  }

  const eventPath = /^\/events\/([^/]+)$/.exec(path);
  if (eventPath) {
    const eventId = eventIdSchema.safeParse(eventPath[1]);
    if (!eventId.success)
      return fail(400, "invalid_event_id", "Invalid event ID");
    if (request.method === "GET") {
      const denied = await eventAccess(user, env, eventId.data);
      if (denied) return denied;
      const event = await env.DB.prepare(
        `SELECT e.id,e.slug,e.name,e.description,e.banner_url AS bannerUrl,e.scheduled_starts_at AS startsAt,e.scheduled_ends_at AS endsAt,e.status,e.is_visible AS isVisible,COALESCE(v.version,1) AS version FROM events e LEFT JOIN event_state_versions v ON v.event_id=e.id WHERE e.id=?`,
      )
        .bind(eventId.data)
        .first();
      return event
        ? json({ data: event })
        : fail(404, "not_found", "Event not found");
    }
    if (request.method === "PATCH") {
      const denied = await eventAccess(user, env, eventId.data);
      if (denied) return denied;
      const body = (await readJson(request)) as Record<string, unknown>;
      const parsed = eventInputSchema.safeParse(body);
      if (!parsed.success) return validationError(parsed.error);
      const expected = Number(request.headers.get("If-Match") ?? body.version);
      if (!Number.isInteger(expected) || expected < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const old = await env.DB.prepare(
        `SELECT e.slug,e.name,e.description,e.banner_url,e.scheduled_starts_at,e.scheduled_ends_at,e.status,e.is_visible,
        COALESCE(v.version,1) AS version FROM events e LEFT JOIN event_state_versions v ON v.event_id=e.id WHERE e.id=?`,
      )
        .bind(eventId.data)
        .first<{
          slug: string;
          name: string;
          description: string;
          banner_url: string | null;
          scheduled_starts_at: string | null;
          scheduled_ends_at: string | null;
          status: string;
          is_visible: number;
          version: number;
        }>();
      if (!old) return fail(404, "not_found", "Event not found");
      if (expected !== old.version)
        return fail(
          409,
          "version_conflict",
          "This event changed elsewhere. Refresh and retry.",
        );
      const slugOwner = await env.DB.prepare(
        "SELECT id FROM events WHERE slug=? AND id<>?",
      )
        .bind(parsed.data.slug, eventId.data)
        .first();
      if (slugOwner)
        return fail(
          409,
          "slug_conflict",
          "That event URL slug is already in use",
        );
      const unchanged =
        old.slug === parsed.data.slug &&
        old.name === parsed.data.name &&
        old.description === parsed.data.description &&
        old.banner_url === (parsed.data.bannerUrl ?? null) &&
        old.scheduled_starts_at === parsed.data.startsAt &&
        old.scheduled_ends_at === parsed.data.endsAt &&
        old.status === parsed.data.status &&
        Boolean(old.is_visible) === parsed.data.isVisible;
      if (unchanged) return json({ data: { version: old.version } });
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `UPDATE events SET slug=?,name=?,description=?,banner_url=?,starts_at=?,ends_at=?,status=?,is_visible=?,updated_at=?,scheduled_starts_at=?,scheduled_ends_at=?
        WHERE id=? AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(
          parsed.data.slug,
          parsed.data.name,
          parsed.data.description,
          parsed.data.bannerUrl ?? null,
          parsed.data.startsAt ?? "0001-01-01T00:00:00.000Z",
          parsed.data.endsAt ?? "0001-01-02T00:00:00.000Z",
          parsed.data.status,
          parsed.data.isVisible ? 1 : 0,
          now(),
          parsed.data.startsAt,
          parsed.data.endsAt,
          eventId.data,
          eventId.data,
          mutationId,
        );
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        expected,
        "updated",
        "event",
        eventId.data,
        statement,
        old.status !== parsed.data.status && parsed.data.status === "live"
          ? { type: "event_started" }
          : old.status !== parsed.data.status && parsed.data.status === "ended"
            ? { type: "event_ended" }
            : { type: "event_sync" },
      );
    }
    if (request.method === "DELETE") {
      const denied = await eventAccess(user, env, eventId.data);
      if (denied) return denied;
      if (user.role !== "owner")
        return fail(403, "forbidden", "Only owners can archive events");
      const expected = Number(request.headers.get("If-Match"));
      if (!Number.isInteger(expected) || expected < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const current = await env.DB.prepare(
        "SELECT e.status,COALESCE(v.version,1) AS version FROM events e LEFT JOIN event_state_versions v ON v.event_id=e.id WHERE e.id=?",
      )
        .bind(eventId.data)
        .first<{ status: string; version: number }>();
      if (!current) return fail(404, "not_found", "Event not found");
      if (expected !== current.version)
        return fail(
          409,
          "version_conflict",
          "This event changed elsewhere. Refresh and retry.",
        );
      if (current.status === "archived")
        return json({ data: { version: current.version } });
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `UPDATE events SET status='archived',is_visible=0,updated_at=? WHERE id=? AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(now(), eventId.data, eventId.data, mutationId);
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        expected,
        "archived",
        "event",
        eventId.data,
        statement,
        { type: "event_sync" },
      );
    }
  }

  const modsPath =
    /^\/events\/([^/]+)\/mods(?:\/([^/]+)(?:\/(reveal|hide))?)?$/.exec(path);
  if (modsPath) {
    const eventId = eventIdSchema.safeParse(modsPath[1]);
    if (!eventId.success)
      return fail(400, "invalid_event_id", "Invalid event ID");
    const denied = await eventAccess(user, env, eventId.data);
    if (denied) return denied;
    if (request.method === "GET" && !modsPath[2]) {
      const rows = await env.DB.prepare(
        "SELECT id,event_id AS eventId,title,description,artwork_url AS artworkUrl,external_url AS externalUrl,position,visibility,revealed_at AS revealedAt FROM event_mods WHERE event_id=? ORDER BY position",
      )
        .bind(eventId.data)
        .all();
      return json({ data: rows.results });
    }
    if (request.method === "POST" && !modsPath[2]) {
      const parsed = modInputSchema.safeParse(await readJson(request));
      if (!parsed.success) return validationError(parsed.error);
      const version = Number(request.headers.get("If-Match"));
      if (!Number.isInteger(version) || version < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const modId = id("mod");
      const position =
        parsed.data.position ??
        (
          await env.DB.prepare(
            "SELECT COALESCE(MAX(position),-1)+1 AS next FROM event_mods WHERE event_id=?",
          )
            .bind(eventId.data)
            .first<{ next: number }>()
        )?.next ??
        0;
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `INSERT INTO event_mods (id,event_id,identifier,title,description,artwork_url,external_url,position,visibility)
        SELECT ?,?,?,?,?,?,?,?,'hidden' WHERE EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(
          modId,
          eventId.data,
          modId,
          parsed.data.title,
          parsed.data.description,
          parsed.data.artworkUrl ?? null,
          parsed.data.externalUrl ?? null,
          position,
          eventId.data,
          mutationId,
        );
      const result = await mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        version,
        "created",
        "mod",
        modId,
        statement,
        { type: "event_sync" },
      );
      if (result.status !== 200) return result;
      return json(
        {
          data: {
            id: modId,
            eventId: eventId.data,
            identifier: modId,
            ...parsed.data,
            position,
            visibility: "hidden",
          },
        },
        201,
      );
    }
    const modId = modsPath[2];
    if (modId && request.method === "PATCH") {
      const input = modInputSchema.safeParse(await readJson(request));
      if (!input.success) return validationError(input.error);
      const version = Number(request.headers.get("If-Match"));
      if (!Number.isInteger(version) || version < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const existing = await env.DB.prepare(
        "SELECT position FROM event_mods WHERE event_id=? AND id=?",
      )
        .bind(eventId.data, modId)
        .first<{ position: number }>();
      if (!existing) return fail(404, "not_found", "Mod not found");
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `UPDATE event_mods SET title=?,description=?,artwork_url=?,external_url=?,position=?,updated_at=?
        WHERE id=? AND event_id=? AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(
          input.data.title,
          input.data.description,
          input.data.artworkUrl ?? null,
          input.data.externalUrl ?? null,
          input.data.position ?? existing.position,
          now(),
          modId,
          eventId.data,
          eventId.data,
          mutationId,
        );
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        version,
        "updated",
        "mod",
        modId,
        statement,
        { type: "event_sync" },
      );
    }
    if (modId && request.method === "DELETE") {
      const version = Number(request.headers.get("If-Match"));
      if (!Number.isInteger(version) || version < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const existing = await env.DB.prepare(
        "SELECT 1 FROM event_mods WHERE event_id=? AND id=?",
      )
        .bind(eventId.data, modId)
        .first();
      if (!existing) return fail(404, "not_found", "Mod not found");
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `DELETE FROM event_mods WHERE id=? AND event_id=? AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(modId, eventId.data, eventId.data, mutationId);
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        version,
        "deleted",
        "mod",
        modId,
        statement,
        { type: "event_sync" },
      );
    }
    if (modsPath[2] && modsPath[3] && request.method === "POST") {
      const modExists = await env.DB.prepare(
        "SELECT visibility FROM event_mods WHERE event_id=? AND id=?",
      )
        .bind(eventId.data, modsPath[2])
        .first<{ visibility: "hidden" | "revealed" }>();
      if (!modExists) return fail(404, "not_found", "Mod not found");
      const version = Number(request.headers.get("If-Match"));
      if (!Number.isInteger(version) || version < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const revealed = modsPath[3] === "reveal";
      const currentVersion = await env.DB.prepare(
        "SELECT version FROM event_state_versions WHERE event_id=?",
      )
        .bind(eventId.data)
        .first<{ version: number }>();
      if (!currentVersion) return fail(404, "not_found", "Event not found");
      if (version !== currentVersion.version)
        return fail(
          409,
          "version_conflict",
          "This event changed elsewhere. Refresh and retry.",
        );
      const nextVisibility = revealed ? "revealed" : "hidden";
      if (modExists.visibility === nextVisibility)
        return json({ data: { version: currentVersion.version } });
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `UPDATE event_mods SET visibility=?,revealed_at=?,updated_at=? WHERE id=? AND event_id=?
        AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(
          nextVisibility,
          revealed ? now() : null,
          now(),
          modsPath[2],
          eventId.data,
          eventId.data,
          mutationId,
        );
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        version,
        revealed ? "revealed" : "hidden",
        "mod",
        modsPath[2],
        statement,
        revealed
          ? { type: "mod_revealed", modId: modsPath[2] }
          : { type: "event_sync" },
      );
    }
    const reorder = path === `/events/${eventId.data}/mods/reorder`;
    if (reorder && request.method === "POST") {
      const payload = (await readJson(request)) as {
        ids?: unknown;
        version?: unknown;
      };
      if (
        !Array.isArray(payload.ids) ||
        payload.ids.some((value) => typeof value !== "string") ||
        new Set(payload.ids).size !== payload.ids.length
      )
        return fail(
          422,
          "validation_error",
          "Provide each mod ID once in the intended order",
        );
      const version = Number(
        request.headers.get("If-Match") ?? payload.version,
      );
      if (!Number.isInteger(version) || version < 1)
        return fail(
          428,
          "version_required",
          "Send the current event version in If-Match",
        );
      const rows = payload.ids as string[];
      const actual = await env.DB.prepare(
        "SELECT id FROM event_mods WHERE event_id=? ORDER BY position",
      )
        .bind(eventId.data)
        .all<{ id: string }>();
      if (
        rows.length !== actual.results.length ||
        rows.some((item) => !actual.results.some((row) => row.id === item))
      )
        return fail(
          422,
          "invalid_order",
          "The order must include every current mod exactly once",
        );
      const cases = rows.map(() => "WHEN ? THEN ?").join(" ");
      const binds = rows.flatMap((value, index) => [value, index]);
      const statement = (mutationId: string) =>
        env.DB.prepare(
          `UPDATE event_mods SET position=CASE id ${cases} ELSE position END,updated_at=? WHERE event_id=? AND id IN (${rows.map(() => "?").join(",")})
        AND EXISTS (SELECT 1 FROM event_state_versions WHERE event_id=? AND last_mutation_id=?)`,
        ).bind(
          ...binds,
          now(),
          eventId.data,
          ...rows,
          eventId.data,
          mutationId,
        );
      return mutateEvent(
        env,
        ctx,
        user,
        eventId.data,
        version,
        "reordered",
        "mod",
        null,
        statement,
        { type: "event_sync" },
      );
    }
  }

  if (path === "/activity" && request.method === "GET") {
    const page = pageParams(url);
    if (page.error) return page.error;
    const restriction =
      user.role === "owner"
        ? ""
        : "WHERE a.event_id IN (SELECT event_id FROM event_permissions WHERE user_id=?)";
    const bindings = user.role === "owner" ? [] : [user.id];
    const rows = await env.DB.prepare(
      `SELECT a.id,a.action,a.entity_type AS entityType,a.entity_id AS entityId,a.event_id AS eventId,a.details_json AS details,a.created_at AS createdAt,u.display_name AS actor FROM audit_logs a LEFT JOIN admin_users u ON u.id=a.actor_user_id ${restriction} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(...bindings, page.value.pageSize, page.value.offset)
      .all();
    return json({
      data: rows.results,
      meta: { page: page.value.page, pageSize: page.value.pageSize },
    });
  }
  if (path === "/users" && request.method === "GET") {
    if (user.role !== "owner")
      return fail(403, "forbidden", "Only owners can manage access");
    const rows = await env.DB.prepare(
      "SELECT id,email,display_name AS displayName,role,is_active AS active FROM admin_users ORDER BY email",
    ).all();
    const access = await env.DB.prepare(
      "SELECT user_id AS userId,event_id AS eventId,role FROM event_permissions ORDER BY event_id",
    ).all();
    return json({ data: { users: rows.results, permissions: access.results } });
  }
  if (path === "/users" && request.method === "POST") {
    if (user.role !== "owner")
      return fail(403, "forbidden", "Only owners can manage access");
    const parsed = adminGrantSchema.safeParse(await readJson(request));
    if (!parsed.success) return validationError(parsed.error);
    if (parsed.data.eventIds.length) {
      const placeholders = parsed.data.eventIds.map(() => "?").join(",");
      const existingEvents = await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM events WHERE id IN (${placeholders})`,
      )
        .bind(...parsed.data.eventIds)
        .first<{ total: number }>();
      if ((existingEvents?.total ?? 0) !== parsed.data.eventIds.length)
        return fail(
          422,
          "invalid_event_assignment",
          "One or more selected events no longer exist",
        );
    }
    const userId = id("user");
    const auditId = id("audit");
    const statements = [
      env.DB.prepare(
        "INSERT INTO admin_users (id,identity_subject,email,display_name,role) VALUES (?,?,?,?,'organizer') ON CONFLICT(identity_subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,role='organizer',is_active=1 WHERE admin_users.role='organizer'",
      ).bind(
        userId,
        parsed.data.email,
        parsed.data.email,
        parsed.data.displayName,
      ),
      env.DB.prepare(
        "DELETE FROM event_permissions WHERE user_id=(SELECT id FROM admin_users WHERE identity_subject=? AND role='organizer')",
      ).bind(parsed.data.email),
    ];
    for (const assignedEvent of parsed.data.eventIds)
      statements.push(
        env.DB.prepare(
          "INSERT INTO event_permissions (user_id,event_id,role,granted_by) SELECT id,?,'organizer',? FROM admin_users WHERE identity_subject=? AND role='organizer' ON CONFLICT(user_id,event_id) DO UPDATE SET role='organizer',granted_by=excluded.granted_by",
        ).bind(assignedEvent, user.id, parsed.data.email),
      );
    statements.push(
      env.DB.prepare(
        "INSERT INTO audit_logs (id,actor_user_id,event_id,action,entity_type,entity_id,details_json) SELECT ?,?,NULL,'access_granted','user',id,? FROM admin_users WHERE identity_subject=? AND role='organizer'",
      ).bind(
        auditId,
        user.id,
        JSON.stringify({ role: "organizer", eventIds: parsed.data.eventIds }),
        parsed.data.email,
      ),
    );
    const results = await env.DB.batch(statements);
    if (!results[0]?.meta.changes)
      return fail(
        409,
        "owner_protected",
        "An Owner cannot be demoted or managed as an Organizer",
      );
    const organizer = await env.DB.prepare(
      "SELECT id FROM admin_users WHERE identity_subject=? AND role='organizer'",
    )
      .bind(parsed.data.email)
      .first<{ id: string }>();
    if (!organizer)
      return fail(409, "access_conflict", "The Organizer could not be saved");
    return json(
      { data: { id: organizer.id, ...parsed.data, role: "organizer" } },
      201,
    );
  }
  const userPath = /^\/users\/([^/]+)$/.exec(path);
  if (userPath && request.method === "DELETE") {
    if (user.role !== "owner")
      return fail(403, "forbidden", "Only owners can manage access");
    if (userPath[1] === user.id)
      return fail(
        409,
        "self_revoke_blocked",
        "You cannot revoke your own access",
      );
    const target = await env.DB.prepare(
      "SELECT id,role FROM admin_users WHERE id=?",
    )
      .bind(userPath[1])
      .first<{ id: string; role: string }>();
    if (!target) return fail(404, "not_found", "Team member not found");
    if (target.role === "owner") {
      const owners = await env.DB.prepare(
        "SELECT COUNT(*) AS total FROM admin_users WHERE role='owner' AND is_active=1",
      ).first<{ total: number }>();
      if ((owners?.total ?? 0) <= 1)
        return fail(
          409,
          "last_owner_protected",
          "The last active Owner cannot be deleted or demoted",
        );
      return fail(
        409,
        "owner_revoke_blocked",
        "Owner access cannot be revoked here",
      );
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM event_permissions WHERE user_id=?").bind(
        target.id,
      ),
      env.DB.prepare(
        "UPDATE admin_users SET is_active=0,updated_at=? WHERE id=?",
      ).bind(now(), target.id),
      env.DB.prepare(
        "INSERT INTO audit_logs (id,actor_user_id,action,entity_type,entity_id,details_json) VALUES (?,?,'access_revoked','user',?,'{}')",
      ).bind(id("audit"), user.id, target.id),
    ]);
    return json({ data: { id: target.id, active: false } });
  }
  return null;
}

const worker = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const headers = corsHeaders(request, env);
    try {
      if (request.method === "OPTIONS")
        return new Response(null, { status: 204, headers });
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return json({ ok: true, service: "weekbox-events-api" }, 200, headers);
      const response =
        (await handleAdmin(request, env, url, ctx)) ??
        (await handlePublic(request, env, url));
      if (response) {
        for (const [key, value] of headers) response.headers.set(key, value);
        return response;
      }
      if (request.method === "GET" && url.pathname === "/admin")
        return Response.redirect(`${url.origin}/admin/`, 308);
      if (
        request.method === "GET" &&
        (url.pathname === "/admin/" || url.pathname.startsWith("/admin/"))
      ) {
        const user = await authenticate(request, env);
        if (!user)
          return fail(
            401,
            "unauthorized",
            "Sign in with your authorized WeekBox account",
          );
        const assetUrl = new URL(request.url);
        const assetPath = assetUrl.pathname.slice("/admin".length);
        assetUrl.pathname =
          assetPath === "" || assetPath === "/" ? "/index.html" : assetPath;
        return env.ASSETS.fetch(new Request(assetUrl, request));
      }
      return json(
        { error: { code: "not_found", message: "Not found" } },
        404,
        headers,
      );
    } catch (error) {
      if (error instanceof HttpError)
        return fail(error.status, error.code, error.message, error.details);
      console.error("request failed", error);
      return fail(500, "internal_error", "The request could not be completed");
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
