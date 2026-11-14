import { createRemoteJWKSet, jwtVerify } from "jose";

type RuntimeEnv = Omit<
  Env,
  | "ENVIRONMENT"
  | "DEV_AUTH"
  | "CF_ACCESS_TEAM_DOMAIN"
  | "CF_ACCESS_AUD"
  | "OWNER_EMAIL"
> & {
  ENVIRONMENT: string;
  DEV_AUTH: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
};

export type Role = "owner" | "organizer";
export interface AdminUser {
  id: string;
  identity_subject: string;
  email: string;
  display_name: string;
  role: Role;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(
  request: Request,
  env: RuntimeEnv,
): Promise<AdminUser | null> {
  let email: string | null = null;
  let identity: string | null = null;

  const hostname = new URL(request.url).hostname;
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1";
  if (
    env.ENVIRONMENT === "development" &&
    env.DEV_AUTH === "true" &&
    isLoopback
  ) {
    const localRole = request.headers.get("X-WeekBox-Dev-User");
    if (localRole === "owner" || localRole === "organizer") {
      email = `${localRole}@local.weekbox.test`;
      identity = email;
    }
  } else if (env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;
    const issuer = `https://${env.CF_ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
    let jwks = keySets.get(issuer);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
      keySets.set(issuer, jwks);
    }
    try {
      const verified = await jwtVerify(token, jwks, {
        issuer,
        audience: env.CF_ACCESS_AUD,
      });
      const claims = verified.payload;
      email =
        typeof claims.email === "string" ? claims.email.toLowerCase() : null;
      identity = email;
    } catch {
      return null;
    }
  }
  if (!email || !identity) return null;

  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  if (ownerEmail && email === ownerEmail) {
    const ownerDisplayName = "ImMalloy";
    await env.DB.prepare(
      `INSERT INTO admin_users (id, identity_subject, email, display_name, role)
      VALUES (?, ?, ?, ?, 'owner')
      ON CONFLICT(identity_subject) DO UPDATE SET email=excluded.email, display_name=excluded.display_name, role='owner', is_active=1`,
    )
      .bind(`user-${email}`, identity, email, ownerDisplayName)
      .run();
  }
  return env.DB.prepare(
    "SELECT id, identity_subject, email, display_name, role FROM admin_users WHERE identity_subject = ? AND is_active = 1",
  )
    .bind(identity)
    .first<AdminUser>();
}

export async function canAccessEvent(
  user: AdminUser,
  db: D1Database,
  eventId: string,
): Promise<boolean> {
  if (user.role === "owner") return true;
  const row = await db
    .prepare(
      "SELECT 1 AS allowed FROM event_permissions WHERE user_id = ? AND event_id = ?",
    )
    .bind(user.id, eventId)
    .first<{ allowed: number }>();
  return Boolean(row);
}
